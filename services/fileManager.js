const {
	PutObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

const { r2Client, r2Bucket, isR2Configured } = require("../config/r2");
const { logError, logEvent } = require("../utils/logger");

function assertR2Configured() {
	if (isR2Configured && r2Client && r2Bucket) {
		return;
	}

	const error = new Error("R2 storage is not configured");
	error.status = 503;
	error.errorCode = "SERVER_ERROR";
	throw error;
}

// Errors that are safe to retry. Network blips and 5xx are retryable;
// 4xx (NoSuchKey, AccessDenied, etc.) are not.
const RETRYABLE_AWS_CODES = new Set([
	"RequestTimeout",
	"RequestTimeoutException",
	"PriorRequestNotComplete",
	"ConnectionError",
	"NetworkingError",
	"TimeoutError",
	"ThrottlingException",
	"Throttling",
	"InternalError",
	"InternalFailure",
	"ServiceUnavailable",
	"SlowDown",
]);

const RETRYABLE_NODE_CODES = new Set([
	"ECONNRESET",
	"ENOTFOUND",
	"ETIMEDOUT",
	"EPIPE",
	"ECONNREFUSED",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"UND_ERR_SOCKET",
]);

function isRetryableError(err) {
	if (!err) return false;
	const status = Number(err?.$metadata?.httpStatusCode || err?.statusCode || 0);
	if (status >= 500 && status < 600) return true;
	if (status === 408 || status === 429) return true;
	const name = String(err?.name || "");
	if (RETRYABLE_AWS_CODES.has(name)) return true;
	const code = String(err?.code || err?.Code || "");
	if (RETRYABLE_AWS_CODES.has(code)) return true;
	if (RETRYABLE_NODE_CODES.has(code)) return true;
	return false;
}

async function withRetry(operationName, fn, { maxAttempts = 3, baseDelayMs = 200 } = {}) {
	let lastError;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await fn(attempt);
		} catch (err) {
			lastError = err;
			if (attempt >= maxAttempts || !isRetryableError(err)) {
				throw err;
			}
			// Exponential backoff with full jitter, capped at 2s.
			const exp = Math.min(2000, baseDelayMs * Math.pow(2, attempt - 1));
			const delay = Math.floor(Math.random() * exp);
			logEvent(
				`R2 ${operationName} retry`,
				`ATTEMPT: ${attempt}/${maxAttempts}`,
				`DELAY_MS: ${delay}`,
				`ERR: ${err?.name || err?.code || "unknown"}`,
			);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

async function uploadFileToR2(buffer, key, mimeType) {
	assertR2Configured();

	return withRetry("PutObject", () =>
		r2Client.send(
			new PutObjectCommand({
				Bucket: r2Bucket,
				Key: key,
				Body: buffer,
				ContentType: mimeType,
			}),
		),
	);
}

async function streamFileFromR2(key, options = {}) {
	assertR2Configured();
	const range = typeof options?.range === "string" ? options.range.trim() : "";

	// Retry only the request initiation. Once the stream begins, errors mid-flight
	// must surface to the caller — a partial stream cannot be safely re-issued.
	return withRetry("GetObject", () =>
		r2Client.send(
			new GetObjectCommand({
				Bucket: r2Bucket,
				Key: key,
				...(range ? { Range: range } : {}),
			}),
		),
	);
}

async function headFileFromR2(key) {
	assertR2Configured();

	return withRetry("HeadObject", () =>
		r2Client.send(
			new HeadObjectCommand({
				Bucket: r2Bucket,
				Key: key,
			}),
		),
	);
}

async function deleteFileFromR2(key) {
	assertR2Configured();

	await withRetry("DeleteObject", () =>
		r2Client.send(
			new DeleteObjectCommand({
				Bucket: r2Bucket,
				Key: key,
			}),
		),
	);
}

async function deleteMultipleFilesFromR2(keys = []) {
	if (!Array.isArray(keys) || keys.length === 0) {
		return;
	}

	assertR2Configured();

	// Use S3 batch DeleteObjects (single API call for up to 1000 keys) instead of
	// N parallel DeleteObject calls. Falls back to per-key delete if batch fails.
	const valid = keys.filter(Boolean);
	if (valid.length === 0) return;

	const batches = [];
	for (let i = 0; i < valid.length; i += 1000) {
		batches.push(valid.slice(i, i + 1000));
	}

	for (const batch of batches) {
		try {
			await withRetry("DeleteObjects", () =>
				r2Client.send(
					new DeleteObjectsCommand({
						Bucket: r2Bucket,
						Delete: {
							Objects: batch.map((Key) => ({ Key })),
							Quiet: true,
						},
					}),
				),
			);
		} catch (error) {
			logError("R2 batch delete failed; falling back to per-key", error);
			await Promise.all(
				batch.map(async (key) => {
					try {
						await deleteFileFromR2(key);
					} catch (err) {
						logError("R2 delete failed", err, `KEY: ${key}`);
					}
				}),
			);
		}
	}
}

async function deleteFilesFromR2(files = []) {
	if (!Array.isArray(files) || files.length === 0) {
		return;
	}

	const keys = files.map((file) => file?.storedKey).filter(Boolean);
	await deleteMultipleFilesFromR2(keys);
}

async function uploadBufferToR2({ key, body, contentType }) {
	return uploadFileToR2(body, key, contentType);
}

async function getObjectFromR2(key, options = {}) {
	return streamFileFromR2(key, options);
}

async function getObjectHeadFromR2(key) {
	return headFileFromR2(key);
}

async function deleteObjectFromR2(key) {
	return deleteFileFromR2(key);
}

module.exports = {
	uploadFileToR2,
	streamFileFromR2,
	deleteFileFromR2,
	deleteMultipleFilesFromR2,
	uploadBufferToR2,
	getObjectFromR2,
	getObjectHeadFromR2,
	deleteObjectFromR2,
	deleteFilesFromR2,
	withRetry,
	isRetryableError,
};
