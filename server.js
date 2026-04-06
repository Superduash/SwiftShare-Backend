require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { connectDB } = require("./config/db");
const { initSocket } = require("./config/socket");
const uploadRoutes = require("./routes/upload");

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

app.use("/api/upload", uploadRoutes);

app.get("/api/health", (req, res) => {
	res.json({ status: "ok" });
});

function connectMongoWithRetry() {
	const retryDelayMs = 5000;

	const tryConnect = async () => {
		try {
			await connectDB();
			console.log("MongoDB connected");
		} catch (error) {
			console.error(`MongoDB connection failed: ${error.message}`);
			setTimeout(tryConnect, retryDelayMs);
		}
	};

	void tryConnect();
}

function startServer() {
	try {
		initSocket(server);

		const port = Number(process.env.PORT) || 3001;
		server.listen(port, () => {
			console.log(`Server listening on port ${port}`);
			connectMongoWithRetry();
		});
	} catch (error) {
		console.error("Server failed to start:", error.message);
	}
}

startServer();

