const { Server } = require("socket.io");

function initSocket(server) {
	const io = new Server(server, {
		cors: {
			origin: process.env.FRONTEND_URL || "*",
			methods: ["GET", "POST"],
		},
	});

	io.on("connection", (socket) => {
		socket.on("join-room", ({ code } = {}) => {
			if (code) {
				socket.join(`room:${code}`);
			}
		});
	});

	return io;
}

module.exports = {
	initSocket,
};

