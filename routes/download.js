const express = require("express");
const { Readable } = require("stream");
const bcrypt = require("bcryptjs");
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
	getRequestFingerprint,
	isBurnClaimOwner,
	formatBytes,
	isTransferExpired,
} = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logEvent, logError } = require("../utils/logger");

const router = express.Router();

function sendUnavailableTransferResponse(req, res, transfer) {
	if (!transfer) {
		return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
	}

	if (isTransferExpired(transfer)) {
		return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
	}

	if (transfer.isDeleted) {
		return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
	}

	const senderIp = String(transfer?.senderIp || "").trim();
	const isSenderRequest = senderIp && senderIp === getClientIp(req);

	if (transfer.burnAfterDownload && transfer.burnClaimOwner && !isSenderRequest && !isBurnClaimOwner(transfer, req)) {
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
		// Strip dangerous element blocks (open + content + close, and self-closing)
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style>/gi, "")
		.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
		.replace(/<object\b[\s\S]*?<\/object>/gi, "")
		.replace(/<embed\b[^>]*\/?>/gi, "")
		.replace(/<form\b[\s\S]*?<\/form>/gi, "")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
		.replace(/<link\b[^>]*>/gi, "")
		.replace(/<meta\b[^>]*>/gi, "")
		// Strip event handlers (unquoted, single, double quoted)
		.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
		.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
		.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "")
		// Neutralize javascript:, data:, vbscript: URIs in href/src
		.replace(/\s(href|src)\s*=\s*"\s*(?:javascript|data|vbscript):[^"]*"/gi, ' $1="#"')
		.replace(/\s(href|src)\s*=\s*'\s*(?:javascript|data|vbscript):[^']*'/gi, " $1='#'");
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
	// Documents
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	// Audio
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	flac: "audio/flac",
	wma: "audio/x-ms-wma",
	aiff: "audio/aiff",
	aif: "audio/aiff",
	// Video
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/mp4",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	ogv: "video/ogg",
	"3gp": "video/3gpp",
	"3g2": "video/3gpp2",
	mts: "video/mp2t",
	// Images
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
	heic: "image/heic",
	heif: "image/heif",
	ico: "image/x-icon",
	tiff: "image/tiff",
	tif: "image/tiff",
	// Text / Code
	txt: "text/plain",
	md: "text/markdown",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	csv: "text/csv",
	js: "text/javascript",
	jsx: "text/javascript",
	ts: "text/plain",
	tsx: "text/plain",
	json: "application/json",
	xml: "text/xml",
	yaml: "text/plain",
	yml: "text/plain",
	sh: "text/plain",
	py: "text/plain",
	go: "text/plain",
	rs: "text/plain",
	java: "text/plain",
	cpp: "text/plain",
	c: "text/plain",
	h: "text/plain",
	rb: "text/plain",
	php: "text/plain",
	sql: "text/plain",
	log: "text/plain",
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

