const express = require("express");
const { Readable } = require("stream");
const bcrypt = require("bcrypt");

const Transfer = require("../models/Transfer");
const { getObjectFromR2, getObjectHeadFromR2 } = require("../services/fileManager");
const { rateLimitMetadata } = require("../middleware/rateLimiter");
const { validateCode } = require("../middleware/validateCode");
const { sanitizeFilename, getClientIp, getDeviceName } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logError } = require("../utils/logger");

const router = express.Router();

function isExpired(transfer) {
	return transfer.expiresAt && new Date(transfer.expiresAt).getTime() < Date.now();
}

const PREVIEWABLE_TEXT_MIMES = new Set([
	"text/plain", "text/html", "text/css", "text/csv",
	"text/javascript", "text/markdown", "text/xml",
	"application/json", "application/javascript",
	"application/xml", "application/x-yaml",
]);

function isPreviewableMime(mimeType) {
	const mime = String(mimeType || "").toLowerCase();
	if (mime.startsWith("image/")) return true;
	if (mime.includes("pdf")) return true;
	if (mime.startsWith("video/")) return true;
	if (mime.startsWith("text/")) return true;
	if (PREVIEWABLE_TEXT_MIMES.has(mime)) return true;
	return false;
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

router.get("/:code/preview/:fileIndex", rateLimitMetadata, validateCode, async (req, res, next) => {
	try {
		const { code, fileIndex } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer || transfer.isDeleted) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (transfer.burnAfterDownload && transfer.downloadCount >= 1) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}

		if (isExpired(transfer)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
		}

		const passwordError = await getPasswordErrorResponse(req, transfer);
		if (passwordError) {
			return res.status(passwordError.status).json(passwordError.body);
		}

		const idx = Number(fileIndex);
		if (!Number.isInteger(idx) || idx < 0 || idx >= transfer.files.length) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const file = transfer.files[idx];
		if (!isPreviewableMime(file.mimeType)) {
			return res
				.status(404)
				.json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND, "Preview not available for this file type"));
		}

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
		const contentType = objectResponse.ContentType || file.mimeType || "application/octet-stream";
		const filename = sanitizeFilename(file.originalName || "preview");

		res.setHeader("Content-Type", contentType);
		res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
		res.setHeader("Cache-Control", "public, max-age=300");
		res.setHeader("Accept-Ranges", "bytes");

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

		return null;
	} catch (error) {
		if (res.headersSent) {
			logError("Metadata preview stream error", error, `CODE: ${req.params?.code || ""}`, `FILE: ${req.params?.fileIndex || ""}`);
			return null;
		}
		return next(error);
	}
});

router.get("/:code", rateLimitMetadata, validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		// Check burn-before-isDeleted so we return ALREADY_DOWNLOADED (not CODE_NOT_FOUND)
		// even after finalizeBurnDownload has set isDeleted: true.
		if (transfer.burnAfterDownload && transfer.downloadCount >= 1) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}

		if (transfer.isDeleted) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (isExpired(transfer)) {
			// Expired transfers return metadata as read-only with status
			const expiredFiles = (transfer.files || []).map((file) => ({
				name: file.originalName,
				size: file.size,
				type: file.mimeType,
				icon: file.icon,
			}));
			return res.status(200).json({
				code: transfer.code,
				status: "EXPIRED",
				passwordProtected: Boolean(transfer.passwordProtected),
				files: expiredFiles,
				totalSize: transfer.totalSize,
				fileCount: transfer.fileCount,
				expiresAt: transfer.expiresAt,
				secondsRemaining: 0,
				burnAfterDownload: transfer.burnAfterDownload,
				senderDeviceName: transfer.senderDeviceName,
				ai: transfer.ai || null,
			});
		}

		const receiverDevice = getDeviceName(req.get("user-agent") || "");
		const receiverIp = getClientIp(req);
		const secondsRemaining = transfer.expiresAt
			? Math.max(0, Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000))
			: 0;

		await Transfer.updateOne(
			{ code },
			{
				$push: {
					activity: {
						event: "viewed",
						device: receiverDevice,
						ip: receiverIp,
						timestamp: new Date(),
					},
				},
			},
		);

		const transferStatus = (() => {
			if (transfer.isDeleted && transfer.cancelledAt) return "CANCELLED";
			if (transfer.isDeleted) return "DELETED";
			if (transfer.burnAfterDownload && Number(transfer.downloadCount || 0) >= 1) return "DELETED";
			return "ACTIVE";
		})();

		return res.status(200).json({
			code: transfer.code,
			status: transferStatus,
			passwordProtected: Boolean(transfer.passwordProtected),
			files: (transfer.files || []).map((file) => ({
				name: file.originalName,
				size: file.size,
				type: file.mimeType,
				icon: file.icon,
			})),
			totalSize: transfer.totalSize,
			fileCount: transfer.fileCount,
			expiresAt: transfer.expiresAt,
			secondsRemaining,
			burnAfterDownload: transfer.burnAfterDownload,
			senderDeviceName: transfer.senderDeviceName,
			ai: transfer.ai || null,
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

