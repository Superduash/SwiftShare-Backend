const express = require("express");
const multer = require("multer");
const { PutObjectCommand } = require("@aws-sdk/client-s3");

const Transfer = require("../models/Transfer");
const { r2Client, r2Bucket } = require("../config/r2");
const {
	emitToRoom,
	scheduleTransferCountdown,
	bindSocketToRoom,
} = require("../config/socket");
const { generateUniqueCode } = require("../services/codeGenerator");
const { generateQR } = require("../services/qrGenerator");
const { analyzeFile } = require("../services/aiAnalyzer");
const { validateUpload } = require("../middleware/validateUpload");
const { extractClientIp, parseDeviceName } = require("../utils/helpers");
const {
	getFileIcon,
	sanitizeFilename,
	getTotalSize,
} = require("../utils/fileHelpers");

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

function logEvent(message, data) {
	const timestamp = new Date().toISOString();
	if (data) {
		console.log(`[${timestamp}] ${message}`, data);
	} else {
		console.log(`[${timestamp}] ${message}`);
	}
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

		if (error instanceof multer.MulterError) {
			if (error.code === "LIMIT_FILE_SIZE") {
				return res.status(400).json({ success: false, error: "FILE_TOO_LARGE" });
			}

			if (error.code === "LIMIT_FILE_COUNT") {
				return res.status(400).json({ success: false, error: "TOO_MANY_FILES" });
			}
		}

		return res.status(400).json({ success: false, error: "NO_FILE_UPLOADED" });
	});
}

router.post("/", multerHandler, validateUpload, async (req, res) => {
	try {
		const shareBaseUrl = process.env.SHARE_BASE_URL;
		if (!shareBaseUrl) {
			throw new Error("SHARE_BASE_URL is not set in environment variables");
		}

		const code = await generateUniqueCode();
		const incomingFiles = req.files || [];
		const uploadedFiles = [];
		const senderSocketId =
			typeof req.body?.senderSocketId === "string" ? req.body.senderSocketId : "";

		if (senderSocketId) {
			bindSocketToRoom(code, senderSocketId);
		}

		const totalSize = getTotalSize(incomingFiles);
		let uploadedSize = 0;
		const uploadStartedAt = Date.now();
		logEvent("Upload started", {
			code,
			fileCount: incomingFiles.length,
			totalSize,
		});

		for (const file of incomingFiles) {
			const safeName = sanitizeFilename(file.originalname);
			const storedKey = `transfers/${code}/${safeName}`;
			const mimeType = file.mimetype || "application/octet-stream";

			await r2Client.send(
				new PutObjectCommand({
					Bucket: r2Bucket,
					Key: storedKey,
					Body: file.buffer,
					ContentType: mimeType,
				}),
			);

			uploadedFiles.push({
				originalName: file.originalname,
				storedKey,
				size: file.size,
				mimeType,
				icon: getFileIcon(mimeType),
			});

			uploadedSize += file.size;
			const elapsedSeconds = Math.max((Date.now() - uploadStartedAt) / 1000, 0.001);
			const percent = Math.min(100, Math.round((uploadedSize / totalSize) * 100));
			const speed = Number(((uploadedSize / (1024 * 1024)) / elapsedSeconds).toFixed(2));

			emitToRoom(code, "upload-progress", {
				percent,
				speed,
				elapsed: Number(elapsedSeconds.toFixed(2)),
			});
		}

		const fileCount = incomingFiles.length;
		const burnAfterDownload = parseBurnAfterDownload(req.body?.burnAfterDownload);
		const expiresAt = new Date(
			Date.now() + getSessionExpiryMinutes() * 60 * 1000,
		);
		const qr = await generateQR(code);

		await Transfer.create({
			code,
			files: uploadedFiles,
			totalSize,
			fileCount,
			isZipped: false,
			burnAfterDownload,
			downloadCount: 0,
			expiresAt,
			isDeleted: false,
			senderIp: extractClientIp(req),
			senderDeviceName: parseDeviceName(req.get("user-agent") || ""),
			senderSocketId,
			qrDataUri: qr,
			ai: null,
		});

		const shareLink = `${shareBaseUrl}/g/${code}`;

		emitToRoom(code, "upload-complete", {
			code,
			qr,
			shareLink,
			expiresAt,
		});
		scheduleTransferCountdown(code, expiresAt);
		logEvent("Upload complete", { code, expiresAt });

		const primaryFile = incomingFiles[0];
		void (async () => {
			if (!primaryFile) {
				return;
			}

			const aiResult = await analyzeFile(
				primaryFile.buffer,
				primaryFile.originalname,
				primaryFile.mimetype || "application/octet-stream",
			);

			await Transfer.updateOne(
				{ code },
				{ $set: { ai: aiResult || null } },
			);

			emitToRoom(code, "ai-ready", {
				summary: aiResult?.summary || null,
				category: aiResult?.category || null,
				suggestedName: aiResult?.suggestedName || null,
			});

			logEvent("AI complete", {
				code,
				aiReady: Boolean(aiResult),
			});
		})();

		return res.status(200).json({
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
		});
	} catch (error) {
		console.error("Upload failed:", error.message);
		return res.status(500).json({
			success: false,
			error: "UPLOAD_FAILED",
		});
	}
});

module.exports = router;

