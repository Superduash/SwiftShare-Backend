require("./instrument");
require("dotenv").config({ quiet: true });

const http = require("http");
const crypto = require("crypto");
const Sentry = require("@sentry/node");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const { validateEnvOrExit } = require("./utils/validateEnv");
const { createTimingMiddleware, getPerformanceSnapshot } = require("./utils/performance");
const { getCacheStats } = require("./utils/cache");

validateEnvOrExit();

const { connectDB } = require("./config/db");
const { checkRedisConnection } = require("./config/redis");
const { checkR2Connection } = require("./config/r2");
const { checkGeminiConnection, checkGeminiConnectionLive } = require("./config/gemini");
const { initSocket, scheduleTransferCountdown } = require("./config/socket");
const Transfer = require("./models/Transfer");
const uploadRoutes = require("./routes/upload");
const fileRoutes = require("./routes/file");
const downloadRoutes = require("./routes/download");
const transferRoutes = require("./routes/transfer");
const nearbyRoutes = require("./routes/nearby");
const statsRoutes = require("./routes/stats");
const textRoutes = require("./routes/text");
const { startCleanupJob } = require("./services/cleanupService");
const { errorHandler } = require("./middleware/errorHandler");
const { ERROR_CODES, buildErrorResponse } = require("./utils/constants");
const { logSuccess, logEvent, logWarn, logError } = require("./utils/logger");
const { version } = require("./package.json");

const app = express();
const server = http.createServer(app);
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const allowAllOrigins = String(process.env.CORS_ALLOW_ALL_ORIGINS || "").toLowerCase() === "true";
const HEALTH_CACHE_TTL_MS = Number(process.env.HEALTH_CACHE_TTL_MS) > 0 ? Number(process.env.HEALTH_CACHE_TTL_MS) : 15_000;
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS) > 0 ? Number(process.env.HEALTH_CHECK_TIMEOUT_MS) : 4_000;

let healthCache = { expiresAt: 0, payload: null };

// ── CORS helpers ──────────────────────────────────────────────────────────────

function normalizeConfiguredOrigin(origin) {
	const trimmed = String(origin || "").trim();
	if (!trimmed) return "";
	if (trimmed === "*") return "*";
	if (/^(https?:\/\/)?\*\./i.test(trimmed)) return trimmed.replace(/\/+$/, "").toLowerCase();
	const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return withProtocol.replace(/\/+$/, "").toLowerCase();
}

function parseOrigin(origin) {
	try { return new URL(origin); } catch { return null; }
}

function getOriginPort(parsed) {
	if (!parsed) return "";
	if (parsed.port) return parsed.port;
	return parsed.protocol === "https:" ? "443" : "80";
}

