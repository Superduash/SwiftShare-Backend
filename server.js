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
const allowAllOrigins = String(process.env.CORS_ALLOW_ALL_ORIGINS || "").toLowerCase() === "true";
const HEALTH_CACHE_TTL_MS = Number(process.env.HEALTH_CACHE_TTL_MS) > 0
	? Number(process.env.HEALTH_CACHE_TTL_MS)
	: 15_000;
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS) > 0
	? Number(process.env.HEALTH_CHECK_TIMEOUT_MS)
	: 4_000;

let healthCache = {
	expiresAt: 0,
	payload: null,
};

function getAllowedFrontendOrigins() {
	const configured = `${String(process.env.FRONTEND_URL || "")},${String(process.env.CORS_EXTRA_ORIGINS || "")}`;

	return configured
		.split(",")
		.map((origin) => normalizeConfiguredOrigin(origin))
		.filter(Boolean);
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

function parseOrigin(origin) {
	try {
		return new URL(origin);
	} catch {
		return null;
	}
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

const allowedFrontendOrigins = getAllowedFrontendOrigins();

// Hosting platforms (Vercel, Netlify, Render, Cloudflare Pages, Firebase
// Hosting) issue per-branch preview URLs on a shared TLD. If FRONTEND_URL is
// on one of these platforms, automatically accept any sibling subdomain so
// preview/staging deploys and custom-domain aliases don't get CORS-blocked.
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

function isPreviewDeployOrigin(requestOrigin) {
	const reqHost = hostnameOf(requestOrigin);
	if (!reqHost) {
		return false;
	}

	for (const configured of allowedFrontendOrigins) {
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

function corsOrigin(origin, callback) {
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
		allowedFrontendOrigins.length === 0
		|| allowedFrontendOrigins.some((configuredOrigin) => originsMatch(origin, configuredOrigin))
		|| isPreviewDeployOrigin(origin)
	) {
		callback(null, true);
		return;
	}

	logEvent("Blocked HTTP CORS origin", `ORIGIN: ${origin}`);
	callback(null, false);
}

app.set("trust proxy", 1);

app.use(cors({ origin: corsOrigin, maxAge: 86400 }));
app.use(helmet({
	crossOriginResourcePolicy: { policy: "cross-origin" },
	crossOriginEmbedderPolicy: false,
}));
app.use(morgan((tokens, req, res) => {
	const url = (req.originalUrl || "").split("?")[0]; // strip query params to prevent passwords leaking into logs
	return [
		tokens.method(req, res),
		url,
		tokens.status(req, res),
		tokens["response-time"](req, res), "ms",
	].join(" ");
}));
// 12mb covers the worst case for /api/upload/clipboard, which receives a base64
// data URL of a pasted screenshot. Base64 inflates by ~33%, so a 6mb payload
// would block ~4.5mb screenshots — common on hi-DPI mobile cameras. Multipart
// uploads to /api/upload bypass this entirely (handled by the streaming route).
app.use(express.json({ limit: "12mb" }));

app.use((req, res, next) => {
	// Upload/download routes need longer timeout on constrained hardware (Render 0.1 CPU)
	const isUploadOrDownload = /^\/(api\/(upload|download))/i.test(req.path);
	const defaultUploadTimeoutMs = process.env.RENDER ? 180000 : 120000;
	const defaultRequestTimeoutMs = process.env.RENDER ? 90000 : 60000;
	const uploadTimeoutMs = Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS) > 0
		? Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS)
		: defaultUploadTimeoutMs;
	const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS) > 0
		? Number(process.env.REQUEST_TIMEOUT_MS)
		: defaultRequestTimeoutMs;
	const timeoutMs = isUploadOrDownload ? uploadTimeoutMs : requestTimeoutMs;

	req.setTimeout(timeoutMs, () => {
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

async function withTimeout(promise, timeoutMs, fallbackValue) {
	let timerId;
	try {
		return await Promise.race([
			promise,
			new Promise((resolve) => {
				timerId = setTimeout(() => resolve(fallbackValue), timeoutMs);
			}),
		]);
	} finally {
		if (timerId) {
			clearTimeout(timerId);
		}
	}
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
	try {
		if (healthCache.payload && healthCache.expiresAt > Date.now()) {
			return res.json(healthCache.payload);
		}

		const now = new Date();
		const [redisStatus, r2Status, geminiStatus, activeTransfers] = await Promise.all([
			withTimeout(getRedisStatus(), HEALTH_CHECK_TIMEOUT_MS, "disconnected"),
			withTimeout(getR2Status(), HEALTH_CHECK_TIMEOUT_MS, "disconnected"),
			withTimeout(getGeminiStatus(), HEALTH_CHECK_TIMEOUT_MS, "disconnected"),
			withTimeout(
				Transfer.countDocuments({ isDeleted: false, expiresAt: { $gt: now } }),
				HEALTH_CHECK_TIMEOUT_MS,
				0,
			),
		]);
		const uptime = process.uptime();
		const payload = {
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
		};

		healthCache = {
			expiresAt: Date.now() + HEALTH_CACHE_TTL_MS,
			payload,
		};

		return res.json(payload);
	} catch (error) {
		logError("Health check failed", error);
		return res.status(200).json({
			status: "ok",
			version,
			uptime: process.uptime(),
			uptimeHuman: formatUptimeHuman(process.uptime()),
			mongodb: getMongoStatus(),
			redis: "disconnected",
			r2: "disconnected",
			gemini: "disconnected",
			activeTransfers: 0,
			timestamp: Date.now(),
		});
	}
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

function printStartupStatus(port, host) {
	logEvent("SwiftShare Server Starting");
	logSuccess("Cleanup Job Running");
	logSuccess(`Server Running on ${host}:${port}`);

	void connectMongoWithRetry().then((mongoConnected) => {
		if (!mongoConnected) {
			logError("MongoDB Failed", null);
		}
	}).catch((error) => {
		logError("MongoDB startup check failed", error);
	});

	void Promise.all([
		getRedisStatus(),
		getR2Status(),
	]).then(([redisStatus, r2Status]) => {
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
	}).catch((error) => {
		logError("Service startup checks failed", error);
	});

	const geminiStatus = checkGeminiConnection() ? "connected" : "disconnected";
	const sentryEnabled = Boolean(process.env.SENTRY_DSN);

	if (geminiStatus === "connected") {
		logSuccess("Gemini Connected");
	} else {
		logError("Gemini Failed", null);
	}

	logSuccess(`Sentry ${sentryEnabled ? "Enabled" : "Disabled"}`);
}

function startServer() {
	initSocket(server);

	const port = Number(process.env.PORT) || 3001;
	const host = process.env.HOST || "0.0.0.0";
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
						server.listen(port, host);
					}
				}, 1200);
			}

			return;
		}

		logError("Server failed to start", error);
	});

	server.listen(port, host, () => {
		startCleanupJob();
		printStartupStatus(port, host);
	});
}

let isShuttingDown = false;

async function gracefulShutdown(signal, onComplete) {
	if (isShuttingDown) {
		return;
	}

	isShuttingDown = true;
	logEvent(`${signal} received, shutting down gracefully`);

	// Force exit after 8s if graceful shutdown stalls (Render sends SIGKILL at 10s)
	const forceTimer = setTimeout(() => {
		logError("Forced exit after shutdown timeout", null);
		process.exit(1);
	}, 8000);
	forceTimer.unref();

	try {
		const { getIo } = require("./config/socket");
		const io = typeof getIo === "function" ? getIo() : null;
		if (io) {
			await new Promise((resolve) => { io.close(resolve); });
		}
	} catch { /* socket cleanup is best-effort */ }

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

// Keep Render free tier awake during active sessions (pings own /api/ping every 10 min)
const SELF_PING_URL = (process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || "").replace(/\/+$/, "");
if (SELF_PING_URL && isProduction) {
	setInterval(() => {
		fetch(`${SELF_PING_URL}/api/ping`).catch(() => {});
	}, 10 * 60 * 1000);
}

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

