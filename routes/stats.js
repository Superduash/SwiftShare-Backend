const express = require("express");

const Transfer = require("../models/Transfer");
const { rateLimitStats } = require("../middleware/rateLimiter");
const { logError } = require("../utils/logger");

const EMPTY_STATS = {
	totalTransfers: 0,
	activeTransfers: 0,
	totalFiles: 0,
	totalDataShared: 0,
	totalDownloads: 0,
	totalUsers: 0,
	averageTransferSpeed: 0,
};

const STATS_CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS) > 0
	? Number(process.env.STATS_CACHE_TTL_MS)
	: 30_000;

let cache = { expiresAt: 0, payload: null };
let inFlight = null; // dedupe concurrent recomputes

const router = express.Router();

router.use((req, res, next) => {
	res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
	next();
});

async function computeStats() {
	const now = new Date();

	// estimatedDocumentCount uses collection metadata (O(1)) instead of a full scan.
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
		Transfer.distinct("senderIp", { 
			senderIp: { $ne: "" },
			createdAt: { $gte: new Date(now - 30 * 24 * 60 * 60 * 1000) }
		}),
		Transfer.aggregate([
			{
				$match: {
					$or: [
						{ downloadSpeed: { $gt: 0 } },
						{ uploadSpeed: { $gt: 0 } },
					],
				},
			},
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
			{ $group: { _id: null, averageTransferSpeed: { $avg: "$effectiveSpeed" } } },
		]).allowDiskUse(true),
	]);

	const aggregate = totals[0] || {
		totalFiles: 0,
		totalBytes: 0,
		totalDownloads: 0,
	};

	const averageTransferSpeed = Number(speedStats?.[0]?.averageTransferSpeed || 0);

	return {
		totalTransfers: Number(totalTransfers || 0),
		activeTransfers: Number(activeTransfers || 0),
		totalFiles: Number(aggregate.totalFiles || 0),
		totalDataShared: Number(aggregate.totalBytes || 0),
		totalDownloads: Number(aggregate.totalDownloads || 0),
		totalUsers: Number(uniqueUsers.length || 0),
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
		if (cache.payload) {
			return res.status(200).json(cache.payload);
		}
		return res.status(200).json(EMPTY_STATS);
	}
});

module.exports = router;
