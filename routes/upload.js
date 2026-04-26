const express = require("express");
const Busboy = require("busboy");
const bcrypt = require("bcryptjs");
const { PassThrough } = require("stream");
const { Upload } = require("@aws-sdk/lib-storage");

const Transfer = require("../models/Transfer");
const { r2Client, r2Bucket, isR2Configured } = require("../config/r2");
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

// ── Configuration ─────────────────────────────────────────
function getMaxFileCount() {
	const maxCount = Number(process.env.MAX_FILE_COUNT);
	return Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 5;
}

function getMaxFileSizeBytes() {
	const maxSizeMb = Number(process.env.MAX_FILE_SIZE_MB);
	const safeMb = Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : 100;
	const cappedMb = Math.min(safeMb, 100);
	return cappedMb * 1024 * 1024;
}

function getSessionExpiryMinutes() {
	const expiryMinutes = Number(process.env.SESSION_EXPIRY_MINUTES);
	return Number.isFinite(expiryMinutes) && expiryMinutes > 0 ? expiryMinutes : 10;
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

function parseBooleanFlag(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.toLowerCase() === "true";
	return false;
}

const parseBurnAfterDownload = parseBooleanFlag;

function parsePassword(value) {
	return typeof value === "string" ? value.trim() : "";
}

function createAppError(status, errorCode, message) {
	const error = new Error(message);
	error.status = status;
	error.errorCode = errorCode;
	return error;
}

function isUsableAiResult(aiResult) {
	if (!aiResult || aiResult.success === false) return false;
	const summary = String(aiResult.overall_summary || aiResult.summary || "").trim();
	return Boolean(summary && Array.isArray(aiResult.files) && aiResult.files.length > 0);
}

// ── MIME / signature checks (sniff-buffer based) ──────────────
const SNIFF_BYTES = 8192;
// Up to this size, retain the full file in memory as a side-buffer for AI analysis.
// Beyond this, AI only sees the sniff buffer (8KB) — sufficient for MIME classification
// but not for content extraction. Keeps streaming honest for large files.
const AI_BUFFER_LIMIT = 6 * 1024 * 1024; // 6 MB
const BLOCKED_DETECTED_EXTENSIONS = new Set([
	".exe", ".bat", ".sh", ".cmd", ".msi", ".scr", ".com", ".vbs", ".ps1", ".jar",
]);

let fileTypeModulePromise;
async function detectFileType(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
	if (!fileTypeModulePromise) fileTypeModulePromise = import("file-type");
	const mod = await fileTypeModulePromise;
	return mod.fileTypeFromBuffer(buffer);
}

function isMimeCompatible(declared, detected) {
	const a = String(declared || "").toLowerCase();
	const b = String(detected || "").toLowerCase();
	if (!a || !b) return true;
	if (a === b) return true;
	if (a === "application/octet-stream") return true;
	const fa = a.split("/")[0];
	const fb = b.split("/")[0];
	if (fa && fa === fb) return true;
	if (a.includes("xml") && b.includes("xml")) return true;
	return false;
}

async function validateSniffBuffer(file) {
	const sniff = file.sniff;
	if (hasDangerousSignature(sniff)) {
		throw createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, "Executable file signatures are not allowed");
	}

	const detected = await detectFileType(sniff);
	if (!detected) return;

	const detectedExt = `.${String(detected.ext || "").toLowerCase()}`;
	if (BLOCKED_DETECTED_EXTENSIONS.has(detectedExt)) {
		throw createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, "Executable or script payloads are not allowed");
	}

	if (!isMimeCompatible(file.mimeType, detected.mime)) {
		throw createAppError(
			400,
			ERROR_CODES.INVALID_FILE_TYPE,
			`MIME mismatch detected (${file.mimeType || "unspecified"} vs ${detected.mime})`,
		);
	}
}

