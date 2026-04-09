const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");

const Transfer = require("../models/Transfer");
const { uploadBufferToR2 } = require("../services/fileManager");
const {
	emitToRoom,
	scheduleTransferCountdown,
	bindSocketToRoom,
} = require("../config/socket");
const { generateUniqueCode } = require("../services/codeGenerator");
const { generateQR } = require("../services/qrGenerator");
const { analyzeTransfer } = require("../services/aiAnalyzer");
const { rateLimitUpload } = require("../middleware/rateLimiter");
const { validateUpload, validateMimeIntegrity } = require("../middleware/validateUpload");
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

// Prevent the same transfer from running AI analysis more than once concurrently.
const aiInFlight = new Set();

function getMaxFileCount() {
	const maxCount = Number(process.env.MAX_FILE_COUNT);
	return Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 5;
}

function getMaxFileSizeBytes() {
	const maxSizeMb = Number(process.env.MAX_FILE_SIZE_MB);
	const runtimeMemoryMb = Number(
		process.env.RUNTIME_MEMORY_MB
			|| process.env.RENDER_MEMORY_MB
			|| process.env.MEMORY_LIMIT_MB,
	);
	const isConstrainedHost = Boolean(process.env.RENDER)
		|| (Number.isFinite(runtimeMemoryMb) && runtimeMemoryMb > 0 && runtimeMemoryMb <= 768);
	// multer.memoryStorage() keeps each upload fully in RAM.
	const defaultMb = isConstrainedHost ? 50 : 100;
	const safeMb = Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : defaultMb;
	const cappedMb = Math.min(safeMb, 100);
	return cappedMb * 1024 * 1024;
}

function getSessionExpiryMinutes() {
	const expiryMinutes = Number(process.env.SESSION_EXPIRY_MINUTES);
	return Number.isFinite(expiryMinutes) && expiryMinutes > 0
		? expiryMinutes
		: 10;
}

function parseBurnAfterDownload(value) {
	return parseBooleanFlag(value);
}

function parseBooleanFlag(value) {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		return value.toLowerCase() === "true";
	}

	return false;
}

function parsePassword(value) {
	if (typeof value !== "string") {
		return "";
	}

	return value.trim();
}

function getMaxSessionExpiryMinutes() {
	const maxMinutes = Number(process.env.MAX_SESSION_EXPIRY_MINUTES);
	return Number.isFinite(maxMinutes) && maxMinutes > 0
		? Math.floor(maxMinutes)
		: 24 * 60;
}

function parseExpiryMinutes(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return null;
	}

	return Math.min(Math.floor(parsed), getMaxSessionExpiryMinutes());
}

function createAppError(status, errorCode, message) {
	const error = new Error(message);
	error.status = status;
	error.errorCode = errorCode;
	return error;
}

function isUsableAiResult(aiResult) {
	if (!aiResult || aiResult.success === false) {
		return false;
	}

	const summary = String(aiResult.overall_summary || aiResult.summary || "").trim();
	return Boolean(summary && Array.isArray(aiResult.files) && aiResult.files.length > 0);
}

async function validateIncomingFiles(files) {
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

	const mimeIntegrity = await validateMimeIntegrity(files);
	if (!mimeIntegrity.valid) {
		throw createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, mimeIntegrity.message || "Invalid file type");
	}
}