function getPreviewFrameAncestors(req) {
	if (String(process.env.CORS_ALLOW_ALL_ORIGINS || "").toLowerCase() === "true") {
		return "*";
	}

	const configuredRaw = `${String(process.env.FRONTEND_URL || "")},${String(process.env.CORS_EXTRA_ORIGINS || "")}`;
	const configured = configuredRaw
		.split(",")
		.map((origin) => String(origin || "").trim())
		.filter(Boolean)
		.map((origin) => (/^[a-z]+:\/\//i.test(origin) ? origin : `https://${origin}`))
		.map((origin) => origin.replace(/\/+$/, ""));

	const requestOrigin = String(req.get("origin") || "").trim().replace(/\/+$/, "");
	if (requestOrigin) {
		configured.push(requestOrigin);
	}

	configured.push("http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000");

	const uniqueAncestors = Array.from(new Set(configured));
	if (uniqueAncestors.length === 0) {
		return "'self'";
	}

	return `"'self' ${uniqueAncestors.join(" ")}"`.replace(/^"|"$/g, "");
}

function applyPreviewEmbedHeaders(req, res) {
	res.removeHeader("X-Frame-Options");
	res.setHeader("X-Frame-Options", "ALLOWALL");
	res.setHeader("Content-Security-Policy", `frame-ancestors ${getPreviewFrameAncestors(req)};`);
	res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
	// Allow cross-origin requests from any origin (needed for <audio>/<video> crossOrigin="anonymous")
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Range, x-transfer-password");
	res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
}

function isPowerPointFile(file) {
	const name = String(file?.originalName || "").toLowerCase();
	const mime = String(file?.mimeType || "").toLowerCase();
	return name.endsWith(".ppt") || name.endsWith(".pptx") || mime.includes("presentation");
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

// Throttle download-progress emits identically to upload — see upload.js rationale.
const DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS = 200;

async function streamSingleFile(res, file, code) {
	const objectResponse = await getObjectFromR2(file.storedKey);

	const stream = await toReadable(objectResponse.Body);
	const downloadName = sanitizeFilename(file.originalName || "download");
	const totalBytes = Number(objectResponse.ContentLength || file.size || 0);
	let processedBytes = 0;
	let lastEmitAt = 0;
	let lastEmittedPercent = -1;
	let streamStartTime = Date.now();
	let lastSpeedCalcAt = streamStartTime;
	let lastSpeedCalcBytes = 0;

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
		const now = Date.now();
		
		// Calculate real-time speed (bytes per second)
		let speed = 0;
		const speedDt = (now - lastSpeedCalcAt) / 1000;
		if (speedDt >= 0.5) { // Calculate speed every 500ms
			const bytesDiff = processedBytes - lastSpeedCalcBytes;
			speed = Math.round(bytesDiff / speedDt);
			lastSpeedCalcAt = now;
			lastSpeedCalcBytes = processedBytes;
		}
		
		if (
			percent !== lastEmittedPercent
			&& (now - lastEmitAt >= DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS || percent === 100)
		) {
			lastEmitAt = now;
			lastEmittedPercent = percent;
			emitToRoom(code, "download-progress", { 
				percent,
				speed,
				loaded: processedBytes,
				total: totalBytes
			});
		}
	});

	// If the client disconnects mid-download, destroy the upstream R2 stream so we
	// don't leak the TCP connection to Cloudflare. Without this the socket would
	// stay open until the OS-level idle timeout — minutes of wasted resources per
	// abandoned download on Render's tight pool.
	const onClientClose = () => {
		try { stream.destroy(); } catch { /* already destroyed */ }
	};
	res.on("close", onClientClose);

	try {
		await new Promise((resolve, reject) => {
			stream.on("error", reject);
			res.on("finish", resolve);
			res.on("error", reject);
			stream.pipe(res);
		});
	} finally {
		res.removeListener("close", onClientClose);
	}

	return processedBytes || totalBytes;
}

async function streamZip(res, code, files) {
	const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
	let processedBytes = 0;
	let lastEmitAt = 0;
	let lastEmittedPercent = -1;
	let streamStartTime = Date.now();
	let lastSpeedCalcAt = streamStartTime;
	let lastSpeedCalcBytes = 0;

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
			const now = Date.now();
			
			// Calculate real-time speed (bytes per second)
			let speed = 0;
			const speedDt = (now - lastSpeedCalcAt) / 1000;
			if (speedDt >= 0.5) { // Calculate speed every 500ms
				const bytesDiff = processedBytes - lastSpeedCalcBytes;
				speed = Math.round(bytesDiff / speedDt);
				lastSpeedCalcAt = now;
				lastSpeedCalcBytes = processedBytes;
			}
			
			if (
				percent !== lastEmittedPercent
				&& (now - lastEmitAt >= DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS || percent === 100)
			) {
				lastEmitAt = now;
				lastEmittedPercent = percent;
				emitToRoom(code, "download-progress", { 
					percent,
					speed,
					loaded: processedBytes,
					total: totalBytes
				});
			}
		},
	});

	return totalBytes;
}

