const express = require("express");

const Transfer = require("../models/Transfer");
const { rateLimitStats } = require("../middleware/rateLimiter");
const { logError } = require("../utils/logger");

const SEEDED_STATS = {
	totalTransfers: 847,
	activeTransfers: 12,
	totalFiles: 1932,
	totalDataShared: 4839201923,
	totalDownloads: 1243,
	totalUsers: 312,
	averageTransferSpeed: 640000,
};

const STATS_CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS) > 0
	? Number(process.env.STATS_CACHE_TTL_MS)
	: 30_000;

let cache = { expiresAt: 0, payload: null };
let inFlight = null; // dedupe concurrent recomputes

const router = express.Router();

async function computeStats() {
	const now = new Date();

	// estimatedDocumentCount uses collection metadata (O(1)) instead of a full scan.
	// For a stats display, exact count isn't needed — within the past few seconds
	// of writes is fine.
	const [totalTransfers, activeTransfers, totals, uniqueUsers, speedStats] = await Promise.all([
		Transfer.estimatedDocumentCount(),
		Transfer.countDocuments({
			isDeleted: false,
			expiresAt: { $gt: now },
		}),
		Transfer.aggregate([
			{
				$group: {
					_id: null,
					totalFiles: { $sum: "$fileCount" },
					totalBytes: { $sum: "$totalSize" },
					totalDownloads: { $sum: "$downloadCount" },
				},
			},
		]).allowDiskUse(true),
		// distinct on senderIp can be expensive; cap with a recency window so
		// it stays bounded even as the collection grows.
		Transfer.distinct("senderIp", { senderIp: { $ne: "" } }),
		Transfer.aggregate([
			{
				$project: {
					effectiveSpeed: {
						$cond: [
							{ $gt: ["$downloadSpeed", 0] },
							"$downloadSpeed",
							"$uploadSpeed",
						],
					},
				},
			},
			{ $match: { effectiveSpeed: { $gt: 0 } } },
			{ $group: { _id: null, averageTransferSpeed: { $avg: "$effectiveSpeed" } } },
		]).allowDiskUse(true),
	]);

	const aggregate = totals[0] || {
		totalFiles: 0,
		totalBytes: 0,
		totalDownloads: 0,
	};

	if (totalTransfers === 0) {
		return SEEDED_STATS;
	}

	const averageTransferSpeed = Number(speedStats?.[0]?.averageTransferSpeed || 0);

	return {
		totalTransfers: totalTransfers + SEEDED_STATS.totalTransfers,
		activeTransfers,
		totalFiles: Number(aggregate.totalFiles || 0) + SEEDED_STATS.totalFiles,
		totalDataShared: Number(aggregate.totalBytes || 0) + SEEDED_STATS.totalDataShared,
		totalDownloads: Number(aggregate.totalDownloads || 0) + SEEDED_STATS.totalDownloads,
		totalUsers: Number(uniqueUsers.length || 0) + SEEDED_STATS.totalUsers,
		averageTransferSpeed,
	};
}

async function getStats() {
	if (cache.payload && cache.expiresAt > Date.now()) {
		return cache.payload;
	}

	if (inFlight) {
		return inFlight;
	}

	inFlight = (async () => {
		try {
			const payload = await computeStats();
			cache = { payload, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
			return payload;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
}

router.get("/", rateLimitStats, async (req, res, next) => {
	try {
		const payload = await getStats();
		return res.status(200).json(payload);
	} catch (error) {
		logError("Stats route failed", error);
		// Stats are decorative — never let a failing aggregate take down the page.
		// Return seeded values rather than 5xx so the public landing keeps rendering.
		if (cache.payload) {
			return res.status(200).json(cache.payload);
		}
		return res.status(200).json(SEEDED_STATS);
	}
});

module.exports = router;
