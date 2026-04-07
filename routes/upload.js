const express = require("express");
const multer = require("multer");

const Transfer = require("../models/Transfer");
const { uploadBufferToR2 } = require("../services/fileManager");
const {
	emitToRoom,
	scheduleTransferCountdown,
	bindSocketToRoom,
} = require("../config/socket");
const { generateUniqueCode } = require("../services/codeGenerator");
const { generateQR } = require("../services/qrGenerator");
const { analyzeFile } = require("../services/aiAnalyzer");
const { rateLimitUpload } = require("../middleware/rateLimiter");
const { validateUpload } = require("../middleware/validateUpload");
const {
	getClientIp,
	getDeviceName,
	mimeToIcon,
	sanitizeFilename,
	getTotalSize,
	isBlockedExtension,
	hasDangerousSignature,
} = require("../utils/helpers");
const { logEvent, logError, formatSizeMB } = require("../utils/logger");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

const router = express.Router();

function getMaxFileCount() {
	const maxCount = Number(process.env.MAX_FILE_COUNT);
	return Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 10;
}

function getMaxFileSizeBytes() {
	const maxSizeMb = Number(process.env.MAX_FILE_SIZE_MB);
	const safeMb = Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : 500;
	return safeMb * 1024 * 1024;
}

function getSessionExpiryMinutes() {
	const expiryMinutes = Number(process.env.SESSION_EXPIRY_MINUTES);
	return Number.isFinite(expiryMinutes) && expiryMinutes > 0
		? expiryMinutes
		: 10;
}

function parseBurnAfterDownload(value) {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		return value.toLowerCase() === "true";
	}

	return false;
}

function createAppError(status, errorCode, message) {
	const error = new Error(message);
	error.status = status;
	error.errorCode = errorCode;
	return error;
}

function validateIncomingFiles(files) {
	if (!Array.isArray(files) || files.length === 0) {
		throw createAppError(400, ERROR_CODES.NO_FILE_UPLOADED, "No file uploaded");
	}

	if (files.length > getMaxFileCount()) {
		throw createAppError(400, ERROR_CODES.TOO_MANY_FILES, "Too many files");
	}

	const totalSize = getTotalSize(files);
	if (totalSize > getMaxFileSizeBytes()) {
		throw createAppError(400, ERROR_CODES.FILE_TOO_LARGE, "File exceeds size limit");
	}

	const hasBlockedExt = files.some((file) => isBlockedExtension(file.originalname));

	if (hasBlockedExt) {
		throw createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, "Invalid file type");
	}

	const hasDangerousFileSignature = files.some((file) => hasDangerousSignature(file.buffer));
	if (hasDangerousFileSignature) {
		throw createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, "Executable file signatures are not allowed");
	}
}

async function processUploadFlow({ req, incomingFiles, burnAfterDownload, senderSocketId }) {
	const shareBaseUrl = process.env.SHARE_BASE_URL;
	if (!shareBaseUrl) {
		throw createAppError(500, ERROR_CODES.SERVER_ERROR, "SHARE_BASE_URL is not set in environment variables");
	}

	validateIncomingFiles(incomingFiles);

	const code = await generateUniqueCode();
	const uploadedFiles = [];

	if (senderSocketId) {
		bindSocketToRoom(code, senderSocketId);
	}

	const totalSize = getTotalSize(incomingFiles);
	let uploadedSize = 0;
	const uploadStartedAt = Date.now();
	const senderIp = getClientIp(req);
	const senderDevice = getDeviceName(req.get("user-agent") || "");
	logEvent("Upload started", `CODE: ${code}`, `FILES: ${incomingFiles.length}`, formatSizeMB(totalSize));

	for (const file of incomingFiles) {
		const safeName = sanitizeFilename(file.originalname);
		const storedKey = `transfers/${code}/${safeName}`;
		const mimeType = file.mimetype || "application/octet-stream";

		await uploadBufferToR2({
			key: storedKey,
			body: file.buffer,
			contentType: mimeType,
		});

		uploadedFiles.push({
			originalName: file.originalname,
			storedKey,
			size: file.size,
			mimeType,
			icon: mimeToIcon(mimeType),
		});

		uploadedSize += file.size;
		const elapsedSeconds = Math.max((Date.now() - uploadStartedAt) / 1000, 0.001);
		const denominator = Math.max(totalSize, 1);
		const percent = Math.min(100, Math.round((uploadedSize / denominator) * 100));
		const speed = Number(((uploadedSize / (1024 * 1024)) / elapsedSeconds).toFixed(2));

		emitToRoom(code, "upload-progress", {
			percent,
			speed,
			elapsed: Number(elapsedSeconds.toFixed(2)),
		});
	}

	const fileCount = incomingFiles.length;
	const expiresAt = new Date(
		Date.now() + getSessionExpiryMinutes() * 60 * 1000,
	);
	const uploadDurationMs = Math.max(Date.now() - uploadStartedAt, 1);
	const uploadSpeed = Math.round(totalSize / (uploadDurationMs / 1000));
	const qr = await generateQR(code);

	await Transfer.create({
		code,
		files: uploadedFiles,
		totalSize,
		fileCount,
		isZipped: false,
		burnAfterDownload,
		downloadCount: 0,
		uploadSpeed,
		uploadDuration: uploadDurationMs,
		downloadSpeed: 0,
		downloadDuration: 0,
		expiresAt,
		isDeleted: false,
		senderIp,
		senderDeviceName: senderDevice,
		senderSocketId,
		qrDataUri: qr,
		ai: null,
		activity: [
			{
				event: "uploaded",
				device: senderDevice,
				ip: senderIp,
				timestamp: new Date(),
			},
		],
	});

	const shareLink = `${shareBaseUrl}/g/${code}`;

	emitToRoom(code, "upload-complete", {
		code,
		qr,
		shareLink,
		expiresAt,
	});
	scheduleTransferCountdown(code, expiresAt);
	logEvent("Upload complete", `CODE: ${code}`, formatSizeMB(totalSize));

	const primaryFile = incomingFiles[0];
	void (async () => {
		if (!primaryFile) {
			return;
		}

		try {
			logEvent("AI analysis started", `CODE: ${code}`, `FILE: ${primaryFile.originalname}`);
			const aiResult = await analyzeFile(
				primaryFile.buffer,
				primaryFile.originalname,
				primaryFile.mimetype || "application/octet-stream",
			);

			await Transfer.updateOne({ code }, { $set: { ai: aiResult || null } });

			emitToRoom(code, "ai-ready", {
				summary: aiResult?.summary || null,
				category: aiResult?.category || null,
				suggestedName: aiResult?.suggestedName || null,
			});

			logEvent("AI analysis completed", `CODE: ${code}`, `READY: ${Boolean(aiResult)}`);
		} catch (aiError) {
			logError("AI analysis completed", aiError, `CODE: ${code}`, "READY: false");
		}
	})();

	return {
		success: true,
		code,
		shareLink,
		qr,
		expiresAt,
		files: uploadedFiles.map((file) => ({
			name: file.originalName,
			size: file.size,
			type: file.mimeType,
			icon: file.icon,
		})),
		totalSize,
		burnAfterDownload,
	};
}

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		files: getMaxFileCount(),
		fileSize: getMaxFileSizeBytes(),
	},
});

