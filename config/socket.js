const { Server } = require("socket.io");
const Transfer = require("../models/Transfer");
const { getSubnet } = require("../utils/helpers");
const { logEvent, logError } = require("../utils/logger");

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

// Hosting platforms (Vercel, Netlify, Render, Cloudflare Pages) issue per-branch
// preview URLs that share a public TLD with the configured FRONTEND_URL. CORS
// blocking those breaks every preview deploy and every custom-domain alias.
// If the configured frontend lives on one of these platforms, accept any
// sibling subdomain on the same platform automatically.
const PREVIEW_PLATFORM_SUFFIXES = [
	"vercel.app",
	"netlify.app",
	"onrender.com",
	"pages.dev",
	"web.app",
	"firebaseapp.com",
];

function hostnameOf(origin) {
	const parsed = parseOrigin(origin);
	return parsed ? String(parsed.hostname || "").toLowerCase() : "";
}

function isPreviewDeployOrigin(requestOrigin, configuredOrigins) {
	const reqHost = hostnameOf(requestOrigin);
	if (!reqHost) {
		return false;
	}

	for (const configured of configuredOrigins) {
		const cfgHost = hostnameOf(configured);
		if (!cfgHost) {
			continue;
		}

		for (const suffix of PREVIEW_PLATFORM_SUFFIXES) {
			const isCfgOnSuffix = cfgHost === suffix || cfgHost.endsWith(`.${suffix}`);
			const isReqOnSuffix = reqHost === suffix || reqHost.endsWith(`.${suffix}`);
			if (isCfgOnSuffix && isReqOnSuffix) {
				return true;
			}
		}
	}

	return false;
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
// Instead of one setInterval per transfer (which kills 0.1 CPU on Render),
// we use a single interval that ticks every 1s and processes all active countdowns.
//
// Drift correction: each tick recomputes from absolute endsAt rather than decrementing
// a counter, so even if the event loop stalls (GC pause, slow syscall), the next tick
// reports the correct remaining seconds — no compounding error over 10+ minute sessions.
let consolidatedTimerId = null;
const TICK_INTERVAL_MS = 1000;

function ensureConsolidatedTimer() {
	if (consolidatedTimerId) {
		return;
	}

	consolidatedTimerId = setInterval(() => {
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
	const forwardedFor = socket?.handshake?.headers?.["x-forwarded-for"];
	if (typeof forwardedFor === "string" && forwardedFor.trim()) {
		return forwardedFor.split(",")[0].trim();
	}

	return String(socket?.handshake?.address || "").trim();
}

async function emitNearbyDevices(socket) {
	const clientIp = getSocketIp(socket);
	const subnet = getSubnet(clientIp);

	if (!subnet) {
		socket.emit("nearby-devices", { devices: [] });
		return;
	}

	const now = new Date();
	const candidates = await Transfer.find({
		isDeleted: false,
		expiresAt: { $gt: now },
		senderSocketId: { $exists: true, $ne: "" },
		senderIp: { $regex: `^${subnet.replace(/\./g, "\\.")}\\.` },
	})
		.sort({ createdAt: -1 })
		.limit(20)
		.lean();

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
		.filter((device) => device.socketId && device.socketId !== socket.id);

	socket.emit("nearby-devices", { devices });
}

function initSocket(server) {
	const allowedOrigins = `${String(process.env.FRONTEND_URL || "")},${String(process.env.CORS_EXTRA_ORIGINS || "")}`
		.split(",")
		.map((origin) => normalizeConfiguredOrigin(origin))
		.filter(Boolean);

	ioInstance = new Server(server, {
		// Mobile-friendly timeouts: the default 20s pingTimeout drops connections
		// when a phone screen sleeps or signal briefly flaps. 60s tolerates
		// background tabs, lock screens, and brief radio handoffs.
		pingInterval: 25000,
		pingTimeout: 60000,
		// Match the express body limit. Sockets carry only small JSON events.
		maxHttpBufferSize: 1e6,
		cors: {
			origin: (origin, callback) => {
				if (!origin) {
					callback(null, true);
					return;
				}

				if (allowAllOrigins) {
					callback(null, true);
					return;
				}

				if (!isProduction && isDevOriginAllowed(origin)) {
					callback(null, true);
					return;
				}

				if (
					allowedOrigins.length === 0
					|| allowedOrigins.some((configuredOrigin) => originsMatch(origin, configuredOrigin))
					|| isPreviewDeployOrigin(origin, allowedOrigins)
				) {
					callback(null, true);
					return;
				}

				logEvent("Blocked Socket.IO CORS origin", `ORIGIN: ${origin}`);
				callback(new Error("Origin not allowed by Socket.IO CORS"));
			},
			methods: ["GET", "POST"],
			credentials: false,
		},
	});

	ioInstance.on("connection", (socket) => {
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

		socket.on("register-sender", async ({ code } = {}, ack) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				safeAck(ack, { ok: false, error: "invalid_code" });
				return;
			}

			socket.join(roomName(normalizedCode));

			try {
				await Transfer.updateOne(
					{ code: normalizedCode },
					{ $set: { senderSocketId: socket.id } },
				);
				safeAck(ack, { ok: true, code: normalizedCode, socketId: socket.id });
			} catch (error) {
				logError("Failed to register sender socket", error, `CODE: ${normalizedCode}`);
				safeAck(ack, { ok: false, error: "register_failed" });
			}
		});

		socket.on("nearby-ping", ({ code } = {}) => {
			const normalizedCode = normalizeCode(code);
			if (normalizedCode) {
				socket.join(roomName(normalizedCode));
			}

			socket.emit("nearby-pong", {
				timestamp: Date.now(),
				socketId: socket.id,
				code: normalizedCode || null,
			});

			void emitNearbyDevices(socket).catch((error) => {
				logError("Failed to emit nearby devices", error, `SOCKET: ${socket.id}`);
			});
		});

		socket.on("push-transfer-offer", ({ targetSocketId, code, filename } = {}) => {
			const safeTargetSocketId = String(targetSocketId || "").trim();
			const safeCode = normalizeCode(code);
			if (!safeTargetSocketId || !safeCode || safeTargetSocketId === socket.id) {
				return;
			}

			ioInstance.to(safeTargetSocketId).emit("receive-transfer-offer", {
				code: safeCode,
				filename: String(filename || "file").slice(0, 180),
				senderId: socket.id,
			});
		});

		socket.on("disconnect", async () => {
			try {
				await Transfer.updateMany(
					{ senderSocketId: socket.id },
					{ $set: { senderSocketId: "" } },
				);
			} catch (error) {
				logError("Failed to clean up sender socket on disconnect", error);
			}
		});
	});

	return ioInstance;
}

function getIo() {
	return ioInstance;
}

module.exports = {
	initSocket,
	emitToRoom,
	scheduleTransferCountdown,
	clearTransferCountdown,
	bindSocketToRoom,
	getIo,
};

