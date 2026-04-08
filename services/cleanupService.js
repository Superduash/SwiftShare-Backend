const cron = require("node-cron");

const Transfer = require("../models/Transfer");
const { deleteFilesFromR2 } = require("./fileManager");
const { clearTransferCountdown, emitToRoom } = require("../config/socket");
const { logEvent, logError } = require("../utils/logger");

let cleanupTask;
const BURN_IDLE_FINALIZE_MS = Number(process.env.BURN_IDLE_FINALIZE_MS || (2 * 60 * 1000));

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
			clearTransferCountdown(transfer.code);
		}

		const burnFinalizeCutoff = new Date(Date.now() - BURN_IDLE_FINALIZE_MS);
		const staleClaimedTransfers = await Transfer.find({
			burnAfterDownload: true,
			isDeleted: false,
			burnClaimOwner: { $exists: true, $nin: ["", null] },
			burnLastActiveAt: { $lt: burnFinalizeCutoff },
			expiresAt: { $gt: now },
		});

		for (const transfer of staleClaimedTransfers) {
			await deleteFilesFromR2(transfer.files);
			transfer.isDeleted = true;
			transfer.burnFinalizedAt = new Date();
			transfer.activity.push({
				event: "burned",
				device: "System",
				ip: "",
				timestamp: new Date(),
			});
			await transfer.save();
			clearTransferCountdown(transfer.code);
			emitToRoom(transfer.code, "transfer-deleted", { code: transfer.code, status: "DELETED", reason: "burn" });
		}

		logEvent(`Cleanup job removed ${expiredTransfers.length} expired transfers and finalized ${staleClaimedTransfers.length} stale burn sessions`);
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

	return cleanupTask;
}

module.exports = {
	startCleanupJob,
	runCleanup,
};

