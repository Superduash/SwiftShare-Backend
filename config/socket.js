const { Server } = require("socket.io");
const mongoose = require("mongoose");
const Transfer = require("../models/Transfer");
const { getSubnet } = require("../utils/helpers");
const { logEvent, logError } = require("../utils/logger");
const { isMongoReady } = require("./db");

let ioInstance;
const countdownMap = new Map();
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const allowAllOrigins = String(process.env.CORS_ALLOW_ALL_ORIGINS || "").toLowerCase() === "true";

function normalizeCode(code) {
	return String(code || "").trim().toUpperCase();
}

function roomName(code) {
	const normalizedCode = normalizeCode(code);
	return normalizedCode ? `room:${normalizedCode}` : "";
}

function parseOrigin(origin) {
	try {
		return new URL(origin);
	} catch {
		return null;
	}
}

function normalizeConfiguredOrigin(origin) {
	const trimmed = String(origin || "").trim();
	if (!trimmed) {
		return "";
	}

	if (trimmed === "*") {
		return "*";
	}

	if (/^(https?:\/\/)?\*\./i.test(trimmed)) {
		return trimmed.replace(/\/+$/, "").toLowerCase();
	}

	const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	return withProtocol.replace(/\/+$/, "").toLowerCase();
}

function getOriginPort(parsed) {
	if (!parsed) {
		return "";
	}

	if (parsed.port) {
		return parsed.port;
	}

	return parsed.protocol === "https:" ? "443" : "80";
}

const ALWAYS_ALLOWED_PLATFORM_SUFFIXES = [
	"netlify.app",
	"onrender.com",
	"vercel.app",
	"pages.dev",
	"web.app",
	"firebaseapp.com",
	"railway.app",
];