// ── Streaming multipart parser ───────────────────────────────
// Pipes each multipart file directly to R2 via lib-storage Upload (multipart, parallel).
// No buffering of full file in RAM. First SNIFF_BYTES of each file are tee'd into a
// small buffer for MIME / executable signature validation.
function parseStreamingMultipart(req, { code, maxFileCount, maxTotalBytes }) {
	return new Promise((resolve, reject) => {
		let busboy;
		try {
			busboy = Busboy({
				headers: req.headers,
				limits: {
					files: maxFileCount,
					fileSize: maxTotalBytes, // per-file cap; we also enforce total below
					fields: 50,
				},
			});
		} catch (err) {
			reject(createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, "Invalid upload payload"));
			return;
		}

		const fields = {};
		const files = [];
		const uploadPromises = [];
		let totalBytes = 0;
		let aborted = false;
		let settled = false;

		const finish = (fn) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const abortAll = (err) => {
			if (aborted) return;
			aborted = true;
			for (const f of files) {
				try { f.passthrough.destroy(err || new Error("upload aborted")); } catch {}
				try { if (f.uploader && typeof f.uploader.abort === "function") f.uploader.abort(); } catch {}
			}
			try { req.unpipe(busboy); } catch {}
			try { busboy.destroy(); } catch {}
			finish(() => reject(err));
		};

		busboy.on("field", (name, value) => {
			if (aborted) return;
			if (typeof value === "string" && value.length <= 4096) {
				fields[name] = value;
			}
		});

		busboy.on("file", (fieldname, fileStream, info) => {
			if (aborted) return;

			if (fieldname !== "files") {
				// Drain unknown fields without raising errors.
				fileStream.resume();
				return;
			}

			if (files.length >= maxFileCount) {
				fileStream.resume();
				abortAll(createAppError(400, ERROR_CODES.TOO_MANY_FILES, "Too many files"));
				return;
			}

			const originalName = info?.filename || "file";
			const declaredMime = info?.mimeType || info?.mimetype || "application/octet-stream";

			if (isBlockedExtension(originalName)) {
				fileStream.resume();
				abortAll(createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, "Invalid file type"));
				return;
			}

			const safeName = sanitizeFilename(originalName);
			const storedKey = `transfers/${code}/${safeName}`;
			const passthrough = new PassThrough({ highWaterMark: 1024 * 1024 });
			let sniffParts = [];
			let sniffLen = 0;
			let bytes = 0;
			let aiParts = [];
			let aiLen = 0;
			let aiBufferDropped = false;

			fileStream.on("data", (chunk) => {
				if (aborted) return;
				bytes += chunk.length;
				totalBytes += chunk.length;

				if (totalBytes > maxTotalBytes) {
					fileStream.unpipe();
					abortAll(createAppError(400, ERROR_CODES.FILE_TOO_LARGE, "Upload exceeds total size limit"));
					return;
				}

				if (sniffLen < SNIFF_BYTES) {
					const need = SNIFF_BYTES - sniffLen;
					const slice = chunk.length <= need ? chunk : chunk.subarray(0, need);
					sniffParts.push(slice);
					sniffLen += slice.length;
				}

				if (!aiBufferDropped) {
					if (aiLen + chunk.length <= AI_BUFFER_LIMIT) {
						aiParts.push(chunk);
						aiLen += chunk.length;
					} else {
						// Exceeded threshold: drop the AI buffer and continue streaming.
						aiBufferDropped = true;
						aiParts = [];
						aiLen = 0;
					}
				}
			});

			fileStream.on("limit", () => {
				abortAll(createAppError(400, ERROR_CODES.FILE_TOO_LARGE, "File exceeds size limit"));
			});
			fileStream.on("error", (err) => abortAll(err));

			fileStream.pipe(passthrough);

			// Configure multipart upload to R2:
			// - 5MB part size (R2 minimum), 4 concurrent parts
			// - leavePartsOnError:false so aborts clean up server-side parts
			let uploader;
			try {
				uploader = new Upload({
					client: r2Client,
					queueSize: 4,
					partSize: 5 * 1024 * 1024,
					leavePartsOnError: false,
					params: {
						Bucket: r2Bucket,
						Key: storedKey,
						Body: passthrough,
						ContentType: declaredMime,
					},
				});
			} catch (err) {
				abortAll(err);
				return;
			}

			const fileEntry = {
				originalName,
				safeName,
				storedKey,
				mimeType: declaredMime,
				passthrough,
				uploader,
				get size() { return bytes; },
				get sniff() { return Buffer.concat(sniffParts, sniffLen); },
				get aiBuffer() {
					return aiBufferDropped ? null : Buffer.concat(aiParts, aiLen);
				},
			};
			files.push(fileEntry);

			uploadPromises.push(
				uploader.done().catch((err) => {
					if (!aborted) abortAll(err);
					throw err;
				}),
			);
		});

		busboy.on("filesLimit", () => {
			abortAll(createAppError(400, ERROR_CODES.TOO_MANY_FILES, "Too many files"));
		});

		busboy.on("error", (err) => abortAll(err));
		req.on("aborted", () => abortAll(createAppError(499, ERROR_CODES.SERVER_ERROR, "Client aborted upload")));
		req.on("error", (err) => abortAll(err));

		busboy.on("close", async () => {
			if (aborted) return;
			try {
				await Promise.all(uploadPromises);
				if (!files.length) {
					reject(createAppError(400, ERROR_CODES.NO_FILE_UPLOADED, "No file uploaded"));
					return;
				}
				finish(() => resolve({ fields, files, totalBytes }));
			} catch (err) {
				if (!settled) finish(() => reject(err));
			}
		});

		req.pipe(busboy);
	});
}