async function claimBurnDownload(transfer, req) {
	const requesterFingerprint = getRequestFingerprint(req);
	const now = new Date();

	if (transfer?.burnClaimOwner === requesterFingerprint) {
		const ownedTransfer = await Transfer.findOneAndUpdate(
			{
				_id: transfer._id,
				isDeleted: false,
				burnAfterDownload: true,
				burnClaimOwner: requesterFingerprint,
			},
			{ $set: { burnLastActiveAt: now } },
			{ new: true },
		);

		return { transfer: ownedTransfer, claimedNow: false };
	}

	if (transfer?.burnClaimOwner && transfer.burnClaimOwner !== requesterFingerprint) {
		return { transfer: null, claimedNow: false };
	}

	const claimedTransfer = await Transfer.findOneAndUpdate(
		{
			_id: transfer._id,
			isDeleted: false,
			burnAfterDownload: true,
			$or: [
				{ burnClaimOwner: { $exists: false } },
				{ burnClaimOwner: null },
				{ burnClaimOwner: "" },
			],
		},
		{
			$set: {
				burnClaimOwner: requesterFingerprint,
				burnClaimedAt: now,
				burnLastActiveAt: now,
			},
		},
		{ new: true },
	);

	if (claimedTransfer) {
		return { transfer: claimedTransfer, claimedNow: true };
	}

	const ownerTransfer = await Transfer.findOneAndUpdate(
		{
			_id: transfer._id,
			isDeleted: false,
			burnAfterDownload: true,
			burnClaimOwner: requesterFingerprint,
		},
		{ $set: { burnLastActiveAt: now } },
		{ new: true },
	);

	return { transfer: ownerTransfer, claimedNow: false };
}

async function finalizeDownload(transfer, {
	isBurnFlow,
	claimedNow,
	downloadDuration,
	downloadSpeed,
	receiverDevice,
	receiverIp,
}) {
	if (isBurnFlow) {
		await Transfer.updateOne(
			{ _id: transfer._id },
			{
				$inc: { downloadCount: 1 },
				$set: {
					downloadDuration,
					downloadSpeed,
					burnLastActiveAt: new Date(),
				},
				$push: {
					activity: claimedNow
						? {
							$each: [
								{
									event: "burn_claimed",
									device: receiverDevice,
									ip: receiverIp,
									timestamp: new Date(),
								},
								{
									event: "downloaded",
									device: receiverDevice,
									ip: receiverIp,
									timestamp: new Date(),
								},
							],
						}
						: {
							event: "downloaded",
							device: receiverDevice,
							ip: receiverIp,
							timestamp: new Date(),
						},
				},
			},
		);

		if (claimedNow) {
			emitToRoom(transfer.code, "transfer-claimed", { code: transfer.code, status: "CLAIMED" });
		}
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

		const unavailableResponse = sendUnavailableTransferResponse(req, res, transfer);
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
		let claimedNow = false;
		if (transfer.burnAfterDownload) {
			const burnClaim = await claimBurnDownload(transfer, req);
			if (!burnClaim?.transfer) {
				return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
			}
			transfer = burnClaim.transfer;
			claimedNow = Boolean(burnClaim.claimedNow);
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
			claimedNow,
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

		const unavailableResponse = sendUnavailableTransferResponse(req, res, transfer);
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
		let claimedNow = false;
		if (transfer.burnAfterDownload) {
			const burnClaim = await claimBurnDownload(transfer, req);
			if (!burnClaim?.transfer) {
				return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
			}
			transfer = burnClaim.transfer;
			claimedNow = Boolean(burnClaim.claimedNow);
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
			claimedNow,
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

		const unavailableResponse = sendUnavailableTransferResponse(req, res, transfer);
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
		const isPowerPoint = isPowerPointFile(file);
		const dispositionType = isPowerPoint ? "attachment" : "inline";

		applyPreviewEmbedHeaders(req, res);
		res.setHeader("Content-Type", contentType);
		res.setHeader("Content-Disposition", `${dispositionType}; filename="${sanitizeFilename(file.originalName || "preview")}"`);
		res.setHeader("Accept-Ranges", "bytes");
		if (isMediaContentType) {
			// Media must NOT have X-Content-Type-Options: nosniff — some browsers
			// refuse to play audio/video if the MIME is flagged as unsniffable.
			res.removeHeader("X-Content-Type-Options");
			// Cache for 5 min; allow range seeks to re-use the cached response.
			res.setHeader("Cache-Control", "private, max-age=300, no-transform");
			// Allow timing info for media seeking progress bars.
			res.setHeader("Timing-Allow-Origin", "*");
		} else {
			res.setHeader("Cache-Control", "private, max-age=300");
		}

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

		const onPreviewClose = () => {
			try { stream.destroy(); } catch { /* already destroyed */ }
		};
		res.on("close", onPreviewClose);

		try {
			await new Promise((resolve, reject) => {
				stream.on("error", reject);
				res.on("finish", resolve);
				res.on("error", reject);
				stream.pipe(res);
			});
		} finally {
			res.removeListener("close", onPreviewClose);
		}

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

		const unavailableResponse = sendUnavailableTransferResponse(req, res, transfer);
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

		applyPreviewEmbedHeaders(req, res);
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

