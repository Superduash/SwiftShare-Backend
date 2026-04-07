const express = require("express");
const { Readable } = require("stream");

const Transfer = require("../models/Transfer");
const { getObjectFromR2 } = require("../services/fileManager");
const { rateLimitMetadata } = require("../middleware/rateLimiter");
const { validateCode } = require("../middleware/validateCode");
const { sanitizeFilename, getClientIp, getDeviceName } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

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

		const objectResponse = await getObjectFromR2(file.storedKey);
		const stream = await toReadable(objectResponse.Body);
		const contentType = objectResponse.ContentType || file.mimeType || "application/octet-stream";
		const filename = sanitizeFilename(file.originalName || "preview");

		res.setHeader("Content-Type", contentType);
		res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
		res.setHeader("Cache-Control", "public, max-age=300");
		res.setHeader("Accept-Ranges", "bytes");
		if (objectResponse.ContentLength != null) {
			res.setHeader("Content-Length", objectResponse.ContentLength);
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

