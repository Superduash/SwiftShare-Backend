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

async function uploadBufferToR2({ key, body, contentType }) {
	assertR2Configured();

	await r2Client.send(
		new PutObjectCommand({
			Bucket: r2Bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
		}),
	);
}

async function getObjectFromR2(key) {
	assertR2Configured();

	return r2Client.send(
		new GetObjectCommand({
			Bucket: r2Bucket,
			Key: key,
		}),
	);
}

async function deleteObjectFromR2(key) {
	assertR2Configured();

	await r2Client.send(
		new DeleteObjectCommand({
			Bucket: r2Bucket,
			Key: key,
		}),
	);
}

async function deleteFilesFromR2(files = []) {
	if (!Array.isArray(files) || files.length === 0) {
		return;
	}

	assertR2Configured();

	await Promise.all(
		files.map(async (file) => {
			const key = file?.storedKey;
			if (!key) {
				return;
			}

			try {
				await deleteObjectFromR2(key);
			} catch (error) {
				logError("R2 delete failed", error, `KEY: ${key}`);
			}
		}),
	);
}

module.exports = {
	uploadBufferToR2,
	getObjectFromR2,
	deleteObjectFromR2,
	deleteFilesFromR2,
};

