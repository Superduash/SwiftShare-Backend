const { Ratelimit } = require("@upstash/ratelimit");
const { Redis } = require("@upstash/redis");

const { getClientIp } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logEvent, logError } = require("../utils/logger");

const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
let devBypassLogged = false;

function createRedisClient() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!url || !token) {
		return null;
	}

	try {
		return new Redis({ url, token });
	} catch (error) {
		logError("Redis client init failed", error);
		return null;
	}
}

const redis = createRedisClient();

function createLimiter(limit, window, prefix) {
	if (!redis) {
		return null;
	}

	return new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(limit, window),
		prefix,
	});
}

const uploadLimiter = createLimiter(30, "1 h", "swiftshare:rl:upload");
const downloadLimiter = createLimiter(60, "1 h", "swiftshare:rl:download");
const metadataLimiter = createLimiter(120, "1 h", "swiftshare:rl:metadata");
const statsLimiter = createLimiter(30, "1 h", "swiftshare:rl:stats");
const RATE_LIMIT_MESSAGE = "Rate limit active: You are sending files too quickly. Please wait a moment.";

function createRateLimitMiddleware(limiter) {
	return async (req, res, next) => {
		try {
			if (!isProduction) {
				if (!devBypassLogged) {
					devBypassLogged = true;
					logEvent("Dev Mode: rate limiting disabled");
				}
				return next();
			}

			if (!limiter) {
				return next();
			}

			const ip = getClientIp(req) || "unknown";
			const result = await limiter.limit(ip);

			if (!result.success) {
				logEvent(
					"Rate limit triggered",
					`IP: ${ip}`,
					`PATH: ${req.method} ${req.originalUrl}`,
				);
				const payload = buildErrorResponse(
					ERROR_CODES.RATE_LIMIT_EXCEEDED,
					RATE_LIMIT_MESSAGE,
				);
				return res
					.status(429)
					.json({ ...payload, message: RATE_LIMIT_MESSAGE });
			}

			return next();
		} catch (error) {
			logError("Rate limiter fallback (allow request)", error);
			return next();
		}
	};
}

module.exports = {
	rateLimitUpload: createRateLimitMiddleware(uploadLimiter),
	rateLimitDownload: createRateLimitMiddleware(downloadLimiter),
	rateLimitMetadata: createRateLimitMiddleware(metadataLimiter),
	rateLimitStats: createRateLimitMiddleware(statsLimiter),
};