function isPlatformDeployOrigin(requestOrigin) {
	const parsed = parseOrigin(requestOrigin);
	if (!parsed) return false;
	const host = String(parsed.hostname || "").toLowerCase();
	if (!host) return false;
	for (const suffix of ALWAYS_ALLOWED_PLATFORM_SUFFIXES) {
		if (host === suffix || host.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

function isLoopbackHost(hostname) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateNetworkHost(hostname) {
	if (!hostname) {
		return false;
	}

	if (/^10\./.test(hostname)) {
		return true;
	}

	if (/^192\.168\./.test(hostname)) {
		return true;
	}

	const match172 = /^172\.(\d{1,3})\./.exec(hostname);
	if (match172) {
		const second = Number(match172[1]);
		return Number.isFinite(second) && second >= 16 && second <= 31;
	}

	return false;
}

function isDevOriginAllowed(origin) {
	const parsed = parseOrigin(origin);
	if (!parsed) {
		return false;
	}

	return isLoopbackHost(parsed.hostname) || isPrivateNetworkHost(parsed.hostname);
}

function originsMatch(requestOrigin, configuredOrigin) {
	if (configuredOrigin === "*") {
		return true;
	}

	const wildcardMatch = String(configuredOrigin || "").match(/^(https?:\/\/)?\*\.([^/:]+)$/i);
	if (wildcardMatch) {
		const reqParsed = parseOrigin(requestOrigin);
		if (!reqParsed) {
			return false;
		}

		const requiredProtocol = wildcardMatch[1] ? wildcardMatch[1].toLowerCase() : "";
		if (requiredProtocol && reqParsed.protocol !== requiredProtocol) {
			return false;
		}

		const suffix = String(wildcardMatch[2] || "").toLowerCase();
		const hostname = String(reqParsed.hostname || "").toLowerCase();
		return hostname === suffix || hostname.endsWith(`.${suffix}`);
	}

	const reqParsed = parseOrigin(requestOrigin);
	const cfgParsed = parseOrigin(configuredOrigin);
	if (!reqParsed || !cfgParsed) {
		return normalizeConfiguredOrigin(requestOrigin) === normalizeConfiguredOrigin(configuredOrigin);
	}

	if (reqParsed.protocol !== cfgParsed.protocol) {
		return false;
	}

	if (getOriginPort(reqParsed) !== getOriginPort(cfgParsed)) {
		return false;
	}

	if (reqParsed.hostname === cfgParsed.hostname) {
		return true;
	}

	return isLoopbackHost(reqParsed.hostname) && isLoopbackHost(cfgParsed.hostname);
}

function emitToRoom(code, event, data = {}) {
	const room = roomName(code);
	if (!ioInstance || !room) {
		return;
	}

	ioInstance.to(room).emit(event, data);
}

function bindSocketToRoom(code, socketId) {
	const room = roomName(code);
	if (!ioInstance || !room || !socketId) {
		return false;
	}

	const socket = ioInstance.sockets.sockets.get(socketId);
	if (!socket) {
		return false;
	}

	socket.join(room);
	return true;
}

// ── Consolidated countdown timer ──────────────────────────
// Frontend handles local countdown display. Backend only needs to:
// 1. Emit a sync tick every 5s (not every 1s) to correct drift
// 2. Emit transfer-expired when a transfer expires
// This reduces socket chatter by 5x at scale.
let consolidatedTimerId = null;
const TICK_INTERVAL_MS = 5000; // 5s — frontend interpolates locally between ticks

function ensureConsolidatedTimer() {
	if (consolidatedTimerId) {
		return;
	}

	consolidatedTimerId = setInterval(() => {
		try {
			if (countdownMap.size === 0) {
				clearInterval(consolidatedTimerId);
				consolidatedTimerId = null;
				return;
			}

			const now = Date.now();
			const expired = [];

			for (const [normalizedCode, entry] of countdownMap) {
				const secondsRemaining = Math.max(0, Math.ceil((entry.endsAt - now) / 1000));

				// Skip emit if value didn't change (only happens under sub-second tick drift),
				// reducing socket chatter without affecting client UX.
				if (entry.lastEmittedSeconds !== secondsRemaining) {
					emitToRoom(normalizedCode, "countdown-tick", { secondsRemaining });
					entry.lastEmittedSeconds = secondsRemaining;
				}

				if (secondsRemaining <= 0) {
					expired.push(normalizedCode);
				}
			}

			for (const normalizedCode of expired) {
				countdownMap.delete(normalizedCode);
				emitToRoom(normalizedCode, "transfer-expired", { code: normalizedCode });
				if (!isMongoReady()) continue;
				void Transfer.updateOne(
					{ code: normalizedCode },
					{
						$push: {
							activity: {
								$each: [{
									event: "expired",
									device: "System",
									ip: "",
									timestamp: new Date(),
								}],
								// Cap activity log at last 200 entries to prevent unbounded doc growth
								// on chatty transfers (many viewers, many downloads).
								$slice: -200,
							},
						},
					},
				).catch((err) => logError("Failed to record expiry", err, `CODE: ${normalizedCode}`));
				logEvent("Transfer expired", `CODE: ${normalizedCode}`);
			}
		} catch (err) {
			logError("Consolidated timer crashed", err);
		}
	}, TICK_INTERVAL_MS);

	// Don't keep the event loop alive solely for this timer during shutdown.
	if (typeof consolidatedTimerId.unref === "function") {
		consolidatedTimerId.unref();
	}
}

function getCountdownEndsAt(code) {
	const normalizedCode = normalizeCode(code);
	if (!normalizedCode) return null;
	const entry = countdownMap.get(normalizedCode);
	return entry ? entry.endsAt : null;
}

function clearTransferCountdown(code) {
	const normalizedCode = normalizeCode(code);
	if (!normalizedCode) {
		return;
	}

	countdownMap.delete(normalizedCode);

	if (countdownMap.size === 0 && consolidatedTimerId) {
		clearInterval(consolidatedTimerId);
		consolidatedTimerId = null;
	}
}

function scheduleTransferCountdown(code, expiresAt) {
	const normalizedCode = normalizeCode(code);
	if (!normalizedCode || !expiresAt) {
		return;
	}

	const endsAt = new Date(expiresAt).getTime();
	if (!Number.isFinite(endsAt)) {
		return;
	}
	const secondsRemaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
	countdownMap.set(normalizedCode, { endsAt, lastEmittedSeconds: secondsRemaining });
	emitToRoom(normalizedCode, "countdown-tick", { secondsRemaining });
	ensureConsolidatedTimer();
}

function getSocketIp(socket) {
	// Priority 1: x-forwarded-for (most reliable for proxied connections)
	const forwardedFor = socket?.handshake?.headers?.["x-forwarded-for"];
	if (typeof forwardedFor === "string" && forwardedFor.trim()) {
		return forwardedFor.split(",")[0].trim();
	}

	// Priority 2: x-real-ip
	const realIp = socket?.handshake?.headers?.["x-real-ip"];
	if (typeof realIp === "string" && realIp.trim()) {
		return realIp.trim();
	}

	// Priority 3: socket address
	return String(socket?.handshake?.address || "").trim();
}

async function emitNearbyDevices(socket) {
	try {
		if (!isMongoReady()) {
			socket.emit("nearby-devices", { devices: [] });
			return;
		}

		const subnet = socket.data.subnet;
		const clientIp = socket.data.clientIp;

		// If no valid subnet, return empty list
		if (!subnet) {
			socket.emit("nearby-devices", { devices: [] });
			return;
		}

		const now = new Date();
		
		// Subnet-first query — get connected socket IDs from the subnet room first,
		// then query only transfers matching those socket IDs.
		const subnetRoom = `subnet:${subnet}`;
		const socketsInSubnet = ioInstance
			? new Set((await ioInstance.in(subnetRoom).fetchSockets()).map(s => s.id))
			: new Set();

		if (socketsInSubnet.size === 0) {
			socket.emit("nearby-devices", { devices: [] });
			return;
		}

		// Query only transfers whose senderSocketId is in the subnet room
		const socketIdArray = Array.from(socketsInSubnet);
		const candidates = await Transfer.find({
			isDeleted: false,
			expiresAt: { $gt: now },
			senderSocketId: { $in: socketIdArray },
		})
			.select('code fileCount files totalSize ai.category senderDeviceName expiresAt senderSocketId')
			.lean();

		// Map to device info and filter self
		const devices = candidates
			.map((transfer) => ({
				code: transfer.code,
				fileCount: Number(transfer.fileCount || transfer.files?.length || 0),
				totalSize: Number(transfer.totalSize || 0),
				category: transfer.ai?.category || "Other",
				deviceName: transfer.senderDeviceName || "Unknown Device",
				expiresAt: transfer.expiresAt,
				socketId: String(transfer.senderSocketId || ""),
			}))
			.filter((device) => device.socketId !== socket.id);

		socket.emit("nearby-devices", { devices });
	} catch (error) {
		logError("Failed to emit nearby devices", error, `SOCKET: ${socket.id}`);
		socket.emit("nearby-devices", { devices: [] });
	}
}

function initSocket(server) {
	const allowedFrontendOrigins = `${String(process.env.FRONTEND_URL || "")},${String(process.env.CORS_EXTRA_ORIGINS || "")}`
		.split(",")
		.map((origin) => normalizeConfiguredOrigin(origin))
		.filter(Boolean);

	ioInstance = new Server(server, {
		// Mobile-optimized timeouts: Wait 2 minutes before assuming mobile dropped
		// Send pings less frequently to save mobile battery and reduce load
		pingInterval: 30000,  // 30s (was 25s)
		pingTimeout: 120000,  // 120s / 2 minutes (was 60s) - tolerates screen lock, WiFi<->data handoff
		connectTimeout: 45000, // 45s - give mobile more time to establish connection
		// Match the express body limit. Sockets carry only small JSON events.
		maxHttpBufferSize: 1e6,
		// Security: Prevent WebSocket transport downgrade attacks
		// Note: websocket first, polling fallback for mobile networks
		transports: ["websocket", "polling"],
		allowUpgrades: true,
		// Security: Limit connection attempts
		perMessageDeflate: false,
		httpCompression: false,
		cors: {
			origin: allowedFrontendOrigins,
			methods: ["GET", "POST"],
			credentials: false,
		},
	});

	// Security: Track connection attempts per IP (optimized)
	const connectionAttempts = new Map();
	const MAX_CONNECTIONS_PER_IP = 10;
	const CONNECTION_WINDOW_MS = 60 * 1000; // 1 minute
	const MAX_CONNECTION_ENTRIES = 5000; // Prevent memory bloat

	ioInstance.use((socket, next) => {
		const ip = getSocketIp(socket);
		const now = Date.now();
		const attempts = connectionAttempts.get(ip);

		if (!attempts) {
			// Prevent memory bloat
			if (connectionAttempts.size > MAX_CONNECTION_ENTRIES) {
				// Quick cleanup: remove first 1000 expired entries
				let cleaned = 0;
				for (const [key, val] of connectionAttempts) {
					if (now > val.resetAt) {
						connectionAttempts.delete(key);
						if (++cleaned >= 1000) break;
					}
				}
			}
			connectionAttempts.set(ip, { count: 1, resetAt: now + CONNECTION_WINDOW_MS });
			return next();
		}

		if (now > attempts.resetAt) {
			attempts.count = 1;
			attempts.resetAt = now + CONNECTION_WINDOW_MS;
			return next();
		}

		if (attempts.count >= MAX_CONNECTIONS_PER_IP) {
			logEvent("Socket connection rate limit", `IP: ${ip}`);
			return next(new Error("Too many connection attempts"));
		}

		attempts.count++;
		next();
	});

	// Cleanup old connection attempts every 10 minutes (less frequent)
	setInterval(() => {
		try {
			const now = Date.now();
			const toDelete = [];
			for (const [ip, attempts] of connectionAttempts) {
				if (now > attempts.resetAt) {
					toDelete.push(ip);
				}
			}
			for (const ip of toDelete) {
				connectionAttempts.delete(ip);
			}
		} catch (err) {
			logError("Connection attempts cleanup crashed", err);
		}
	}, 10 * 60 * 1000).unref(); // unref to not block process exit

	// Periodic cleanup of stale socket IDs from database (every 5 minutes)
	// This catches any socket IDs that weren't cleaned up during disconnect
	setInterval(async () => {
		if (!ioInstance || !isMongoReady()) return;

		try {
			const connectedSockets = new Set(Array.from(ioInstance.sockets.sockets.keys()));
			
			// Find all transfers with socket IDs
			const transfers = await Transfer.find(
				{ senderSocketId: { $exists: true, $ne: "" } },
				{ code: 1, senderSocketId: 1 }
			).lean();
			
			// Identify stale socket IDs
			const staleTransfers = transfers.filter(t => !connectedSockets.has(t.senderSocketId));
			
			if (staleTransfers.length > 0) {
				// Bulk update to clear stale socket IDs
				const staleCodes = staleTransfers.map(t => t.code);
				await Transfer.updateMany(
					{ code: { $in: staleCodes } },
					{ $set: { senderSocketId: "" } }
				);
				
				logEvent("Stale socket cleanup", `CLEARED: ${staleTransfers.length} stale socket IDs`);
			}
		} catch (error) {
			logError("Failed to clean up stale sockets", error);
		}
	}, 5 * 60 * 1000).unref(); // unref to not block process exit

	ioInstance.on("connection", (socket) => {
		// Store client IP and subnet for this connection
		const clientIp = getSocketIp(socket);
		const subnet = getSubnet(clientIp);
		socket.data.clientIp = clientIp;
		socket.data.subnet = subnet || null;
		
		// Auto-join subnet room if valid subnet exists
		if (subnet) {
			socket.join(`subnet:${subnet}`);
			logEvent("Socket connected", `SOCKET: ${socket.id}`, `IP: ${clientIp}`, `SUBNET: ${subnet}`);
		}
		
		// Suppress ECONNRESET/EPIPE errors from abrupt client disconnects —
		// these are normal on mobile networks and don't indicate a bug.
		socket.on("error", (err) => {
			if (err?.code !== "ECONNRESET" && err?.code !== "EPIPE" && err?.code !== "ERR_STREAM_DESTROYED") {
				logError("Socket error", err, `SOCKET: ${socket.id}`);
			}
		});

		// Helper: invoke ack only if it's a valid function. socket.io clients may
		// or may not pass an ack — we never want to throw because of a missing one.
		const safeAck = (ack, payload) => {
			if (typeof ack === "function") {
				try { ack(payload); } catch { /* client-side ack errors are non-fatal */ }
			}
		};

		socket.on("join-room", ({ code } = {}, ack) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				safeAck(ack, { ok: false, error: "invalid_code" });
				return;
			}

			const room = roomName(normalizedCode);
			// Idempotent join: socket.io's join() is already idempotent, but we ack
			// so the client knows the room is bound (helps the React reconnect flow
			// avoid issuing duplicate joins).
			socket.join(room);
			safeAck(ack, { ok: true, code: normalizedCode });
		});

		socket.on("leave-room", ({ code } = {}, ack) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				safeAck(ack, { ok: false, error: "invalid_code" });
				return;
			}

			socket.leave(roomName(normalizedCode));
			safeAck(ack, { ok: true, code: normalizedCode });
		});

		socket.on("rejoin-room", async ({ code } = {}, ack) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				safeAck(ack, { ok: false, error: "invalid_code" });
				return;
			}

			socket.join(roomName(normalizedCode));

			// Fast path: if the countdown is already in memory (typical hot transfer),
			// skip the Mongo round trip. Saves ~30-100ms on every reconnect across
			// flaky mobile networks where reconnects are frequent.
			const cachedEndsAt = getCountdownEndsAt(normalizedCode);
			if (cachedEndsAt) {
				const secondsRemaining = Math.max(0, Math.ceil((cachedEndsAt - Date.now()) / 1000));
				socket.emit("countdown-tick", { secondsRemaining });
				safeAck(ack, { ok: true, code: normalizedCode, secondsRemaining });
				return;
			}

			// Cold path: DB lookup. Only happens on rejoin after server restart or
			// for transfers whose timer was never scheduled.
			try {
				const transfer = await Transfer.findOne(
					{ code: normalizedCode },
					{ expiresAt: 1, isDeleted: 1 },
				).lean();
				if (!transfer || transfer.isDeleted || !transfer.expiresAt) {
					safeAck(ack, { ok: true, code: normalizedCode, secondsRemaining: 0 });
					return;
				}

				const secondsRemaining = Math.max(
					0,
					Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000),
				);

				socket.emit("countdown-tick", { secondsRemaining });
				safeAck(ack, { ok: true, code: normalizedCode, secondsRemaining });
			} catch (error) {
				logError("Failed to rejoin room", error, `CODE: ${normalizedCode}`);
				safeAck(ack, { ok: false, error: "lookup_failed" });
			}
		});

		socket.on("register-sender", async ({ code, ownershipToken } = {}, ack) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode || !ownershipToken) {
				safeAck(ack, { ok: false, error: "invalid_code_or_token" });
				return;
			}

			socket.join(roomName(normalizedCode));

			try {
				const updateResult = await Transfer.updateOne(
					{ code: normalizedCode, ownershipToken: ownershipToken },
					{ $set: { senderSocketId: socket.id } },
				);
				if (updateResult.matchedCount === 0) {
					safeAck(ack, { ok: false, error: "unauthorized" });
					return;
				}
				safeAck(ack, { ok: true, code: normalizedCode, socketId: socket.id });
			} catch (error) {
				logError("Failed to register sender socket", error, `CODE: ${normalizedCode}`);
				safeAck(ack, { ok: false, error: "register_failed" });
			}
		});

		socket.on("nearby-ping", async ({ code } = {}) => {
			const normalizedCode = normalizeCode(code);
			if (normalizedCode) {
				socket.join(roomName(normalizedCode));
			}

			// Always respond with pong first
			socket.emit("nearby-pong", {
				timestamp: Date.now(),
				socketId: socket.id,
				code: normalizedCode || null,
			});

			// Throttle nearby-device re-queries so socket pings do not spam MongoDB.
			const now = Date.now();
			const lastQuery = socket.data.lastNearbyQuery || 0;
			if (now - lastQuery < 8000) {
				return;
			}
			socket.data.lastNearbyQuery = now;

			// Then emit nearby devices
			try {
				await emitNearbyDevices(socket);
			} catch (error) {
				logError("Failed to emit nearby devices", error, `SOCKET: ${socket.id}`);
				socket.emit("nearby-devices", { devices: [] });
			}
		});

		socket.on("push-transfer-offer", async ({ targetSocketId, code, filename } = {}) => {
			const safeTargetSocketId = String(targetSocketId || "").trim();
			const safeCode = normalizeCode(code);
			if (!safeTargetSocketId || !safeCode || safeTargetSocketId === socket.id) {
				return;
			}

			// Validate subnet
			const targetSockets = await ioInstance.in(safeTargetSocketId).fetchSockets();
			if (!targetSockets || targetSockets.length === 0) return;
			const targetSocket = targetSockets[0];

			if (targetSocket.data.subnet !== socket.data.subnet) {
				logEvent("Blocked cross-subnet transfer push", `FROM_IP: ${socket.data.ip}`, `TO_IP: ${targetSocket.data.ip}`);
				return;
			}

			ioInstance.to(safeTargetSocketId).emit("receive-transfer-offer", {
				code: safeCode,
				filename: String(filename || "file").slice(0, 180),
				senderId: socket.id,
			});
		});

		socket.on("disconnect", async (reason) => {
			try {
				// Clear sender socket ID for all transfers owned by this socket
				await Transfer.updateMany(
					{ senderSocketId: socket.id },
					{ $set: { senderSocketId: "" } },
				);
				
				logEvent("Socket disconnected", `SOCKET: ${socket.id}`, `REASON: ${reason}`);
			} catch (error) {
				// Only log non-operational errors (ECONNRESET is expected on mobile)
				if (error?.code !== 'ECONNRESET' && error?.code !== 'EPIPE') {
					logError("Failed to clean up sender socket on disconnect", error);
				}
			}
		});
	});

	return ioInstance;
}