async function processUploadFlow({
	req,
	incomingFiles,
	burnAfterDownload,
	senderSocketId,
	password,
	passwordProtected,
	expiryMinutes,
}) {
	const shareBaseUrl = process.env.SHARE_BASE_URL;
	if (!shareBaseUrl) {
		throw createAppError(500, ERROR_CODES.SERVER_ERROR, "SHARE_BASE_URL is not set in environment variables");
	}

	await validateIncomingFiles(incomingFiles);

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
		const speed = Math.round(uploadedSize / elapsedSeconds);

		emitToRoom(code, "upload-progress", {
			percent,
			speed,
			elapsed: Number(elapsedSeconds.toFixed(2)),
		});
	}

	const fileCount = incomingFiles.length;
	const effectiveExpiryMinutes = Number.isFinite(expiryMinutes) && expiryMinutes > 0
		? expiryMinutes
		: getSessionExpiryMinutes();
	const expiresAt = new Date(
		Date.now() + effectiveExpiryMinutes * 60 * 1000,
	);
	const shouldProtectWithPassword = Boolean(passwordProtected && password);
	const passwordHash = shouldProtectWithPassword
		? await bcrypt.hash(password, 10)
		: null;
	const uploadDurationMs = Math.max(Date.now() - uploadStartedAt, 1);
	const uploadSpeed = Math.round(totalSize / (uploadDurationMs / 1000));
	const qr = await generateQR(code);
	const shareLink = `${shareBaseUrl}/g/${code}`;
	const responsePayload = {
		success: true,
		code,
		shareLink,
		qr,
		expiryMinutes: effectiveExpiryMinutes,
		expiresAt,
		files: uploadedFiles.map((file) => ({
			name: file.originalName,
			size: file.size,
			type: file.mimeType,
			icon: file.icon,
		})),
		totalSize,
		burnAfterDownload,
		passwordProtected: shouldProtectWithPassword,
	};

	await Transfer.create({
		code,
		files: uploadedFiles,
		totalSize,
		fileCount,
		isZipped: false,
		burnAfterDownload,
		passwordProtected: shouldProtectWithPassword,
		passwordHash,
		passwordAttempts: 0,
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

	emitToRoom(code, "upload-complete", responsePayload);
	scheduleTransferCountdown(code, expiresAt);
	logEvent("Upload complete", `CODE: ${code}`, formatSizeMB(totalSize));

	const primaryFile = incomingFiles[0];
	void (async () => {
		if (!primaryFile) {
			return;
		}

		if (aiInFlight.has(code)) {
			logEvent("AI analysis skipped (already in flight)", `CODE: ${code}`);
			return;
		}

		aiInFlight.add(code);

		let emitted = false;
		const emitUnavailable = (warning) => {
			if (emitted) {
				return;
			}

			emitToRoom(code, "ai-ready", {
				summary: null,
				category: null,
				imageDescription: null,
				files: [],
				detectedIntent: null,
				riskFlags: [],
				warning: warning || "AI analysis unavailable",
			});
			emitted = true;
		};

		try {
			logEvent("AI analysis started", `CODE: ${code}`, `FILES: ${incomingFiles.length}`);
			const aiResult = await analyzeTransfer(incomingFiles, code);

			if (!isUsableAiResult(aiResult)) {
				emitUnavailable(aiResult?.warning || "AI analysis unavailable");

				logEvent("AI analysis completed", `CODE: ${code}`, "READY: false");
				return;
			}

			await Transfer.updateOne({ code }, { $set: { ai: aiResult } });

			emitToRoom(code, "ai-ready", {
				summary: aiResult.summary || aiResult.overall_summary || null,
				category: aiResult.category || null,
				imageDescription: aiResult.imageDescription || null,
				files: aiResult.files || [],
				detectedIntent: aiResult.detectedIntent || aiResult.detected_intent || null,
				riskFlags: aiResult.riskFlags || aiResult.risk_flags || [],
			});
			emitted = true;

			logEvent("AI analysis completed", `CODE: ${code}`, "READY: true");
		} catch (aiError) {
			logError("AI analysis failed", aiError, `CODE: ${code}`, "READY: false");
			emitUnavailable("AI analysis unavailable");
		} finally {
			aiInFlight.delete(code);
			if (!emitted) {
				emitUnavailable("AI analysis unavailable");
			}
		}
	})();

	return responsePayload;
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
			const maxMb = Math.round(getMaxFileSizeBytes() / (1024 * 1024));
			return res
				.status(400)
				.json(buildErrorResponse(ERROR_CODES.FILE_TOO_LARGE, `This file is too large. Maximum size is ${maxMb}MB.`));
		}

		if (code === "LIMIT_FILE_COUNT") {
			const maxCount = getMaxFileCount();
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
		const senderSocketId = typeof req.body?.senderSocketId === "string"
			? req.body.senderSocketId
			: (typeof req.body?.socketId === "string" ? req.body.socketId : "");
		const burnAfterDownload = parseBurnAfterDownload(req.body?.burnAfterDownload);
		const passwordProtected = parseBooleanFlag(req.body?.passwordProtected);
		const password = parsePassword(req.body?.password);
		const expiryMinutes = parseExpiryMinutes(req.body?.expiryMinutes);
		const response = await processUploadFlow({
			req,
			incomingFiles,
			burnAfterDownload,
			senderSocketId,
			password,
			passwordProtected,
			expiryMinutes,
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
		const {
			imageBase64,
			base64,
			burnAfterDownload,
			senderSocketId,
			socketId,
			passwordProtected,
			password,
			expiryMinutes,
		} = req.body || {};
		const imagePayload = typeof imageBase64 === "string"
			? imageBase64
			: (typeof base64 === "string" ? base64 : "");

		if (!imagePayload) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE));
		}

		const normalizedImageBase64 = imagePayload.startsWith("data:")
			? imagePayload
			: `data:image/png;base64,${imagePayload}`;

		const match = normalizedImageBase64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
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
			senderSocketId: typeof senderSocketId === "string"
				? senderSocketId
				: (typeof socketId === "string" ? socketId : ""),
			passwordProtected: parseBooleanFlag(passwordProtected),
			password: parsePassword(password),
			expiryMinutes: parseExpiryMinutes(expiryMinutes),
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

