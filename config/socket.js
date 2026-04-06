const { Server } = require("socket.io");
const Transfer = require("../models/Transfer");

let ioInstance;
const countdownMap = new Map();

function roomName(code) {
	return `room:${code}`;
}

function logEvent(message, data) {
	const timestamp = new Date().toISOString();
	if (data) {
		console.log(`[${timestamp}] ${message}`, data);
	} else {
		console.log(`[${timestamp}] ${message}`);
	}
}

function emitToRoom(code, event, data = {}) {
	if (!ioInstance || !code) {
		return;
	}

	ioInstance.to(roomName(code)).emit(event, data);
}

function bindSocketToRoom(code, socketId) {
	if (!ioInstance || !code || !socketId) {
		return false;
	}

	const socket = ioInstance.sockets.sockets.get(socketId);
	if (!socket) {
		return false;
	}

	socket.join(roomName(code));
	return true;
}

function clearTransferCountdown(code) {
	const existing = countdownMap.get(code);
	if (!existing) {
		return;
	}

	clearInterval(existing.intervalId);
	countdownMap.delete(code);
}

function scheduleTransferCountdown(code, expiresAt) {
	if (!code || !expiresAt) {
		return;
	}

	clearTransferCountdown(code);

	const end = new Date(expiresAt).getTime();
	const intervalId = setInterval(() => {
		const secondsRemaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
		emitToRoom(code, "countdown-tick", { secondsRemaining });

		if (secondsRemaining <= 0) {
			clearTransferCountdown(code);
			emitToRoom(code, "transfer-expired", { code });
			logEvent("Transfer expired", { code });
		}
	}, 1000);

	countdownMap.set(code, { intervalId });
}

function initSocket(server) {
	ioInstance = new Server(server, {
		cors: {
			origin: process.env.FRONTEND_URL || "*",
			methods: ["GET", "POST"],
		},
	});

	ioInstance.on("connection", (socket) => {
		socket.on("join-room", ({ code } = {}) => {
			if (!code) {
				return;
			}

			socket.join(roomName(code));
		});

		socket.on("register-sender", async ({ code } = {}) => {
			if (!code) {
				return;
			}

			socket.join(roomName(code));

			try {
				await Transfer.updateOne(
					{ code },
					{ $set: { senderSocketId: socket.id } },
				);
			} catch (error) {
				console.error(`Failed to register sender socket for ${code}: ${error.message}`);
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

