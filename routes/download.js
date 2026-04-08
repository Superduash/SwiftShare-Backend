const express = require("express");
const { Readable } = require("stream");
const bcrypt = require("bcrypt");
const mammoth = require("mammoth");

const Transfer = require("../models/Transfer");
const { getObjectFromR2, getObjectHeadFromR2, deleteFilesFromR2 } = require("../services/fileManager");
const { emitToRoom, clearTransferCountdown } = require("../config/socket");
const { streamZipFromR2 } = require("../services/zipService");
const { rateLimitDownload } = require("../middleware/rateLimiter");
const { validateCode } = require("../middleware/validateCode");
const {
	sanitizeFilename,
	getDeviceName,
	getClientIp,
	formatBytes,
	isTransferExpired,
} = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logEvent, logError } = require("../utils/logger");

const router = express.Router();

function sendUnavailableTransferResponse(res, transfer) {
	if (!transfer) {
		return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
	}

	if (isTransferExpired(transfer)) {
		return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
	}

	if (transfer.isDeleted || (transfer.burnAfterDownload && transfer.downloadCount >= 1)) {
		return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
	}

	return null;
}

function getProvidedPassword(req) {
	const headerPassword = req.get("x-transfer-password");
	if (typeof headerPassword === "string" && headerPassword.length > 0) {
		return headerPassword;
	}

	const queryPassword = req.query?.password;
	if (typeof queryPassword === "string" && queryPassword.length > 0) {
		return queryPassword;
	}

	return "";
}

async function getPasswordErrorResponse(req, transfer) {
	if (!transfer.passwordProtected) {
		return null;
	}

	if (Number(transfer.passwordAttempts || 0) >= 5) {
		return {
			status: 429,
			body: buildErrorResponse(ERROR_CODES.INVALID_PASSWORD, "Too many incorrect password attempts"),
		};
	}

	const providedPassword = getProvidedPassword(req);
	if (!providedPassword) {
		return {
			status: 401,
			body: buildErrorResponse(ERROR_CODES.PASSWORD_REQUIRED),
		};
	}

	const isValidPassword = Boolean(
		transfer.passwordHash && await bcrypt.compare(providedPassword, transfer.passwordHash),
	);

	if (!isValidPassword) {
		await Transfer.updateOne({ _id: transfer._id }, { $inc: { passwordAttempts: 1 } });
		return {
			status: 401,
			body: buildErrorResponse(ERROR_CODES.INVALID_PASSWORD),
		};
	}

	if (Number(transfer.passwordAttempts || 0) > 0) {
		await Transfer.updateOne({ _id: transfer._id }, { $set: { passwordAttempts: 0 } });
	}

	return null;
}

async function toReadable(body) {
	if (body && typeof body.pipe === "function") {
		return body;
	}

	if (body && typeof body.transformToByteArray === "function") {
		const bytes = await body.transformToByteArray();
		return Readable.from(Buffer.from(bytes));
	}

	throw new Error("Unable to read object stream");
}

async function toBuffer(body) {
	if (Buffer.isBuffer(body)) {
		return body;
	}

	if (body && typeof body.transformToByteArray === "function") {
		const bytes = await body.transformToByteArray();
		return Buffer.from(bytes);
	}

	const stream = await toReadable(body);
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks);
}

function sanitizeDocxHtml(htmlValue) {
	return String(htmlValue || "")
		.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
		.replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
		.replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, "")
		.replace(/ on[a-z]+\s*=\s*'[^']*'/gi, "")
		.replace(/\s(href|src)\s*=\s*"javascript:[^"]*"/gi, " $1=\"#\"")
		.replace(/\s(href|src)\s*=\s*'javascript:[^']*'/gi, " $1='#'");
}

