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
			return res.status(200).json({ transfers: [] });
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
			transfers: candidates.map((transfer) => ({
				code: transfer.code,
				fileName: transfer.files?.[0]?.originalName || "Unknown",
				fileSize: transfer.files?.[0]?.size || 0,
				deviceName: transfer.senderDeviceName || "Unknown Device",
				createdAt: transfer.createdAt,
			})),
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

