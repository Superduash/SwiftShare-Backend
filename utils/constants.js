const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 500;
const MAX_FILE_COUNT = Number(process.env.MAX_FILE_COUNT) || 10;
const SESSION_EXPIRY_MINUTES = Number(process.env.SESSION_EXPIRY_MINUTES) || 10;
const CODE_LENGTH = Number(process.env.CODE_LENGTH) || 6;

const ERROR_CODES = {
	FILE_TOO_LARGE: "FILE_TOO_LARGE",
	TOO_MANY_FILES: "TOO_MANY_FILES",
	INVALID_FILE_TYPE: "INVALID_FILE_TYPE",
	NO_FILE_UPLOADED: "NO_FILE_UPLOADED",
	TRANSFER_NOT_FOUND: "TRANSFER_NOT_FOUND",
	TRANSFER_EXPIRED: "TRANSFER_EXPIRED",
	ALREADY_DOWNLOADED: "ALREADY_DOWNLOADED",
	INVALID_CODE: "INVALID_CODE",
	RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
	SERVER_ERROR: "SERVER_ERROR",
	// Backward compatibility aliases for already-written route logic.
	BLOCKED_FILE_TYPE: "INVALID_FILE_TYPE",
	CODE_NOT_FOUND: "TRANSFER_NOT_FOUND",
};

const ERROR_MESSAGES = {
	[ERROR_CODES.FILE_TOO_LARGE]: `File exceeds ${MAX_FILE_SIZE_MB}MB limit`,
	[ERROR_CODES.TOO_MANY_FILES]: `Too many files. Maximum ${MAX_FILE_COUNT} files allowed`,
	[ERROR_CODES.INVALID_FILE_TYPE]: "File type is not allowed",
	[ERROR_CODES.NO_FILE_UPLOADED]: "No file uploaded",
	[ERROR_CODES.TRANSFER_NOT_FOUND]: "Transfer not found",
	[ERROR_CODES.TRANSFER_EXPIRED]: "Transfer has expired",
	[ERROR_CODES.ALREADY_DOWNLOADED]: "Transfer already downloaded",
	[ERROR_CODES.INVALID_CODE]: "Invalid transfer code",
	[ERROR_CODES.RATE_LIMIT_EXCEEDED]: "Rate limit exceeded",
	[ERROR_CODES.SERVER_ERROR]: "Internal server error",
};

const CODE_REGEX = new RegExp(`^[A-Z2-9]{${CODE_LENGTH}}$`);

function buildErrorResponse(code, message) {
	return {
		success: false,
		error: {
			code,
			message: message || ERROR_MESSAGES[code] || ERROR_MESSAGES[ERROR_CODES.SERVER_ERROR],
		},
	};
}

module.exports = {
	MAX_FILE_SIZE_MB,
	MAX_FILE_COUNT,
	SESSION_EXPIRY_MINUTES,
	CODE_LENGTH,
	ERROR_CODES,
	ERROR_MESSAGES,
	CODE_REGEX,
	buildErrorResponse,
};

