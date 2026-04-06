const cron = require("node-cron");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");

const Transfer = require("../models/Transfer");
const { r2Client, r2Bucket } = require("../config/r2");
const { logEvent, logError } = require("../utils/logger");

let cleanupTask;

async function deleteTransferFilesFromR2(files) {
	await Promise.all(
		(files || []).map(async (file) => {
			try {
				await r2Client.send(
					new DeleteObjectCommand({
						Bucket: r2Bucket,
						Key: file.storedKey,
					}),
				);
			} catch (error) {
				console.error(`Cleanup delete failed for ${file.storedKey}: ${error.message}`);
			}
		}),
	);
}

async function runCleanup() {
	try {
		const now = new Date();
		const expiredTransfers = await Transfer.find({
			expiresAt: { $lt: now },
			isDeleted: false,
		});

		for (const transfer of expiredTransfers) {
			await deleteTransferFilesFromR2(transfer.files);
			transfer.isDeleted = true;
			await transfer.save();
		}

		logEvent(`Cleanup job removed ${expiredTransfers.length} expired transfers`);
	} catch (error) {
		logError("Cleanup job failed", error);
	}
}

function startCleanupJob() {
	if (cleanupTask) {
		return cleanupTask;
	}

	cleanupTask = cron.schedule("*/5 * * * *", () => {
		void runCleanup();
	});

	logEvent("Cleanup job running", "schedule: every 5 minutes");

	return cleanupTask;
}

module.exports = {
	startCleanupJob,
	runCleanup,
};

