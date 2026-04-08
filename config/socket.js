const { Server } = require("socket.io");
const Transfer = require("../models/Transfer");
const { getSubnet } = require("../utils/helpers");
const { logEvent, logError } = require("../utils/logger");

let ioInstance;
const countdownMap = new Map();
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";

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
	const reqParsed = parseOrigin(requestOrigin);
	const cfgParsed = parseOrigin(configuredOrigin);
	if (!reqParsed || !cfgParsed) {
		return requestOrigin === configuredOrigin;
	}

	if (reqParsed.protocol !== cfgParsed.protocol) {
		return false;
	}

	if (reqParsed.port !== cfgParsed.port) {
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

function clearTransferCountdown(code) {
	const normalizedCode = normalizeCode(code);
	if (!normalizedCode) {
		return;
	}

	const existing = countdownMap.get(normalizedCode);
	if (!existing) {
		return;
	}

	clearInterval(existing.intervalId);
	countdownMap.delete(normalizedCode);
}

function scheduleTransferCountdown(code, expiresAt) {
	const normalizedCode = normalizeCode(code);
	if (!normalizedCode || !expiresAt) {
		return;
	}

	clearTransferCountdown(normalizedCode);

	const end = new Date(expiresAt).getTime();
	const intervalId = setInterval(() => {
		const secondsRemaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
		emitToRoom(normalizedCode, "countdown-tick", { secondsRemaining });

		if (secondsRemaining <= 0) {
			clearTransferCountdown(normalizedCode);
			emitToRoom(normalizedCode, "transfer-expired", { code: normalizedCode });
			void Transfer.updateOne(
				{ code: normalizedCode },
				{
					$push: {
						activity: {
							event: "expired",
							device: "System",
							ip: "",
							timestamp: new Date(),
						},
					},
				},
			);
			logEvent("Transfer expired", `CODE: ${normalizedCode}`);
		}
	}, 1000);

	countdownMap.set(normalizedCode, { intervalId });
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
	const allowedOrigins = String(process.env.FRONTEND_URL || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);

	ioInstance = new Server(server, {
		cors: {
			origin: (origin, callback) => {
				if (!origin) {
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
				) {
					callback(null, true);
					return;
				}

				callback(new Error("Origin not allowed by Socket.IO CORS"));
			},
			methods: ["GET", "POST"],
		},
	});

	ioInstance.on("connection", (socket) => {
		socket.on("join-room", ({ code } = {}) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				return;
			}

			socket.join(roomName(normalizedCode));
		});

		socket.on("leave-room", ({ code } = {}) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				return;
			}

			socket.leave(roomName(normalizedCode));
		});

		socket.on("rejoin-room", async ({ code } = {}) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				return;
			}

			socket.join(roomName(normalizedCode));

			try {
				const transfer = await Transfer.findOne({ code: normalizedCode }).lean();
				if (!transfer || transfer.isDeleted || !transfer.expiresAt) {
					return;
				}

				const secondsRemaining = Math.max(
					0,
					Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000),
				);

				socket.emit("countdown-tick", { secondsRemaining });
			} catch (error) {
				logError("Failed to rejoin room", error, `CODE: ${normalizedCode}`);
			}
		});

		socket.on("register-sender", async ({ code } = {}) => {
			const normalizedCode = normalizeCode(code);
			if (!normalizedCode) {
				return;
			}

			socket.join(roomName(normalizedCode));

			try {
				await Transfer.updateOne(
					{ code: normalizedCode },
					{ $set: { senderSocketId: socket.id } },
				);
			} catch (error) {
				logError("Failed to register sender socket", error, `CODE: ${normalizedCode}`);
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

module.exports = {
	initSocket,
	emitToRoom,
	scheduleTransferCountdown,
	clearTransferCountdown,
	bindSocketToRoom,
};

