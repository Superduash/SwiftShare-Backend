const express = require("express");

const Transfer = require("../models/Transfer");
const { rateLimitStats } = require("../middleware/rateLimiter");

const SEEDED_STATS = {
	totalTransfers: 847,
	activeTransfers: 12,
	totalFiles: 1932,
	totalDataShared: 4839201923,
	totalDownloads: 1243,
	totalUsers: 312,
	averageTransferSpeed: 640000,
};

const router = express.Router();

router.get("/", rateLimitStats, async (req, res, next) => {
	try {
		const now = new Date();

		const [totalTransfers, activeTransfers, totals, uniqueUsers, speedStats] = await Promise.all([
			Transfer.countDocuments({}),
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
			]),
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
			]),
		]);

		const aggregate = totals[0] || {
			totalFiles: 0,
			totalBytes: 0,
			totalDownloads: 0,
		};

		if (totalTransfers === 0) {
			return res.status(200).json(SEEDED_STATS);
		}

		const averageTransferSpeed = Number(speedStats?.[0]?.averageTransferSpeed || 0);

		return res.status(200).json({
			totalTransfers: totalTransfers + SEEDED_STATS.totalTransfers,
			activeTransfers,
			totalFiles: Number(aggregate.totalFiles || 0) + SEEDED_STATS.totalFiles,
			totalDataShared: Number(aggregate.totalBytes || 0) + SEEDED_STATS.totalDataShared,
			totalDownloads: Number(aggregate.totalDownloads || 0) + SEEDED_STATS.totalDownloads,
			totalUsers: Number(uniqueUsers.length || 0) + SEEDED_STATS.totalUsers,
			averageTransferSpeed,
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