// ── Finalization (shared between streaming and clipboard paths) ──
async function finalizeTransfer({
	req,
	code,
	files, // [{ originalName, storedKey, mimeType, size }]
	totalSize,
	uploadStartedAt,
	burnAfterDownload,
	password,
	passwordProtected,
	expiryMinutes,
}) {
	const fileCount = files.length;
	const effectiveExpiryMinutes = Number.isFinite(expiryMinutes) && expiryMinutes > 0
		? expiryMinutes
		: getSessionExpiryMinutes();
	const expiresAt = new Date(Date.now() + effectiveExpiryMinutes * 60 * 1000);
	const shouldProtectWithPassword = Boolean(passwordProtected && password);
	const passwordHash = shouldProtectWithPassword ? await bcrypt.hash(password, 10) : null;
	const uploadDurationMs = Math.max(Date.now() - uploadStartedAt, 1);
	const uploadSpeed = Math.round(totalSize / (uploadDurationMs / 1000));
	const qr = await generateQR(code);
	const shareBaseUrl = process.env.SHARE_BASE_URL;
	const shareLink = `${shareBaseUrl}/g/${code}`;
	const senderIp = getClientIp(req);
	const senderDevice = getDeviceName(req.get("user-agent") || "");

	const uploadedFiles = files.map((f) => ({
		originalName: f.originalName,
		storedKey: f.storedKey,
		size: f.size,
		mimeType: f.mimeType,
		icon: mimeToIcon(f.mimeType),
	}));

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
		senderSocketId: typeof req._senderSocketId === "string" ? req._senderSocketId : "",
		qrDataUri: qr,
		ai: null,
		activity: [
			{ event: "uploaded", device: senderDevice, ip: senderIp, timestamp: new Date() },
		],
	});

	emitToRoom(code, "upload-complete", responsePayload);
	scheduleTransferCountdown(code, expiresAt);
	logEvent("Upload complete", `CODE: ${code}`, formatSizeMB(totalSize));

	// AI analysis still runs from the original incoming buffers/sniffs when supplied.
	// For streaming uploads we pass nothing here; aiAnalyzer should fetch from R2 if needed.
	return responsePayload;
}

function fireAndForgetAi(code, aiInputFiles) {
	const primaryFile = aiInputFiles && aiInputFiles[0];
	void (async () => {
		if (!primaryFile) return;
		if (aiInFlight.has(code)) {
			logEvent("AI analysis skipped (already in flight)", `CODE: ${code}`);
			return;
		}
		aiInFlight.add(code);
		let emitted = false;
		const emitUnavailable = (warning) => {
			if (emitted) return;
			emitToRoom(code, "ai-ready", {
				summary: null, category: null, imageDescription: null,
				files: [], detectedIntent: null, riskFlags: [],
				warning: warning || "AI analysis unavailable",
			});
			emitted = true;
		};
		try {
			logEvent("AI analysis started", `CODE: ${code}`, `FILES: ${aiInputFiles.length}`);
			const aiResult = await analyzeTransfer(aiInputFiles, code);
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
			logError("AI analysis failed", aiError, `CODE: ${code}`);
			emitUnavailable("AI analysis unavailable");
		} finally {
			aiInFlight.delete(code);
			if (!emitted) emitUnavailable("AI analysis unavailable");
		}
	})();
}

