require("./instrument");
require("dotenv").config({ quiet: true });

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
const { initSocket, scheduleTransferCountdown } = require("./config/socket");
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
const { logSuccess, logEvent, logError } = require("./utils/logger");
const { version } = require("./package.json");

const app = express();
const server = http.createServer(app);
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";

function getAllowedFrontendOrigins() {
	return String(process.env.FRONTEND_URL || "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
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

const allowedFrontendOrigins = getAllowedFrontendOrigins();

function corsOrigin(origin, callback) {
	if (!origin) {
		callback(null, true);
		return;
	}

	if (!isProduction && isDevOriginAllowed(origin)) {
		callback(null, true);
		return;
	}

	if (
		allowedFrontendOrigins.length === 0
		|| allowedFrontendOrigins.some((configuredOrigin) => originsMatch(origin, configuredOrigin))
	) {
		callback(null, true);
		return;
	}

	callback(null, false);
}

app.set("trust proxy", 1);

app.use(cors({ origin: corsOrigin, maxAge: 86400 }));
app.use(helmet());
app.use(morgan((tokens, req, res) => {
	const url = (req.originalUrl || "").split("?")[0]; // strip query params to prevent passwords leaking into logs
	return [
		tokens.method(req, res),
		url,
		tokens.status(req, res),
		tokens["response-time"](req, res), "ms",
	].join(" ");
}));
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

async function restoreActiveCountdowns() {
	try {
		const active = await Transfer.find({
			isDeleted: false,
			expiresAt: { $gt: new Date() },
		}).lean();
		for (const t of active) {
			scheduleTransferCountdown(t.code, t.expiresAt);
		}
		logEvent(`Restored ${active.length} active countdowns`);
	} catch (err) {
		logError("Failed to restore countdowns", err);
	}
}

function connectMongoWithRetry() {
	const retryDelayMs = 5000;
	let hasConnected = false;
	let hasAttempted = false;

	const tryConnect = async () => {
		try {
			await connectDB();
			if (!hasConnected) {
				hasConnected = true;
				logSuccess("MongoDB Connected");
				void restoreActiveCountdowns();
			}
			return true;
		} catch (error) {
			if (hasAttempted) {
				logError("MongoDB Failed", error);
			}
			hasAttempted = true;
			setTimeout(tryConnect, retryDelayMs);
			return false;
		}
	};

	return tryConnect();
}

async function printStartupStatus(port) {
	logEvent("SwiftShare Server Starting");

	const mongoConnected = await connectMongoWithRetry();
	const [redisStatus, r2Status] = await Promise.all([
		getRedisStatus(),
		getR2Status(),
	]);
	const geminiStatus = checkGeminiConnection() ? "connected" : "disconnected";
	const sentryEnabled = Boolean(process.env.SENTRY_DSN);

	if (!mongoConnected) {
		logError("MongoDB Failed", null);
	}

	if (redisStatus === "connected") {
		logSuccess("Redis Connected");
	} else {
		logError("Redis Failed", null);
	}

	if (r2Status === "connected") {
		logSuccess("R2 Connected");
	} else {
		logError("R2 Failed", null);
	}

	if (geminiStatus === "connected") {
		logSuccess("Gemini Connected");
	} else {
		logError("Gemini Failed", null);
	}

	logSuccess(`Sentry ${sentryEnabled ? "Enabled" : "Disabled"}`);

	logSuccess("Cleanup Job Running");
	logSuccess(`Server Running on PORT ${port}`);
}

function startServer() {
	initSocket(server);

	const port = Number(process.env.PORT) || 3001;
	let retryTimer = null;
	const isNodemonRuntime = Boolean(process.env.nodemon)
		|| /nodemon/i.test(String(process.env.npm_lifecycle_script || ""));

	server.on("error", (error) => {
		if (error?.code === "EADDRINUSE") {
			if (!isNodemonRuntime) {
				logError(`Port ${port} already in use`, error);
				process.exit(1);
				return;
			}

			logEvent(`Port ${port} in use, retrying in 1200ms`);

			if (!retryTimer) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					if (!isShuttingDown) {
						server.listen(port);
					}
				}, 1200);
			}

			return;
		}

		logError("Server failed to start", error);
	});

	server.listen(port, async () => {
		startCleanupJob();
		await printStartupStatus(port);
	});
}

let isShuttingDown = false;

async function gracefulShutdown(signal, onComplete) {
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

	if (typeof onComplete === "function") {
		onComplete();
		return;
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

// Nodemon sends SIGUSR2 on restart; close the server first to avoid port rebinding races.
if (Boolean(process.env.nodemon) || /nodemon/i.test(String(process.env.npm_lifecycle_script || ""))) {
	process.once("SIGUSR2", () => {
		void gracefulShutdown("SIGUSR2", () => {
			process.kill(process.pid, "SIGUSR2");
		});
	});
}

