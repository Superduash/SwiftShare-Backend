const express = require("express");

const Transfer = require("../models/Transfer");
const { rateLimitStats } = require("../middleware/rateLimiter");

const SEEDED_STATS = {
	totalTransfers: 847,
	activeTransfers: 12,
	totalFiles: 1932,
	totalBytes: 4839201923,
	fakeDownloads: 1243,
	fakeUsers: 312,
};

const router = express.Router();

router.get("/", rateLimitStats, async (req, res, next) => {
	try {
		const now = new Date();

		const [totalTransfers, activeTransfers, totals] = await Promise.all([
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
					},
				},
			]),
		]);

		const aggregate = totals[0] || { totalFiles: 0, totalBytes: 0 };

		if (totalTransfers === 0) {
			return res.status(200).json(SEEDED_STATS);
		}

		return res.status(200).json({
			totalTransfers,
			activeTransfers,
			totalFiles: aggregate.totalFiles,
			totalBytes: aggregate.totalBytes,
			fakeDownloads: 1243,
			fakeUsers: 312,
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

