const express = require("express");

const Transfer = require("../models/Transfer");
const { getClientIp, getSubnet } = require("../utils/helpers");
const { logEvent } = require("../utils/logger");

const router = express.Router();

router.get("/", async (req, res, next) => {
	try {
		const clientIp = getClientIp(req);
		const subnet = getSubnet(clientIp);
		logEvent("Nearby request", `IP: ${clientIp || "unknown"}`, `SUBNET: ${subnet || "n/a"}`);

		if (!subnet) {
			return res.status(200).json({ devices: [] });
		}

		const now = new Date();
		const candidates = await Transfer.find({
			isDeleted: false,
			expiresAt: { $gt: now },
			senderIp: { $regex: `^${subnet.replace(/\./g, "\\.")}\\.` },
		})
			.sort({ createdAt: -1 })
			.limit(20)
			.lean();

		return res.status(200).json({
			devices: candidates.map((transfer) => ({
				code: transfer.code,
				fileCount: Number(transfer.fileCount || transfer.files?.length || 0),
				totalSize: Number(transfer.totalSize || 0),
				category: transfer.ai?.category || "Other",
				deviceName: transfer.senderDeviceName || "Unknown Device",
				expiresAt: transfer.expiresAt,
			})),
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

