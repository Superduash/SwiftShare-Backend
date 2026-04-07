const { Server } = require("socket.io");
const Transfer = require("../models/Transfer");
const { logEvent } = require("../utils/logger");

let ioInstance;
const countdownMap = new Map();

function normalizeCode(code) {
	return String(code || "").trim().toUpperCase();
}

function roomName(code) {
	const normalizedCode = normalizeCode(code);
	return normalizedCode ? `room:${normalizedCode}` : "";
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

function initSocket(server) {
	const allowedOrigins = String(process.env.FRONTEND_URL || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);

	ioInstance = new Server(server, {
		cors: {
			origin: allowedOrigins.length > 0 ? allowedOrigins : true,
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
				console.error(`Failed to rejoin room for ${normalizedCode}: ${error.message}`);
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
				console.error(`Failed to register sender socket for ${normalizedCode}: ${error.message}`);
			}
		});

		socket.on("nearby-ping", () => {
			// Placeholder event for Hour 4 nearby feature.
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