function isLoopbackHost(hostname) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateNetworkHost(hostname) {
	if (!hostname) return false;
	if (/^10\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	const match172 = /^172\.(\d{1,3})\./.exec(hostname);
	if (match172) {
		const second = Number(match172[1]);
		return Number.isFinite(second) && second >= 16 && second <= 31;
	}
	return false;
}

function isDevOriginAllowed(origin) {
	const parsed = parseOrigin(origin);
	if (!parsed) return false;
	return isLoopbackHost(parsed.hostname) || isPrivateNetworkHost(parsed.hostname);
}

function originsMatch(requestOrigin, configuredOrigin) {
	if (configuredOrigin === "*") return true;
	const wildcardMatch = String(configuredOrigin || "").match(/^(https?:\/\/)?\*\.([^/:]+)$/i);
	if (wildcardMatch) {
		const reqParsed = parseOrigin(requestOrigin);
		if (!reqParsed) return false;
		const requiredProtocol = wildcardMatch[1] ? wildcardMatch[1].toLowerCase() : "";
		if (requiredProtocol && reqParsed.protocol !== requiredProtocol) return false;
		const suffix = String(wildcardMatch[2] || "").toLowerCase();
		const hostname = String(reqParsed.hostname || "").toLowerCase();
		return hostname === suffix || hostname.endsWith(`.${suffix}`);
	}
	const reqParsed = parseOrigin(requestOrigin);
	const cfgParsed = parseOrigin(configuredOrigin);
	if (!reqParsed || !cfgParsed) return normalizeConfiguredOrigin(requestOrigin) === normalizeConfiguredOrigin(configuredOrigin);
	if (reqParsed.protocol !== cfgParsed.protocol) return false;
	if (getOriginPort(reqParsed) !== getOriginPort(cfgParsed)) return false;
	if (reqParsed.hostname === cfgParsed.hostname) return true;
	return isLoopbackHost(reqParsed.hostname) && isLoopbackHost(cfgParsed.hostname);
}

function getAllowedFrontendOrigins() {
	const configured = `${String(process.env.FRONTEND_URL || "")},${String(process.env.CORS_EXTRA_ORIGINS || "")}`;
	return configured.split(",").map((o) => normalizeConfiguredOrigin(o)).filter(Boolean);
}

const allowedFrontendOrigins = getAllowedFrontendOrigins();

// Hosting platform suffixes — any subdomain on these is always allowed
// because preview deploys and branch deploys share these TLDs.
const ALWAYS_ALLOWED_PLATFORM_SUFFIXES = [
	"netlify.app",
	"onrender.com",
	"vercel.app",
	"pages.dev",
	"web.app",
	"firebaseapp.com",
	"railway.app",
];

function hostnameOf(origin) {
	const parsed = parseOrigin(origin);
	return parsed ? String(parsed.hostname || "").toLowerCase() : "";
}

function isPlatformDeployOrigin(requestOrigin) {
	const reqHost = hostnameOf(requestOrigin);
	if (!reqHost) return false;
	for (const suffix of ALWAYS_ALLOWED_PLATFORM_SUFFIXES) {
		if (reqHost === suffix || reqHost.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

function corsOrigin(origin, callback) {
	if (!origin) { callback(null, true); return; }
	if (allowAllOrigins) { callback(null, true); return; }
	if (!isProduction && isDevOriginAllowed(origin)) { callback(null, true); return; }
	// Always allow known deployment platforms (Netlify, Render, Vercel, etc.)
	if (isPlatformDeployOrigin(origin)) { callback(null, true); return; }
	if (
		allowedFrontendOrigins.length === 0
		|| allowedFrontendOrigins.some((o) => originsMatch(origin, o))
	) { callback(null, true); return; }
	logEvent("Blocked HTTP CORS origin", `ORIGIN: ${origin}`);
	callback(null, false);
}

// ── Middleware stack ──────────────────────────────────────────────────────────

app.set("trust proxy", 1);

app.use(compression({
	threshold: 1024,
	level: 6,
	filter: (req, res) => {
		if (req.headers["x-no-compression"]) return false;
		const ct = String(res.getHeader("Content-Type") || "");
		if (/^(application\/octet-stream|audio\/|video\/|image\/|application\/zip)/i.test(ct)) return false;
		return compression.filter(req, res);
	},
}));

// Attach a unique request ID to every request for log correlation
app.use((req, res, next) => {
	req.requestId = crypto.randomUUID();
	res.setHeader("X-Request-ID", req.requestId);
	next();
});

app.use(cors({ origin: corsOrigin, maxAge: 86400 }));

app.use(helmet({
	crossOriginResourcePolicy: { policy: "cross-origin" },
	crossOriginEmbedderPolicy: false,
	hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
	frameguard: { action: "deny" },
	referrerPolicy: { policy: "no-referrer" },
	contentSecurityPolicy: isProduction ? {
		directives: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'"],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", "data:", "https:"],
			connectSrc: ["'self'"],
			fontSrc: ["'self'"],
			objectSrc: ["'none'"],
			mediaSrc: ["'self'"],
			frameSrc: ["'none'"],
		},
	} : false,
	noSniff: true,
	dnsPrefetchControl: { allow: false },
	hidePoweredBy: true,
	ieNoOpen: true,
	xssFilter: true,
}));

app.use(morgan((tokens, req, res) => {
	const url = (req.originalUrl || "").split("?")[0];
	return [tokens.method(req, res), url, tokens.status(req, res), tokens["response-time"](req, res), "ms"].join(" ");
}));

app.use(express.json({ limit: "12mb" }));

// Per-request timeout — upload/download routes get a longer window
app.use((req, res, next) => {
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
			try {
				res.status(408).json(buildErrorResponse(ERROR_CODES.REQUEST_TIMEOUT, "Request timed out"));
			} catch (_) { /* race condition — headers already sent */ }
		}
	});

	next();
});