function multerHandler(req, res, next) {
	upload.array("files")(req, res, (error) => {
		if (!error) {
			return next();
		}

		const code = error?.code;
		if (code === "LIMIT_FILE_SIZE") {
			const maxMb = Number(process.env.MAX_FILE_SIZE_MB) || 500;
			return res
				.status(400)
				.json(buildErrorResponse(ERROR_CODES.FILE_TOO_LARGE, `This file is too large. Maximum size is ${maxMb}MB.`));
		}

		if (code === "LIMIT_FILE_COUNT") {
			const maxCount = Number(process.env.MAX_FILE_COUNT) || 10;
			return res
				.status(400)
				.json(buildErrorResponse(ERROR_CODES.TOO_MANY_FILES, `Too many files. You can upload up to ${maxCount} files at once.`));
		}

		if (code === "LIMIT_UNEXPECTED_FILE") {
			return res
				.status(400)
				.json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE, "Please use the 'files' field to upload."));
		}

		return next(error);
	});
}

router.post("/", rateLimitUpload, multerHandler, validateUpload, async (req, res) => {
	try {
		const incomingFiles = req.files || [];
		const senderSocketId =
			typeof req.body?.senderSocketId === "string" ? req.body.senderSocketId : "";
		const burnAfterDownload = parseBurnAfterDownload(req.body?.burnAfterDownload);
		const response = await processUploadFlow({
			req,
			incomingFiles,
			burnAfterDownload,
			senderSocketId,
		});

		return res.status(200).json(response);
	} catch (error) {
		logError("Upload failed", error);
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		return res.status(status).json(buildErrorResponse(errorCode, error.message));
	}
});

router.post("/clipboard", rateLimitUpload, async (req, res) => {
	try {
		logEvent("Clipboard upload", "REQUEST_RECEIVED");
		const { imageBase64, burnAfterDownload, senderSocketId } = req.body || {};

		if (typeof imageBase64 !== "string") {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE));
		}

		const match = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
		if (!match) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE));
		}

		const mimeType = match[1];
		const base64Payload = match[2];
		const buffer = Buffer.from(base64Payload, "base64");

		if (!buffer.length) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.NO_FILE_UPLOADED));
		}

		const extension = mimeType.split("/")[1]?.split("+")[0] || "png";
		const filename = `clipboard-${Date.now()}.${extension}`;
		const incomingFiles = [
			{
				originalname: filename,
				mimetype: mimeType,
				size: buffer.length,
				buffer,
			},
		];

		const response = await processUploadFlow({
			req,
			incomingFiles,
			burnAfterDownload: parseBurnAfterDownload(burnAfterDownload),
			senderSocketId: typeof senderSocketId === "string" ? senderSocketId : "",
		});

		return res.status(200).json(response);
	} catch (error) {
		logError("Clipboard upload failed", error);
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		return res.status(status).json(buildErrorResponse(errorCode, error.message));
	}
});

module.exports = router;

