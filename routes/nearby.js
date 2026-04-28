const express = require("express");

const Transfer = require("../models/Transfer");
const { getClientIp, getSubnet } = require("../utils/helpers");
const { logEvent } = require("../utils/logger");
const { rateLimitMetadata } = require("../middleware/rateLimiter");

const router = express.Router();

// Debug endpoint to check IP detection and subnet matching
router.get("/debug", rateLimitMetadata, async (req, res, next) => {
	try {
		const clientIp = getClientIp(req);
		const subnet = getSubnet(clientIp);
		const now = new Date();

		// Get all active transfers with their IPs
		const allTransfers = await Transfer.find(
			{
				isDeleted: false,
				expiresAt: { $gt: now },
			},
			{
				code: 1,
				senderIp: 1,
				senderDeviceName: 1,
				senderSocketId: 1,
				createdAt: 1,
			},
		)
			.sort({ createdAt: -1 })
			.limit(50)
			.lean();

		// Calculate subnet for each transfer
		const transfersWithSubnets = allTransfers.map((t) => ({
			code: t.code,
			senderIp: t.senderIp,
			subnet: getSubnet(t.senderIp || ""),
			deviceName: t.senderDeviceName,
			socketId: t.senderSocketId,
			matchesYourSubnet: subnet && getSubnet(t.senderIp || "") === subnet,
		}));

		return res.status(200).json({
			debug: true,
			yourIp: clientIp,
			yourSubnet: subnet || "INVALID",
			subnetValid: Boolean(subnet),
			headers: {
				"x-forwarded-for": req.headers["x-forwarded-for"] || null,
				"x-real-ip": req.headers["x-real-ip"] || null,
				remoteAddress: req.socket?.remoteAddress || null,
			},
			allActiveTransfers: transfersWithSubnets,
			matchingTransfers: transfersWithSubnets.filter((t) => t.matchesYourSubnet),
			totalActive: allTransfers.length,
			matchingCount: transfersWithSubnets.filter((t) => t.matchesYourSubnet).length,
		});
	} catch (error) {
		return next(error);
	}
});

router.get("/", rateLimitMetadata, async (req, res, next) => {
	try {
		const clientIp = getClientIp(req);
		const subnet = getSubnet(clientIp);
		const requesterSocketId = String(req.query?.socketId || "").trim();
		logEvent("Nearby request", `IP: ${clientIp || "unknown"}`, `SUBNET: ${subnet || "n/a"}`);

		if (!subnet) {
			return res.status(200).json({ devices: [] });
		}

		const now = new Date();
		const candidates = await Transfer.find(
			{
				isDeleted: false,
				expiresAt: { $gt: now },
				senderIp: { $regex: `^${subnet.replace(/\./g, "\\.")}\\.` },
			},
			{
				code: 1,
				fileCount: 1,
				files: 1,
				totalSize: 1,
				"ai.category": 1,
				senderDeviceName: 1,
				expiresAt: 1,
				senderSocketId: 1,
				createdAt: 1,
			},
		)
			.sort({ createdAt: -1 })
			.limit(20)
			.lean();

		return res.status(200).json({
			devices: candidates
				.map((transfer) => ({
					code: transfer.code,
					fileCount: Number(transfer.fileCount || transfer.files?.length || 0),
					totalSize: Number(transfer.totalSize || 0),
					category: transfer.ai?.category || "Other",
					deviceName: transfer.senderDeviceName || "Unknown Device",
					expiresAt: transfer.expiresAt,
					socketId: String(transfer.senderSocketId || ""),
				}))
				.filter((device) => {
					if (!requesterSocketId) return true;
					if (!device.socketId) return true;
					return device.socketId !== requesterSocketId;
				}),
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

