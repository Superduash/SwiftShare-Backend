const { Server } = require("socket.io");
const Transfer = require("../models/Transfer");
const { logEvent } = require("../utils/logger");

let ioInstance;
const countdownMap = new Map();

function roomName(code) {
	return `room:${code}`;
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
			void Transfer.updateOne(
				{ code },
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
			logEvent("Transfer expired", `CODE: ${code}`);
		}
	}, 1000);

	countdownMap.set(code, { intervalId });
}

function initSocket(server) {
	ioInstance = new Server(server, {
		cors: {
			origin: process.env.FRONTEND_URL,
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

		socket.on("rejoin-room", async ({ code } = {}) => {
			if (!code) {
				return;
			}

			socket.join(roomName(code));

			try {
				const transfer = await Transfer.findOne({ code }).lean();
				if (!transfer || transfer.isDeleted || !transfer.expiresAt) {
					return;
				}

				const secondsRemaining = Math.max(
					0,
					Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000),
				);

				socket.emit("countdown-tick", { secondsRemaining });
			} catch (error) {
				console.error(`Failed to rejoin room for ${code}: ${error.message}`);
			}
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

