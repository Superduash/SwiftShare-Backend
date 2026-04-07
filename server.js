require("./instrument");
require("dotenv").config();

const http = require("http");
const Sentry = require("@sentry/node");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { validateEnvOrExit } = require("./utils/validateEnv");

validateEnvOrExit();

const { connectDB } = require("./config/db");
const { checkRedisConnection } = require("./config/redis");
const { checkR2Connection } = require("./config/r2");
const {
	checkGeminiConnection,
	checkGeminiConnectionLive,
} = require("./config/gemini");
const { initSocket } = require("./config/socket");
const Transfer = require("./models/Transfer");
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
const { version } = require("./package.json");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

app.use(cors({ origin: process.env.FRONTEND_URL || true, maxAge: 86400 }));
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
	req.setTimeout(30000, () => {
		if (!res.headersSent) {
			res
				.status(408)
				.json(buildErrorResponse(ERROR_CODES.REQUEST_TIMEOUT, "Request timed out"));
		}
	});

	next();
});

const sentryRequestHandler = Sentry.Handlers?.requestHandler?.();
app.use(sentryRequestHandler || ((req, res, next) => next()));

app.use((req, res, next) => {
	const originalJson = res.json.bind(res);

	res.json = (payload) => {
		const isObject = payload !== null && typeof payload === "object" && !Array.isArray(payload);

		if (res.statusCode >= 400) {
			if (isObject && payload.success === false) {
				return originalJson(payload);
			}

			if (isObject && payload.error) {
				return originalJson({ success: false, error: payload.error });
			}

			return originalJson(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Something went wrong"));
		}

		if (isObject && payload.success === true) {
			if (Object.prototype.hasOwnProperty.call(payload, "data")) {
				return originalJson(payload);
			}

			const { success, ...rest } = payload;
			return originalJson({ success: true, data: rest });
		}

		if (isObject && payload.success === false) {
			return originalJson(payload);
		}

		return originalJson({ success: true, data: payload });
	};

	next();
});

app.get("/debug-sentry", (req, res) => {
	throw new Error("Sentry test error");
});

app.get("/api/ping", (req, res) => {
	res.status(200).json({ pong: true });
});

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

function formatUptimeHuman(totalSeconds) {
	const safeSeconds = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const seconds = safeSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}

	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}

	return `${seconds}s`;
}

app.get("/api/health", async (req, res) => {
	const [redisStatus, r2Status, geminiStatus, activeTransfers] = await Promise.all([
		getRedisStatus(),
		getR2Status(),
		getGeminiStatus(),
		Transfer.countDocuments({ isDeleted: false, expiresAt: { $gt: new Date() } }),
	]);
	const uptime = process.uptime();

	res.json({
		status: "ok",
		version,
		uptime,
		uptimeHuman: formatUptimeHuman(uptime),
		mongodb: getMongoStatus(),
		redis: redisStatus,
		r2: r2Status,
		gemini: geminiStatus,
		activeTransfers,
		timestamp: Date.now(),
	});
});

app.use((req, res) => {
	res.status(404).json(buildErrorResponse(ERROR_CODES.ROUTE_NOT_FOUND));
});

Sentry.setupExpressErrorHandler(app);

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

let isShuttingDown = false;

async function gracefulShutdown(signal) {
	if (isShuttingDown) {
		return;
	}

	isShuttingDown = true;
	logEvent(`${signal} received, shutting down gracefully`);

	await new Promise((resolve) => {
		server.close(() => resolve());
	});

	try {
		await mongoose.connection.close();
	} catch (error) {
		logError("MongoDB close during shutdown failed", error);
	}

	process.exit(0);
}

startServer();

process.on("SIGTERM", () => {
	void gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
	void gracefulShutdown("SIGINT");
});

