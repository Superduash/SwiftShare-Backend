const {
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const { r2Client, r2Bucket, isR2Configured } = require("../config/r2");
const { logError } = require("../utils/logger");

function assertR2Configured() {
	if (isR2Configured && r2Client && r2Bucket) {
		return;
	}

	const error = new Error("R2 storage is not configured");
	error.status = 503;
	error.errorCode = "SERVER_ERROR";
	throw error;
}

async function uploadFileToR2(buffer, key, mimeType) {
	assertR2Configured();

	await r2Client.send(
		new PutObjectCommand({
			Bucket: r2Bucket,
			Key: key,
			Body: buffer,
			ContentType: mimeType,
		}),
	);
}

async function streamFileFromR2(key) {
	assertR2Configured();

	return r2Client.send(
		new GetObjectCommand({
			Bucket: r2Bucket,
			Key: key,
		}),
	);
}

async function deleteFileFromR2(key) {
	assertR2Configured();

	await r2Client.send(
		new DeleteObjectCommand({
			Bucket: r2Bucket,
			Key: key,
		}),
	);
}

async function deleteMultipleFilesFromR2(keys = []) {
	if (!Array.isArray(keys) || keys.length === 0) {
		return;
	}

	assertR2Configured();

	await Promise.all(
		keys.map(async (key) => {
			if (!key) {
				return;
			}

			try {
				await deleteFileFromR2(key);
			} catch (error) {
				logError("R2 delete failed", error, `KEY: ${key}`);
			}
		}),
	);
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

async function getObjectFromR2(key) {
	return streamFileFromR2(key);
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
	deleteObjectFromR2,
	deleteFilesFromR2,
};

