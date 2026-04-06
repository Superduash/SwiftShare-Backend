const express = require("express");
const multer = require("multer");
const { PutObjectCommand } = require("@aws-sdk/client-s3");

const Transfer = require("../models/Transfer");
const { r2Client, r2Bucket } = require("../config/r2");
const { generateUniqueCode } = require("../services/codeGenerator");
const { generateQR } = require("../services/qrGenerator");
const { validateUpload } = require("../middleware/validateUpload");
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

function getSenderIp(req) {
	const forwarded = req.headers["x-forwarded-for"];

	if (typeof forwarded === "string" && forwarded.length > 0) {
		return forwarded.split(",")[0].trim();
	}

	if (Array.isArray(forwarded) && forwarded.length > 0) {
		return String(forwarded[0]).trim();
	}

	return req.ip || "";
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
		}

		const totalSize = getTotalSize(incomingFiles);
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
			senderIp: getSenderIp(req),
			senderDeviceName: req.get("user-agent") || "Unknown Device",
			qrDataUri: qr,
		});

		const shareLink = `${shareBaseUrl}/g/${code}`;

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

