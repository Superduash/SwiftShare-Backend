const path = require("path");
const { getTotalSize } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

const BLOCKED_EXTENSIONS = new Set([".exe", ".bat", ".sh", ".cmd"]);

function getMaxFileSizeBytes() {
	const maxSizeMb = Number(process.env.MAX_FILE_SIZE_MB);
	const safeMb = Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : 500;
	return safeMb * 1024 * 1024;
}

function getMaxFileCount() {
	const maxCount = Number(process.env.MAX_FILE_COUNT);
	return Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 10;
}

function sendUploadError(res, code) {
	return res.status(400).json(buildErrorResponse(code));
}

function validateUpload(req, res, next) {
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

		const hasBlockedFileType = files.some((file) => {
			const extension = path.extname(file.originalname || "").toLowerCase();
			return BLOCKED_EXTENSIONS.has(extension);
		});

		if (hasBlockedFileType) {
			return sendUploadError(res, ERROR_CODES.INVALID_FILE_TYPE);
		}

		return next();
	} catch (error) {
		return res.status(500).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR));
	}
}

module.exports = {
	validateUpload,
};

