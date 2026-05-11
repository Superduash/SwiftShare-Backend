const cron = require("node-cron");

const Transfer = require("../models/Transfer");
const { deleteFilesFromR2 } = require("./fileManager");
const { clearTransferCountdown, emitToRoom } = require("../config/socket");
const { logEvent, logError, logWarn } = require("../utils/logger");
const { isMemoryPressure } = require("../utils/performance");

// ── R2 Lifecycle Rule Requirement ─────────────────────────────────────────────
// IMPORTANT: This cleanup job only deletes R2 objects it can find in MongoDB.
// If a user closes their tab mid-upload, the R2 object may be written but the
// MongoDB record may never be created — leaving an orphaned file that this job
// will never find or delete.
//
// REQUIRED INFRASTRUCTURE STEP (do before launch):
//   Go to Cloudflare R2 Dashboard → Your Bucket → Settings → Lifecycle Rules
//   Add rule: Delete objects older than 1 day (prefix: "transfers/")
//   This acts as an absolute fail-safe for all orphaned uploads.
//
// Set R2_LIFECYCLE_CONFIGURED=true in your .env once the rule is applied.
// ─────────────────────────────────────────────────────────────────────────────

let cleanupTask;
let isCleanupRunning = false;
const BURN_IDLE_FINALIZE_MS = Number(process.env.BURN_IDLE_FINALIZE_MS || (2 * 60 * 1000));

// Dynamic batch sizing based on memory pressure
function getCleanupBatchSize() {
	if (isMemoryPressure()) {
		return 25; // Reduce batch size under memory pressure
	}
	return Number(process.env.CLEANUP_BATCH_SIZE) > 0
		? Number(process.env.CLEANUP_BATCH_SIZE)
		: 50;
}

// Dynamic parallelism based on memory pressure
function getCleanupParallelism() {
	if (isMemoryPressure()) {
		return 2; // Reduce parallelism under memory pressure
	}
	return Number(process.env.CLEANUP_PARALLELISM) > 0
		? Number(process.env.CLEANUP_PARALLELISM)
		: 4;
}

// Run a list of async tasks with bounded concurrency. Prevents the cleanup job
// from spawning unbounded promises if hundreds of transfers expire at once
// (which would saturate R2 connections and OOM the 512MB Render dyno).
async function runWithConcurrency(items, worker, concurrency) {
	const results = [];
	let cursor = 0;
	const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (cursor < items.length) {
			const idx = cursor++;
			try {
				results[idx] = await worker(items[idx]);
			} catch (err) {
				results[idx] = { error: err };
			}
		}
	});
	await Promise.all(runners);
	return results;
}

async function expireOne(transfer) {
	try {
		await deleteFilesFromR2(transfer.files);
	} catch (err) {
		// Even if R2 delete fails, we still mark the doc deleted so it stops
		// appearing in nearby/active queries. Orphaned R2 objects will be
		// reaped on the next bucket lifecycle policy or manual sweep.
		logError("Cleanup R2 delete failed (marking deleted anyway)", err, `CODE: ${transfer.code}`);
	}
	try {
		await Transfer.updateOne(
			{ _id: transfer._id, isDeleted: false },
			{ $set: { isDeleted: true } },
		);
	} catch (err) {
		logError("Cleanup mark-deleted failed", err, `CODE: ${transfer.code}`);
	}
	clearTransferCountdown(transfer.code);
}

async function finalizeStaleBurn(transfer) {
	try {
		await deleteFilesFromR2(transfer.files);
	} catch (err) {
		logError("Burn cleanup R2 delete failed", err, `CODE: ${transfer.code}`);
	}
	const finalizedAt = new Date();
	try {
		await Transfer.updateOne(
			{ _id: transfer._id, isDeleted: false },
			{
				$set: {
					isDeleted: true,
					burnFinalizedAt: finalizedAt,
				},
				$push: {
					activity: {
						$each: [{
							event: "burned",
							device: "System",
							ip: "",
							timestamp: finalizedAt,
						}],
						$slice: -200,
					},
				},
			},
		);
	} catch (err) {
		logError("Burn cleanup update failed", err, `CODE: ${transfer.code}`);
	}
	clearTransferCountdown(transfer.code);
	emitToRoom(transfer.code, "transfer-deleted", { code: transfer.code, status: "DELETED", reason: "burn" });
}

async function runCleanup() {
	// Re-entrancy guard: if a previous run is still going (e.g. R2 outage made it slow),
	// skip rather than pile up overlapping passes.
	if (isCleanupRunning) {
		logEvent("Cleanup skipped (previous pass still running)");
		return;
	}
	isCleanupRunning = true;

	try {
		const now = new Date();
		const batchSize = getCleanupBatchSize();
		const parallelism = getCleanupParallelism();

		// Use lean() — we only need _id, code, and files.storedKey for cleanup.
		// Full Mongoose hydration on hundreds of expired docs is wasteful.
		// Use projection to only select needed fields for better performance
		const expiredTransfers = await Transfer.find(
			{
				expiresAt: { $lt: now },
				isDeleted: false,
			},
			{ code: 1, files: 1 }, // Projection: only select needed fields
		)
			.limit(batchSize)
			.lean();

		await runWithConcurrency(expiredTransfers, expireOne, parallelism);

		const burnFinalizeCutoff = new Date(Date.now() - BURN_IDLE_FINALIZE_MS);
		const staleClaimedTransfers = await Transfer.find(
			{
				burnAfterDownload: true,
				isDeleted: false,
				burnClaimOwner: { $exists: true, $nin: ["", null] },
				burnLastActiveAt: { $lt: burnFinalizeCutoff },
				expiresAt: { $gt: now },
			},
			{ code: 1, files: 1 }, // Projection: only select needed fields
		)
			.limit(batchSize)
			.lean();

		await runWithConcurrency(staleClaimedTransfers, finalizeStaleBurn, parallelism);

		logEvent(
			`Cleanup job removed ${expiredTransfers.length} expired transfers and finalized ${staleClaimedTransfers.length} stale burn sessions`,
			`BATCH_SIZE: ${batchSize}`,
			`PARALLELISM: ${parallelism}`,
		);
	} catch (error) {
		logError("Cleanup job failed", error);
	} finally {
		isCleanupRunning = false;
	}
}

function startCleanupJob() {
	if (cleanupTask) {
		return cleanupTask;
	}

	// Warn operators if the R2 lifecycle rule hasn't been confirmed yet.
	// This is a one-time infrastructure step — see comment at top of file.
	if (String(process.env.R2_LIFECYCLE_CONFIGURED || "").toLowerCase() !== "true") {
		logWarn(
			"R2 bucket lifecycle rule not confirmed",
			"Set R2_LIFECYCLE_CONFIGURED=true in .env after adding a 1-day auto-delete rule in the Cloudflare R2 dashboard.",
			"Without this, orphaned uploads from aborted sessions will accumulate and inflate your R2 bill.",
		);
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