// ── Streaming POST /api/upload ───────────────────────────────
router.post("/", rateLimitUpload, async (req, res) => {
	if (!isR2Configured) {
		return res.status(503).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Storage is not configured"));
	}

	const shareBaseUrl = process.env.SHARE_BASE_URL;
	if (!shareBaseUrl) {
		return res.status(500).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "SHARE_BASE_URL is not set"));
	}

	const contentType = String(req.headers["content-type"] || "");
	if (!/^multipart\/form-data/i.test(contentType)) {
		return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE, "Expected multipart/form-data"));
	}

	const code = await generateUniqueCode();
	const maxFileCount = getMaxFileCount();
	const maxTotalBytes = getMaxFileSizeBytes();
	const uploadStartedAt = Date.now();
	let parsed;

	try {
		parsed = await parseStreamingMultipart(req, { code, maxFileCount, maxTotalBytes });
	} catch (error) {
		logError("Upload stream failed", error, `CODE: ${code}`);
		// Cleanup any partially-written R2 objects (Upload.abort already handles in-flight parts;
		// no completed objects exist if we aborted before busboy.close).
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		if (!res.headersSent) {
			return res.status(status).json(buildErrorResponse(errorCode, error.message));
		}
		return;
	}

	const { fields, files, totalBytes } = parsed;

	// Bind sender socket → room (for upload-complete fan-out) before validation/finalize.
	const senderSocketId = typeof fields.senderSocketId === "string" && fields.senderSocketId
		? fields.senderSocketId
		: (typeof fields.socketId === "string" ? fields.socketId : "");
	if (senderSocketId) bindSocketToRoom(code, senderSocketId);
	req._senderSocketId = senderSocketId;

	logEvent("Upload received", `CODE: ${code}`, `FILES: ${files.length}`, formatSizeMB(totalBytes));

	// Post-stream validation against sniff buffers. If any file fails, we have to delete
	// what was uploaded to R2 (since streams completed successfully).
	try {
		for (const f of files) {
			await validateSniffBuffer(f);
		}
	} catch (validationErr) {
		// Best-effort cleanup of completed objects.
		try {
			const { deleteFilesFromR2 } = require("../services/fileManager");
			await deleteFilesFromR2(files.map((f) => ({ storedKey: f.storedKey })));
		} catch (cleanupErr) {
			logError("R2 cleanup after validation failure failed", cleanupErr, `CODE: ${code}`);
		}
		const status = validationErr?.status || 400;
		const errorCode = validationErr?.errorCode || ERROR_CODES.INVALID_FILE_TYPE;
		return res.status(status).json(buildErrorResponse(errorCode, validationErr.message));
	}

	try {
		const burnAfterDownload = parseBurnAfterDownload(fields.burnAfterDownload);
		const passwordProtected = parseBooleanFlag(fields.passwordProtected);
		const password = parsePassword(fields.password);
		const expiryMinutes = parseExpiryMinutes(fields.expiryMinutes);

		const fileEntries = files.map((f) => ({
			originalName: f.originalName,
			storedKey: f.storedKey,
			mimeType: f.mimeType,
			size: f.size,
		}));

		const response = await finalizeTransfer({
			req,
			code,
			files: fileEntries,
			totalSize: totalBytes,
			uploadStartedAt,
			burnAfterDownload,
			password,
			passwordProtected,
			expiryMinutes,
		});

		// AI analysis: pass the full buffer if we retained it (file ≤ AI_BUFFER_LIMIT),
		// otherwise pass the sniff buffer so the analyzer can at least classify the type.
		fireAndForgetAi(code, files.map((f) => ({
			originalname: f.originalName,
			mimetype: f.mimeType,
			size: f.size,
			buffer: f.aiBuffer || f.sniff,
		})));

		return res.status(200).json(response);
	} catch (error) {
		logError("Upload finalize failed", error, `CODE: ${code}`);
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		return res.status(status).json(buildErrorResponse(errorCode, error.message));
	}
});

// ── Clipboard upload (small in-memory image) ──────────────────
router.post("/clipboard", rateLimitUpload, async (req, res) => {
	try {
		logEvent("Clipboard upload", "REQUEST_RECEIVED");
		const {
			imageBase64, base64,
			burnAfterDownload, senderSocketId, socketId,
			passwordProtected, password, expiryMinutes,
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
		const buffer = Buffer.from(match[2], "base64");
		if (!buffer.length) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.NO_FILE_UPLOADED));
		}

		if (buffer.length > getMaxFileSizeBytes()) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.FILE_TOO_LARGE));
		}

		const extension = mimeType.split("/")[1]?.split("+")[0] || "png";
		const filename = `clipboard-${Date.now()}.${extension}`;
		const code = await generateUniqueCode();
		const safeName = sanitizeFilename(filename);
		const storedKey = `transfers/${code}/${safeName}`;
		const senderId = typeof senderSocketId === "string" && senderSocketId
			? senderSocketId
			: (typeof socketId === "string" ? socketId : "");
		if (senderId) bindSocketToRoom(code, senderId);
		req._senderSocketId = senderId;

		const sniff = buffer.subarray(0, SNIFF_BYTES);
		await validateSniffBuffer({ sniff, mimeType });

		await uploadBufferToR2({ key: storedKey, body: buffer, contentType: mimeType });

		const response = await finalizeTransfer({
			req,
			code,
			files: [{ originalName: filename, storedKey, mimeType, size: buffer.length }],
			totalSize: buffer.length,
			uploadStartedAt: Date.now(),
			burnAfterDownload: parseBurnAfterDownload(burnAfterDownload),
			password: parsePassword(password),
			passwordProtected: parseBooleanFlag(passwordProtected),
			expiryMinutes: parseExpiryMinutes(expiryMinutes),
		});

		fireAndForgetAi(code, [{ originalname: filename, mimetype: mimeType, size: buffer.length, buffer }]);

		return res.status(200).json(response);
	} catch (error) {
		logError("Clipboard upload failed", error);
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		return res.status(status).json(buildErrorResponse(errorCode, error.message));
	}
});

module.exports = router;