function getIo() {
	return ioInstance;
}

// Broadcast to all sockets on same subnet that a new transfer is available
async function broadcastNewTransferToSubnet(transferCode, senderIp) {
	if (!ioInstance) return;
	
	const subnet = getSubnet(senderIp);
	if (!subnet) return;
	
	try {
		// Get the transfer details
		const transfer = await Transfer.findOne({ code: transferCode })
			.select('code fileCount files totalSize ai.category senderDeviceName expiresAt senderSocketId senderIp')
			.lean();
			
		if (!transfer) return;
		
		const deviceInfo = {
			code: transfer.code,
			fileCount: Number(transfer.fileCount || transfer.files?.length || 0),
			totalSize: Number(transfer.totalSize || 0),
			category: transfer.ai?.category || "Other",
			deviceName: transfer.senderDeviceName || "Unknown Device",
			expiresAt: transfer.expiresAt,
			socketId: String(transfer.senderSocketId || ""),
		};
		
		// FIXED: Emit ONLY to sockets in the same subnet room
		// No client-side filtering needed anymore
		const subnetRoom = `subnet:${subnet}`;
		ioInstance.to(subnetRoom).emit("nearby-device-added", { device: deviceInfo });
		
		logEvent("Broadcast new transfer", `CODE: ${transferCode}`, `SUBNET: ${subnet}`, `ROOM: ${subnetRoom}`);
	} catch (error) {
		logError("Failed to broadcast new transfer", error, `CODE: ${transferCode}`);
	}
}

module.exports = {
	initSocket,
	emitToRoom,
	scheduleTransferCountdown,
	clearTransferCountdown,
	bindSocketToRoom,
	getIo,
	broadcastNewTransferToSubnet,
};

