const {
	getTotalSize,
	isBlockedExtension,
	hasDangerousSignature,
} = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

const BLOCKED_DETECTED_EXTENSIONS = new Set([
	".exe",
	".bat",
	".sh",
	".cmd",
	".msi",
	".scr",
	".com",
	".vbs",
	".ps1",
	".jar",
]);

let fileTypeModulePromise;

async function fileTypeFromBufferSafe(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
		return null;
	}

	if (!fileTypeModulePromise) {
		fileTypeModulePromise = import("file-type");
	}

	const fileTypeModule = await fileTypeModulePromise;
	return fileTypeModule.fileTypeFromBuffer(buffer);
}

function isMimeCompatible(declaredMime, detectedMime) {
	const declared = String(declaredMime || "").toLowerCase();
	const detected = String(detectedMime || "").toLowerCase();

	if (!declared || !detected) {
		return true;
	}

	if (declared === detected) {
		return true;
	}

	if (declared === "application/octet-stream") {
		return true;
	}

	const declaredFamily = declared.split("/")[0];
	const detectedFamily = detected.split("/")[0];
	if (declaredFamily && declaredFamily === detectedFamily) {
		return true;
	}

	if (declared.includes("xml") && detected.includes("xml")) {
		return true;
	}

	return false;
}

async function validateMimeIntegrity(files) {
	for (const file of files) {
		if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) {
			continue;
		}

		const detected = await fileTypeFromBufferSafe(file.buffer);
		if (!detected) {
			continue;
		}

		const detectedExt = `.${String(detected.ext || "").toLowerCase()}`;
		if (BLOCKED_DETECTED_EXTENSIONS.has(detectedExt)) {
			return {
				valid: false,
				message: "Executable or script payloads are not allowed",
			};
		}

		const declaredMime = String(file.mimetype || file.mimeType || "").toLowerCase();
		const detectedMime = String(detected.mime || "").toLowerCase();

		if (!isMimeCompatible(declaredMime, detectedMime)) {
			return {
				valid: false,
				message: `MIME mismatch detected (${declaredMime || "unspecified"} vs ${detectedMime})`,
			};
		}
	}

	return { valid: true };
}

function getMaxFileSizeBytes() {
	const maxSizeMb = Number(process.env.MAX_FILE_SIZE_MB);
	const safeMb = Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : 100;
	const cappedMb = Math.min(safeMb, 100);
	return cappedMb * 1024 * 1024;
}

function getMaxFileCount() {
	const maxCount = Number(process.env.MAX_FILE_COUNT);
	return Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 5;
}

function sendUploadError(res, code) {
	return res.status(400).json(buildErrorResponse(code));
}

async function validateUpload(req, res, next) {
	try {
		const files = req.files;

		if (!Array.isArray(files) || files.length === 0) {
			return sendUploadError(res, ERROR_CODES.NO_FILE_UPLOADED);
		}

		if (files.length > getMaxFileCount()) {
			return sendUploadError(res, ERROR_CODES.TOO_MANY_FILES);
		}

		const totalSize = getTotalSize(files);
		if (totalSize > getMaxFileSizeBytes()) {
			return sendUploadError(res, ERROR_CODES.FILE_TOO_LARGE);
		}

		const hasBlockedFileType = files.some((file) => isBlockedExtension(file.originalname));

		if (hasBlockedFileType) {
			return sendUploadError(res, ERROR_CODES.INVALID_FILE_TYPE);
		}

		const hasDangerousFileSignature = files.some((file) => hasDangerousSignature(file.buffer));
		if (hasDangerousFileSignature) {
			return res
				.status(400)
				.json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE, "Executable file signatures are not allowed"));
		}

		const mimeIntegrity = await validateMimeIntegrity(files);
		if (!mimeIntegrity.valid) {
			return res
				.status(400)
				.json(buildErrorResponse(ERROR_CODES.INVALID_FILE_TYPE, mimeIntegrity.message));
		}

		return next();
	} catch (error) {
		return res.status(500).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR));
	}
}

module.exports = {
	validateUpload,
	validateMimeIntegrity,
};

