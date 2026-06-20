const express = require("express");

const Transfer = require("../models/Transfer");
const { getClientIp, getSubnet } = require("../utils/helpers");
const { sanitizeString } = require("../middleware/inputValidator");
const { logEvent } = require("../utils/logger");
const { rateLimitMetadata } = require("../middleware/rateLimiter");
const { buildErrorResponse, ERROR_CODES } = require("../utils/constants");
const { getIo } = require("../config/socket");

const router = express.Router();

router.use((req, res, next) => {
	res.setHeader('Cache-Control', 'no-store');
	next();
});

// Debug endpoint to check IP detection and subnet matching (dev only)
router.get("/debug", rateLimitMetadata, async (req, res, next) => {
	// Block debug endpoint in production
	if (process.env.NODE_ENV === "production") {
		return res.status(404).json(buildErrorResponse(ERROR_CODES.ROUTE_NOT_FOUND));
	}
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
		const requesterSocketId = sanitizeString(String(req.query?.socketId || "").trim(), 100);
		logEvent("Nearby request", `IP: ${clientIp || "unknown"}`, `SUBNET: ${subnet || "n/a"}`);

		if (!subnet) {
			return res.status(200).json({ devices: [] });
		}

		const now = new Date();

		const io = getIo();
		const subnetRoom = `subnet:${subnet}`;
		// Subnet-first: get connected socket IDs from the subnet room, then query only
		// those transfers. Removes global limit dependency entirely.
		// Always fetch fresh room members to avoid stale socket references
		const sockets = await io?.in(subnetRoom).fetchSockets();
		const socketsInSubnet = sockets && Array.isArray(sockets)
			? new Set(sockets.map((s) => s?.id).filter(Boolean))
			: new Set();

		if (socketsInSubnet.size === 0) {
			return res.status(200).json({ devices: [] });
		}

		const socketIdArray = Array.from(socketsInSubnet);
		const candidates = await Transfer.find(
			{
				isDeleted: false,
				expiresAt: { $gt: now },
				senderSocketId: { $in: socketIdArray },
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
			},
		).lean();

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
				})
				.slice(0, 20),
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

