const cron = require("node-cron");

const Transfer = require("../models/Transfer");
const { deleteFilesFromR2 } = require("./fileManager");
const { logEvent, logError } = require("../utils/logger");

let cleanupTask;

async function runCleanup() {
	try {
		const now = new Date();
		const expiredTransfers = await Transfer.find({
			expiresAt: { $lt: now },
			isDeleted: false,
		});

		for (const transfer of expiredTransfers) {
			await deleteFilesFromR2(transfer.files);
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

