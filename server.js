require("dotenv").config();

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { connectDB } = require("./config/db");
const { checkRedisConnection } = require("./config/redis");
const { checkR2Connection } = require("./config/r2");
const {
	checkGeminiConnection,
	checkGeminiConnectionLive,
} = require("./config/gemini");
const { initSocket } = require("./config/socket");
const uploadRoutes = require("./routes/upload");
const fileRoutes = require("./routes/file");
const downloadRoutes = require("./routes/download");
const transferRoutes = require("./routes/transfer");
const nearbyRoutes = require("./routes/nearby");
const statsRoutes = require("./routes/stats");
const { startCleanupJob } = require("./services/cleanupService");
const { errorHandler } = require("./middleware/errorHandler");
const { ERROR_CODES, buildErrorResponse } = require("./utils/constants");
const { logEvent, logError } = require("./utils/logger");

const app = express();
const server = http.createServer(app);

const REQUIRED_ENV_VARS = [
	"MONGODB_URI",
	"FRONTEND_URL",
	"BACKEND_URL",
	"SHARE_BASE_URL",
];

app.set("trust proxy", 1);

app.use(cors({ origin: process.env.FRONTEND_URL || true }));
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

app.use("/api/upload", uploadRoutes);
app.use("/api/file", fileRoutes);
app.use("/api/download", downloadRoutes);
app.use("/api/transfer", transferRoutes);
app.use("/api/nearby", nearbyRoutes);
app.use("/api/stats", statsRoutes);

function getMongoStatus() {
	return mongoose.connection.readyState === 1 ? "connected" : "disconnected";
}

async function getRedisStatus() {
	return (await checkRedisConnection()) ? "connected" : "disconnected";
}

async function getR2Status() {
	return (await checkR2Connection()) ? "connected" : "disconnected";
}

async function getGeminiStatus() {
	return (await checkGeminiConnectionLive()) ? "connected" : "disconnected";
}

app.get("/api/health", async (req, res) => {
	const [redisStatus, r2Status, geminiStatus] = await Promise.all([
		getRedisStatus(),
		getR2Status(),
		getGeminiStatus(),
	]);

	res.json({
		status: "ok",
		mongodb: getMongoStatus(),
		redis: redisStatus,
		r2: r2Status,
		gemini: geminiStatus,
		uptime: process.uptime(),
		timestamp: Date.now(),
	});
});

app.use((req, res) => {
	res.status(404).json(buildErrorResponse(ERROR_CODES.ROUTE_NOT_FOUND));
});

app.use(errorHandler);

function connectMongoWithRetry() {
	const retryDelayMs = 5000;

	const tryConnect = async () => {
		try {
			await connectDB();
			logEvent("MongoDB connected");
			console.log("MongoDB Connected");
		} catch (error) {
			logError("MongoDB connection failed", error);
			setTimeout(tryConnect, retryDelayMs);
		}
	};

	void tryConnect();
}

async function printStartupStatus(port) {
	const [redisStatus, r2Status] = await Promise.all([
		getRedisStatus(),
		getR2Status(),
	]);
	const geminiStatus = checkGeminiConnection() ? "connected" : "disconnected";

	logEvent("Server started", `PORT: ${port}`, `BACKEND_URL: ${process.env.BACKEND_URL || "not-set"}`);
	logEvent("Diagnostics", `MONGODB: ${getMongoStatus()}`, `REDIS: ${redisStatus}`, `R2: ${r2Status}`, `GEMINI: ${geminiStatus}`);

	console.log("SwiftShare Server Running");
	console.log(redisStatus === "connected" ? "Redis Connected" : "Redis Disconnected");
	console.log(r2Status === "connected" ? "R2 Connected" : "R2 Disconnected");
	console.log(geminiStatus === "connected" ? "Gemini Connected" : "Gemini Disconnected");
	console.log("Cleanup Job Running");
	console.log("Ready for Transfers");
}

function startServer() {
	try {
		const missingEnv = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
		if (missingEnv.length) {
			throw new Error(`Missing required environment variables: ${missingEnv.join(", ")}`);
		}

		initSocket(server);

		const port = Number(process.env.PORT) || 3001;
		server.listen(port, async () => {
			logEvent("Server listening", `PORT: ${port}`);
			connectMongoWithRetry();
			startCleanupJob();
			await printStartupStatus(port);
		});
	} catch (error) {
		logError("Server failed to start", error);
	}
}

startServer();