const sentryRequestHandler = Sentry.Handlers?.requestHandler?.();
app.use(sentryRequestHandler || ((req, res, next) => next()));

app.use(createTimingMiddleware());

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/api/ping", (req, res) => {
	if (res.headersSent) return;
	res.status(200).json({ pong: true });
});

app.get("/api/metrics", (req, res) => {
	if (res.headersSent) return;
	try {
		res.status(200).json({
			performance: getPerformanceSnapshot(),
			cache: getCacheStats(),
			timestamp: Date.now(),
		});
	} catch (error) {
		logError("Metrics endpoint failed", error);
		if (!res.headersSent) res.status(500).json({ error: "Failed to collect metrics" });
	}
});

app.use("/api/upload", uploadRoutes);
app.use("/api/file", fileRoutes);
app.use("/api/download", downloadRoutes);
app.use("/api/transfer", transferRoutes);
app.use("/api/nearby", nearbyRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/text", textRoutes);

// ── Health check ──────────────────────────────────────────────────────────────

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
			new Promise((resolve) => { timerId = setTimeout(() => resolve(fallbackValue), timeoutMs); }),
		]);
	} finally {
		if (timerId) clearTimeout(timerId);
	}
}

function formatUptimeHuman(totalSeconds) {
	const s = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${sec}s`;
	return `${sec}s`;
}

app.get("/api/health", async (req, res) => {
	try {
		if (res.headersSent) return;
		if (healthCache.payload && healthCache.expiresAt > Date.now()) {
			return res.json(healthCache.payload);
		}
		const now = new Date();
		const [redisStatus, r2Status, geminiStatus, activeTransfers] = await Promise.all([
			withTimeout(getRedisStatus(), HEALTH_CHECK_TIMEOUT_MS, "disconnected"),
			withTimeout(getR2Status(), HEALTH_CHECK_TIMEOUT_MS, "disconnected"),
			withTimeout(getGeminiStatus(), HEALTH_CHECK_TIMEOUT_MS, "disconnected"),
			withTimeout(Transfer.countDocuments({ isDeleted: false, expiresAt: { $gt: now } }), HEALTH_CHECK_TIMEOUT_MS, 0),
		]);
		const uptime = process.uptime();
		const payload = {
			status: "ok", version, uptime,
			uptimeHuman: formatUptimeHuman(uptime),
			mongodb: getMongoStatus(), redis: redisStatus, r2: r2Status, gemini: geminiStatus,
			activeTransfers, timestamp: Date.now(),
		};
		healthCache = { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, payload };
		return res.json(payload);
	} catch (error) {
		logError("Health check failed", error);
		if (res.headersSent) return;
		return res.status(200).json({
			status: "ok", version, uptime: process.uptime(),
			uptimeHuman: formatUptimeHuman(process.uptime()),
			mongodb: getMongoStatus(), redis: "disconnected", r2: "disconnected",
			gemini: "disconnected", activeTransfers: 0, timestamp: Date.now(),
		});
	}
});

app.use((req, res) => {
	res.status(404).json(buildErrorResponse(ERROR_CODES.ROUTE_NOT_FOUND));
});

Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

// ── Startup ───────────────────────────────────────────────────────────────────

async function restoreActiveCountdowns() {
	try {
		const active = await Transfer.find(
			{ isDeleted: false, expiresAt: { $gt: new Date() } },
			{ code: 1, expiresAt: 1 },
		).limit(2000).lean();
		for (const t of active) scheduleTransferCountdown(t.code, t.expiresAt);
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
			if (hasAttempted) logError("MongoDB Failed", error);
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

	void connectMongoWithRetry().catch((error) => logError("MongoDB startup check failed", error));

	void Promise.all([getRedisStatus(), getR2Status()]).then(([redisStatus, r2Status]) => {
		if (!process.env.UPSTASH_REDIS_REST_URL) {
			logEvent("Redis Optional Cache Disabled");
		} else if (redisStatus === "connected") {
			logSuccess("Redis Connected");
		} else {
			logWarn("Redis Unavailable (optional)");
		}
		if (r2Status === "connected") logSuccess("R2 Connected");
		else logError("R2 Failed", null);
	}).catch((error) => logError("Service startup checks failed", error));

	if (!process.env.GEMINI_API_KEY) {
		logEvent("Gemini Optional AI Disabled");
	} else if (checkGeminiConnection()) {
		logSuccess("Gemini Connected");
	} else {
		logWarn("Gemini Unavailable (optional)");
	}

	if (process.env.SENTRY_DSN) logSuccess("Sentry Enabled");
	else logEvent("Sentry Disabled");
}

function startServer() {
	initSocket(server);
	const port = Number(process.env.PORT) || 3001;
	const host = process.env.HOST || "0.0.0.0";
	let retryTimer = null;
	const isNodemonRuntime = Boolean(process.env.nodemon) || /nodemon/i.test(String(process.env.npm_lifecycle_script || ""));

	server.on("error", (error) => {
		if (error?.code === "EADDRINUSE") {
			if (!isNodemonRuntime) { logError(`Port ${port} already in use`, error); process.exit(1); return; }
			logEvent(`Port ${port} in use, retrying in 1200ms`);
			if (!retryTimer) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					if (!isShuttingDown) server.listen(port, host);
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
	if (isShuttingDown) return;
	isShuttingDown = true;
	logEvent(`${signal} received, shutting down gracefully`);

	const forceTimer = setTimeout(() => { logError("Forced exit after shutdown timeout", null); process.exit(1); }, 8000);
	forceTimer.unref();

	try {
		const { getIo } = require("./config/socket");
		const io = typeof getIo === "function" ? getIo() : null;
		if (io) await new Promise((resolve) => { io.close(resolve); });
	} catch { /* socket cleanup is best-effort */ }

	await new Promise((resolve) => { server.close(() => resolve()); });

	try { await mongoose.connection.close(); } catch (error) { logError("MongoDB close during shutdown failed", error); }

	if (typeof onComplete === "function") { onComplete(); return; }
	process.exit(0);
}

startServer();

// Keep Render free tier awake during active sessions
const SELF_PING_URL = (process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || "").replace(/\/+$/, "");
if (SELF_PING_URL && isProduction) {
	setInterval(() => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		fetch(`${SELF_PING_URL}/api/ping`, { signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timer));
	}, 10 * 60 * 1000);
}

process.on("unhandledRejection", (reason) => {
	logError("Unhandled promise rejection", reason instanceof Error ? reason : new Error(String(reason)));
	try { Sentry.captureException(reason); } catch { /* sentry optional */ }
});

process.on("uncaughtException", (error) => {
	logError("Uncaught exception", error);
	try { Sentry.captureException(error); } catch { /* sentry optional */ }
	// Only shut down for truly fatal errors — stream/busboy errors are non-fatal
	const isStreamError = error?.code === "ERR_STREAM_DESTROYED"
		|| error?.code === "ECONNRESET"
		|| error?.code === "EPIPE"
		|| /truncated|busboy|stream/i.test(error?.message || "");
	if (!isStreamError) void gracefulShutdown("uncaughtException");
});

process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

if (Boolean(process.env.nodemon) || /nodemon/i.test(String(process.env.npm_lifecycle_script || ""))) {
	process.once("SIGUSR2", () => {
		void gracefulShutdown("SIGUSR2", () => { process.kill(process.pid, "SIGUSR2"); });
	});
}