function renderDocxPreviewDocument(fileName, bodyHtml) {
	const title = sanitizeFilename(fileName || "Document");
	const safeBody = String(bodyHtml || "").trim() || "<p>No preview content was extracted from this document.</p>";

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 16px; font-family: Arial, sans-serif; color: #111827; background: #ffffff; line-height: 1.5; }
    img, table { max-width: 100%; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
${safeBody}
</body>
</html>`;
}

function isDocxFile(file) {
	const mime = String(file?.mimeType || "").toLowerCase();
	const name = String(file?.originalName || "").toLowerCase();
	return mime.includes("wordprocessingml") || name.endsWith(".docx");
}

const PREVIEW_EXTENSION_MIME_MAP = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	ogg: "audio/ogg",
	opus: "audio/opus",
	flac: "audio/flac",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/x-m4v",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
};

function isGenericBinaryMimeType(mimeType) {
	const normalized = String(mimeType || "")
		.trim()
		.toLowerCase()
		.split(";")[0]
		.trim();

	return !normalized
		|| normalized === "application/octet-stream"
		|| normalized === "binary/octet-stream";
}

function resolvePreviewContentType(file, r2ContentType) {
	if (!isGenericBinaryMimeType(r2ContentType)) {
		return String(r2ContentType).trim();
	}

	if (!isGenericBinaryMimeType(file?.mimeType)) {
		return String(file.mimeType).trim();
	}

	const originalName = String(file?.originalName || "").trim().toLowerCase();
	const extensionMatch = /\.([a-z0-9]+)$/.exec(originalName);
	if (extensionMatch) {
		const inferredType = PREVIEW_EXTENSION_MIME_MAP[extensionMatch[1]];
		if (inferredType) {
			return inferredType;
		}
	}

	return "application/octet-stream";
}

function parseRangeHeader(rangeHeader, totalBytes) {
	const rawRange = typeof rangeHeader === "string" ? rangeHeader.trim() : "";
	if (!rawRange) {
		return { ok: true, value: null };
	}

	if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
		return { ok: false, error: "Range requests are not supported for this file" };
	}

	const match = /^bytes=(\d*)-(\d*)$/i.exec(rawRange);
	if (!match) {
		return { ok: false, error: "Invalid range format" };
	}

	const startRaw = match[1];
	const endRaw = match[2];

	let start;
	let end;

	if (!startRaw && !endRaw) {
		return { ok: false, error: "Invalid range bounds" };
	}

	if (!startRaw) {
		const suffixLength = Number(endRaw);
		if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
			return { ok: false, error: "Invalid suffix range" };
		}

		const actualLength = Math.min(suffixLength, totalBytes);
		start = totalBytes - actualLength;
		end = totalBytes - 1;
	} else {
		start = Number(startRaw);
		end = endRaw ? Number(endRaw) : totalBytes - 1;

		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) {
			return { ok: false, error: "Range must contain non-negative integers" };
		}
	}

	if (start >= totalBytes || end < start) {
		return { ok: false, error: "Range is outside file bounds" };
	}

	const clampedEnd = Math.min(end, totalBytes - 1);
	const length = (clampedEnd - start) + 1;

	return {
		ok: true,
		value: {
			start,
			end: clampedEnd,
			length,
			r2Range: `bytes=${start}-${clampedEnd}`,
		},
	};
}

async function streamSingleFile(res, file, code) {
	const objectResponse = await getObjectFromR2(file.storedKey);

	const stream = await toReadable(objectResponse.Body);
	const downloadName = sanitizeFilename(file.originalName || "download");
	const totalBytes = Number(objectResponse.ContentLength || file.size || 0);
	let processedBytes = 0;

	res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
	res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);

	if (objectResponse.ContentLength != null) {
		res.setHeader("Content-Length", objectResponse.ContentLength);
	}

	stream.on("data", (chunk) => {
		if (totalBytes <= 0) {
			return;
		}

		processedBytes += chunk.length;
		const percent = Math.min(100, Math.round((processedBytes / totalBytes) * 100));
		emitToRoom(code, "download-progress", { percent });
	});

	await new Promise((resolve, reject) => {
		stream.on("error", reject);
		res.on("finish", resolve);
		res.on("error", reject);
		stream.pipe(res);
	});

	return processedBytes || totalBytes;
}

async function streamZip(res, code, files) {
	const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
	let processedBytes = 0;

	await streamZipFromR2({
		code,
		files,
		res,
		onChunk: (chunkLength) => {
			if (totalBytes <= 0) {
				return;
			}

			processedBytes += chunkLength;
			const percent = Math.min(100, Math.round((processedBytes / totalBytes) * 100));
			emitToRoom(code, "download-progress", { percent });
		},
	});

	return totalBytes;
}

async function claimBurnDownload(transferId) {
	return Transfer.findOneAndUpdate(
		{
			_id: transferId,
			isDeleted: false,
			burnAfterDownload: true,
			downloadCount: 0,
		},
		{ $inc: { downloadCount: 1 } },
		{ new: true },
	);
}

async function finalizeDownload(transfer, {
	isBurnFlow,
	downloadDuration,
	downloadSpeed,
	receiverDevice,
	receiverIp,
}) {
	if (isBurnFlow) {
		await deleteFilesFromR2(transfer.files);
		await Transfer.updateOne(
			{ _id: transfer._id },
			{
				$set: {
					isDeleted: true,
					downloadDuration,
					downloadSpeed,
				},
				$push: {
					activity: {
						$each: [
							{
								event: "downloaded",
								device: receiverDevice,
								ip: receiverIp,
								timestamp: new Date(),
							},
							{
								event: "burned",
								device: "System",
								ip: "",
								timestamp: new Date(),
							},
						],
					},
				},
			},
		);
		clearTransferCountdown(transfer.code);
		emitToRoom(transfer.code, "transfer-deleted", { code: transfer.code, status: "DELETED", reason: "burn" });
		return;
	}

	await Transfer.updateOne(
		{ _id: transfer._id },
		{
			$inc: { downloadCount: 1 },
			$set: {
				downloadDuration,
				downloadSpeed,
			},
			$push: {
				activity: {
					event: "downloaded",
					device: receiverDevice,
					ip: receiverIp,
					timestamp: new Date(),
				},
			},
		},
	);
}

function buildTransferReceipt({
	code,
	fileName,
	fileSizeBytes,
	sender,
	receiver,
	downloadDuration,
	downloadSpeed,
}) {
	const durationSeconds = Math.max(downloadDuration / 1000, 0);

	return {
		transferId: code,
		fileName,
		fileSize: formatBytes(fileSizeBytes),
		sender,
		receiver,
		duration: `${durationSeconds.toFixed(1)}s`,
		speed: `${formatBytes(downloadSpeed)}/s`,
		timestamp: new Date().toISOString(),
	};
}

router.get("/:code", rateLimitDownload, validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		let transfer = await Transfer.findOne({ code });
		const receiverDevice = getDeviceName(req.get("user-agent") || "");
		const receiverIp = getClientIp(req);

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		const passwordError = await getPasswordErrorResponse(req, transfer);
		if (passwordError) {
			return res.status(passwordError.status).json(passwordError.body);
		}

		emitToRoom(code, "download-started", { receiverDevice });
		logEvent("Download started", `CODE: ${code}`, `DEVICE: ${receiverDevice}`);

		let isBurnFlow = false;
		if (transfer.burnAfterDownload) {
			const claimedTransfer = await claimBurnDownload(transfer._id);
			if (!claimedTransfer) {
				return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
			}
			transfer = claimedTransfer;
			isBurnFlow = true;
		}

		if (!transfer.files || transfer.files.length === 0) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const streamStart = Date.now();
		let streamedBytes = 0;
		let receiptFileName = `swiftshare-${code}.zip`;

		if (transfer.files.length === 1) {
			receiptFileName = transfer.files[0].originalName || receiptFileName;
			streamedBytes = await streamSingleFile(res, {
				...transfer.files[0].toObject(),
			}, code);
		} else {
			streamedBytes = await streamZip(res, transfer.code, transfer.files);
		}

		const downloadDuration = Math.max(Date.now() - streamStart, 1);
		const downloadSpeed = Math.round(streamedBytes / (downloadDuration / 1000));

		await finalizeDownload(transfer, {
			isBurnFlow,
			downloadDuration,
			downloadSpeed,
			receiverDevice,
			receiverIp,
		});

		const receipt = buildTransferReceipt({
			code,
			fileName: receiptFileName,
			fileSizeBytes: streamedBytes,
			sender: transfer.senderDeviceName || "Unknown Device",
			receiver: receiverDevice,
			downloadDuration,
			downloadSpeed,
		});

		emitToRoom(code, "download-complete", { receiverDevice });
		emitToRoom(code, "transfer-receipt", receipt);
		logEvent("Download completed", `CODE: ${code}`, `DEVICE: ${receiverDevice}`);
		return null;
	} catch (error) {
		if (res.headersSent) {
			logError("Download post-stream error", error, `CODE: ${req.params?.code || ""}`);
			return null;
		}
		return next(error);
	}
});

router.get("/:code/single/:index", rateLimitDownload, validateCode, async (req, res, next) => {
	try {
		const { code, index } = req.params;
		let transfer = await Transfer.findOne({ code });
		const receiverDevice = getDeviceName(req.get("user-agent") || "");
		const receiverIp = getClientIp(req);

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		const passwordError = await getPasswordErrorResponse(req, transfer);
		if (passwordError) {
			return res.status(passwordError.status).json(passwordError.body);
		}

		emitToRoom(code, "download-started", { receiverDevice });
		logEvent("Download started", `CODE: ${code}`, `DEVICE: ${receiverDevice}`, "MODE: single");

		let isBurnFlow = false;
		if (transfer.burnAfterDownload) {
			const claimedTransfer = await claimBurnDownload(transfer._id);
			if (!claimedTransfer) {
				return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
			}
			transfer = claimedTransfer;
			isBurnFlow = true;
		}

		const fileIndex = Number(index);
		if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= transfer.files.length) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const selectedFile = transfer.files[fileIndex];
		const streamStart = Date.now();
		const streamedBytes = await streamSingleFile(res, {
			...transfer.files[fileIndex].toObject(),
		}, code);
		const downloadDuration = Math.max(Date.now() - streamStart, 1);
		const downloadSpeed = Math.round(streamedBytes / (downloadDuration / 1000));

		await finalizeDownload(transfer, {
			isBurnFlow,
			downloadDuration,
			downloadSpeed,
			receiverDevice,
			receiverIp,
		});

		const receipt = buildTransferReceipt({
			code,
			fileName: selectedFile.originalName || "download",
			fileSizeBytes: streamedBytes,
			sender: transfer.senderDeviceName || "Unknown Device",
			receiver: receiverDevice,
			downloadDuration,
			downloadSpeed,
		});

		emitToRoom(code, "download-complete", { receiverDevice });
		emitToRoom(code, "transfer-receipt", receipt);
		logEvent("Download completed", `CODE: ${code}`, `DEVICE: ${receiverDevice}`, "MODE: single");
		return null;
	} catch (error) {
		if (res.headersSent) {
			logError("Single download post-stream error", error, `CODE: ${req.params?.code || ""}`);
			return null;
		}
		return next(error);
	}
});

router.get("/:code/preview/:index", validateCode, async (req, res, next) => {
	try {
		const { code, index } = req.params;
		const transfer = await Transfer.findOne({ code });

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		const passwordError = await getPasswordErrorResponse(req, transfer);
		if (passwordError) {
			return res.status(passwordError.status).json(passwordError.body);
		}

		const fileIndex = Number(index);
		if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= transfer.files.length) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const file = transfer.files[fileIndex];
		const objectHead = await getObjectHeadFromR2(file.storedKey);
		const totalBytes = Number(objectHead.ContentLength || file.size || 0);
		const parsedRange = parseRangeHeader(req.headers.range, totalBytes);

		if (!parsedRange.ok) {
			if (totalBytes > 0) {
				res.setHeader("Content-Range", `bytes */${totalBytes}`);
			}

			return res
				.status(416)
				.json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, parsedRange.error));
		}

		const objectResponse = await getObjectFromR2(
			file.storedKey,
			parsedRange.value ? { range: parsedRange.value.r2Range } : {},
		);
		const stream = await toReadable(objectResponse.Body);

		const contentType = resolvePreviewContentType(file, objectResponse.ContentType);
		const normalizedContentType = String(contentType).toLowerCase().split(";")[0].trim();
		const isMediaContentType = normalizedContentType.startsWith("audio/") || normalizedContentType.startsWith("video/");

		res.setHeader("Content-Type", contentType);
		res.setHeader("Content-Disposition", `inline; filename="${sanitizeFilename(file.originalName || "preview")}"`);
		res.setHeader("Cache-Control", isMediaContentType ? "private, max-age=300, no-transform" : "private, max-age=300");
		if (isMediaContentType) {
			res.removeHeader("X-Content-Type-Options");
		}
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

		if (parsedRange.value) {
			res.status(206);
			res.setHeader("Content-Range", `bytes ${parsedRange.value.start}-${parsedRange.value.end}/${totalBytes}`);
			res.setHeader("Content-Length", String(parsedRange.value.length));
		} else {
			const fullLength = Number(objectResponse.ContentLength || totalBytes || 0);
			if (fullLength > 0) {
				res.setHeader("Content-Length", String(fullLength));
			}
		}

		await new Promise((resolve, reject) => {
			stream.on("error", reject);
			res.on("finish", resolve);
			res.on("error", reject);
			stream.pipe(res);
		});

		logEvent("Preview served", `CODE: ${code}`, `FILE: ${fileIndex}`);
		return null;
	} catch (error) {
		if (res.headersSent) {
			logError("Preview stream error", error, `CODE: ${req.params?.code || ""}`, `FILE: ${req.params?.index || ""}`);
			return null;
		}
		return next(error);
	}
});

router.get("/:code/preview/:index/docx-html", validateCode, async (req, res, next) => {
	try {
		const { code, index } = req.params;
		const transfer = await Transfer.findOne({ code });

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		const passwordError = await getPasswordErrorResponse(req, transfer);
		if (passwordError) {
			return res.status(passwordError.status).json(passwordError.body);
		}

		const fileIndex = Number(index);
		if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= transfer.files.length) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const file = transfer.files[fileIndex];
		if (!isDocxFile(file)) {
			return res.status(415).json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE, "DOCX preview is only available for .docx files"));
		}

		const objectResponse = await getObjectFromR2(file.storedKey);
		const buffer = await toBuffer(objectResponse.Body);
		const converted = await mammoth.convertToHtml({ buffer });
		const sanitizedHtml = sanitizeDocxHtml(converted?.value || "");

		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.setHeader("Content-Disposition", `inline; filename="${sanitizeFilename(file.originalName || "preview")}.html"`);
		res.setHeader("Cache-Control", "private, max-age=120");
		res.send(renderDocxPreviewDocument(file.originalName, sanitizedHtml));

		logEvent("DOCX preview served", `CODE: ${code}`, `FILE: ${fileIndex}`);
		return null;
	} catch (error) {
		if (res.headersSent) {
			logError("DOCX preview stream error", error, `CODE: ${req.params?.code || ""}`, `FILE: ${req.params?.index || ""}`);
			return null;
		}
		return next(error);
	}
});

module.exports = router;

