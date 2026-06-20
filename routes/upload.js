const express = require("express");
const crypto = require("crypto");
const Busboy = require("busboy");
const bcrypt = require("bcryptjs");
const { PassThrough, Transform } = require("stream");
const { Upload } = require("@aws-sdk/lib-storage");

const Transfer = require("../models/Transfer");
const { r2Client, r2Bucket, isR2Configured } = require("../config/r2");
const { uploadBufferToR2 } = require("../services/fileManager");
const {
	emitToRoom,
	scheduleTransferCountdown,
	bindSocketToRoom,
	broadcastNewTransferToSubnet,
} = require("../config/socket");
const { generateUniqueCode } = require("../services/codeGenerator");
const { rateLimitUpload } = require("../middleware/rateLimiter");
const {
	sanitizeRequestBody,
	isValidPassword,
	isValidExpiryMinutes,
} = require("../middleware/inputValidator");
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
const { recordUpload } = require("../utils/performance");

const router = express.Router();

// ── Configuration ─────────────────────────────────────────
function getMaxFileCount() {
	const maxCount = Number(process.env.MAX_FILE_COUNT);
	return Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 10;
}

function getMaxFileSizeBytes() {
	const maxSizeMb = Number(process.env.MAX_FILE_SIZE_MB);
	const safeMb = Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : 100;
	// Cap at 100MB total — all files combined must not exceed this
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

// ── MIME / signature checks (sniff-buffer based) ──────────────
const SNIFF_BYTES = 8192;
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
	// Any image/* → any image/* is compatible: phone file managers frequently
	// report image/jpeg for screenshots that are actually WebP, HEIC, or AVIF.
	if (a.startsWith('image/') && b.startsWith('image/')) return true;
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

// Throttle progress emits: at most one per PROGRESS_EMIT_INTERVAL_MS or whenever
// the percent jumps by >=1. Smoothed to 100ms (10fps) for fluid UI updates on fast connections.
const PROGRESS_EMIT_INTERVAL_MS = 100;

// ── Streaming multipart parser ───────────────────────────────
// Pipes each multipart file directly to R2 via lib-storage Upload (multipart, parallel).
// No buffering of full file in RAM. First SNIFF_BYTES of each file are tee'd into a
// small buffer for MIME / executable signature validation.
//
// Progress: as bytes arrive from the client we emit `upload-progress` to the room
// with bytes received so far. This is HTTP-receive progress (sender→server), not
// R2-write progress — important: we do NOT wait for R2 write to confirm progress
// to the sender, since on slow network the sender wants to see its own throughput.
function parseStreamingMultipart(req, { code, maxFileCount, maxTotalBytes }) {
	return new Promise((resolve, reject) => {
		let busboy;
		try {
			busboy = Busboy({
				headers: req.headers,
				limits: {
					files: maxFileCount,
					// No fileSize limit here — our data handler enforces maxTotalBytes correctly.
					// Busboy's fileSize limit causes an internal null reference crash on large files
					// (sets .truncated on a null stream reference), crashing the process.
					fields: 50,
				},
			});
		} catch (err) {
			logError("BUSBOY CREATION FAILED", err, `CODE: ${code}`);
			reject(createAppError(400, ERROR_CODES.INVALID_FILE_TYPE, "Invalid upload payload"));
			return;
		}

		const fields = {};
		const files = [];
		const uploadPromises = [];
		let totalBytes = 0;
		let aborted = false;
		let settled = false;
		let lastProgressEmitAt = 0;
		let lastProgressPercent = -1;

		const maybeEmitProgress = (force = false) => {
			if (aborted) return;
			const now = Date.now();
			const sinceLast = now - lastProgressEmitAt;
			const percent = maxTotalBytes > 0
				? Math.min(100, Math.round((totalBytes / maxTotalBytes) * 100))
				: 0;
			if (!force && sinceLast < PROGRESS_EMIT_INTERVAL_MS && percent === lastProgressPercent) {
				return;
			}
			lastProgressEmitAt = now;
			lastProgressPercent = percent;
			emitToRoom(code, "upload-progress", {
				bytesReceived: totalBytes,
				percent,
			});
		};

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

			const progressStream = new Transform({
				transform(chunk, encoding, callback) {
					if (aborted) {
						callback();
						return;
					}
					bytes += chunk.length;
					totalBytes += chunk.length;

					if (totalBytes > maxTotalBytes) {
						fileStream.unpipe();
						abortAll(createAppError(400, ERROR_CODES.FILE_TOO_LARGE, "Upload exceeds total size limit"));
						callback(new Error("Upload exceeds total size limit"));
						return;
					}

					if (sniffLen < SNIFF_BYTES) {
						const need = SNIFF_BYTES - sniffLen;
						const slice = chunk.length <= need ? chunk : chunk.subarray(0, need);
						sniffParts.push(slice);
						sniffLen += slice.length;
					}

					maybeEmitProgress(false);
					callback(null, chunk);
				}
			});

			fileStream.on("error", (err) => abortAll(err));
			progressStream.on("error", (err) => abortAll(err));

			fileStream.pipe(progressStream).pipe(passthrough);

			// Configure multipart upload to R2:
			// - 8MB part size, 8 concurrent parts (64MB in-flight) for max throughput
			// - leavePartsOnError:false so aborts clean up server-side parts
			let uploader;
			try {
				uploader = new Upload({
					client: r2Client,
					queueSize: 8,
					partSize: 8 * 1024 * 1024,
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
			};
			files.push(fileEntry);

			uploadPromises.push(
				uploader.done().catch((err) => {
					if (!aborted) {
						abortAll(err);
						throw err; // propagate to Promise.all() only when we're the first to abort
					}
					// Already aborted: abortAll() has already rejected the parent promise.
					// Swallowing here prevents unhandled rejection × N files.
				}),
			);
		});

		busboy.on("filesLimit", () => {
			logError("BUSBOY FILES LIMIT EXCEEDED", null, `CODE: ${code}`);
			abortAll(createAppError(400, ERROR_CODES.TOO_MANY_FILES, "Too many files"));
		});

		busboy.on("error", (err) => {
			logError("BUSBOY ERROR", err, `CODE: ${code}`);
			abortAll(err);
		});
		
		req.on("aborted", () => {
			logError("REQUEST ABORTED BY CLIENT", null, `CODE: ${code}`);
			abortAll(createAppError(499, ERROR_CODES.SERVER_ERROR, "Client aborted upload"));
		});
		
		req.on("error", (err) => {
			logError("REQUEST ERROR", err, `CODE: ${code}`);
			abortAll(err);
		});

		busboy.on("close", async () => {
			if (aborted) return;
			try {
				await Promise.all(uploadPromises);
				if (!files.length) {
					reject(createAppError(400, ERROR_CODES.NO_FILE_UPLOADED, "No file uploaded"));
					return;
				}
				maybeEmitProgress(true); // Final 100% tick.
				finish(() => resolve({ fields, files, totalBytes }));
			} catch (err) {
				logError("R2 UPLOAD FAILED IN BUSBOY CLOSE", err, `CODE: ${code}`);
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
	const uploadDurationMs = Math.max(Date.now() - uploadStartedAt, 1);
	const uploadSpeed = Math.round(totalSize / (uploadDurationMs / 1000));
	const shareBaseUrl = process.env.SHARE_BASE_URL;
	const shareLink = `${shareBaseUrl}/g/${code}`;
	const senderIp = getClientIp(req);
	const senderDevice = getDeviceName(req.get("user-agent") || "");
	const ownershipToken = crypto.randomUUID();

	const uploadedFiles = files.map((f) => ({
		originalName: f.originalName,
		storedKey: f.storedKey,
		size: f.size,
		mimeType: f.mimeType,
		icon: mimeToIcon(f.mimeType),
	}));

	// Hash password if needed — QR is rendered client-side by react-qr-code, no server generation needed
	const [passwordHash] = await Promise.all([
		shouldProtectWithPassword ? bcrypt.hash(password, 8) : Promise.resolve(null)
		//                                              ^^^ rounds reduced from 10→8 (see Fix 7B)
	]);
	const qr = null; // Not generated server-side — frontend uses react-qr-code with shareLink directly

	const responsePayload = {
		success: true,
		code,
		shareLink,
		qr: undefined,
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
		ownershipToken,
	};

	// Notify clients immediately — files are in R2, code is generated, response is ready.
	// DB write happens async in the background; failure is logged but doesn't block the user.
	emitToRoom(code, "upload-complete", responsePayload);
	scheduleTransferCountdown(code, expiresAt);
	broadcastNewTransferToSubnet(code, senderIp);
	recordUpload(Number(totalSize || 0));
	logEvent("Upload complete", `CODE: ${code}`, formatSizeMB(totalSize));

	// Fire-and-forget DB write (Atlas M0 is highly reliable; failure rate ~0.001%)
	Transfer.create({
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
		ownershipToken,
		qrDataUri: "",
		activity: [
			{ event: "uploaded", device: senderDevice, ip: senderIp, timestamp: new Date() },
		],
	}).catch((err) => {
		logError("DB write failed after upload-complete emitted", err, `CODE: ${code}`);
		// Best-effort: inform the sender that the transfer wasn't persisted
		// (rare, but prevents the sender page showing a transfer that can't be fetched)
		emitToRoom(code, "upload-db-error", { code });
	});

	return responsePayload;
}

// ── Streaming POST /api/upload ───────────────────────────────
router.post("/", rateLimitUpload, sanitizeRequestBody, async (req, res) => {
	if (!isR2Configured) {
		logError("R2 NOT CONFIGURED", null);
		return res.status(503).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Storage is not configured"));
	}

	const shareBaseUrl = process.env.SHARE_BASE_URL;
	if (!shareBaseUrl) {
		logError("SHARE_BASE_URL NOT SET", null);
		return res.status(500).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "SHARE_BASE_URL is not set"));
	}

	const contentType = String(req.headers["content-type"] || "");
	if (!/^multipart\/form-data/i.test(contentType)) {
		logError("INVALID CONTENT TYPE", null, `Received: ${contentType}`);
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
		await Promise.all(files.map(f => validateSniffBuffer(f)));
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
		
		// Validate only if password protection is enabled (skip unnecessary validation)
		if (passwordProtected && password && !isValidPassword(password)) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_REQUEST, "Invalid password format"));
		}
		
		// Validate only if expiry is provided (skip unnecessary validation)
		if (expiryMinutes !== null && !isValidExpiryMinutes(expiryMinutes)) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_REQUEST, "Invalid expiry time"));
		}

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

		// Release all file stream references immediately to free memory
		files.forEach((f) => {
			try { if (f.passthrough && typeof f.passthrough.destroy === 'function') f.passthrough.destroy(); } catch (e) {}
			try { if (f.uploader && typeof f.uploader.abort === 'function') f.uploader.abort(); } catch (e) {}
		});

		return res.status(200).json(response);
	} catch (error) {
		logError("Upload finalize failed", error, `CODE: ${code}`);
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		return res.status(status).json(buildErrorResponse(errorCode, error.message));
	}
});

// ── Clipboard upload (small in-memory image) ──────────────────
router.post("/clipboard", rateLimitUpload, sanitizeRequestBody, async (req, res) => {
	try {
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

		return res.status(200).json(response);
	} catch (error) {
		logError("Clipboard upload failed", error);
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		return res.status(status).json(buildErrorResponse(errorCode, error.message));
	}
});

module.exports = router;
// Internal helpers exposed for sibling routes (e.g. /api/text/share) so we don't
// duplicate finalize logic. Hung off the router function
// because Express routers are JS functions and accept extra properties.
module.exports.finalizeTransfer = finalizeTransfer;
module.exports.getMaxFileSizeBytes = getMaxFileSizeBytes;
module.exports.parseExpiryMinutes = parseExpiryMinutes;
module.exports.parseBooleanFlag = parseBooleanFlag;
module.exports.parsePassword = parsePassword;
