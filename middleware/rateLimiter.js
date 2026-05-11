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
// Text snippets: cheaper than file uploads, but still abuse-worthy. 60/h is
// generous for legit users (paste a snippet every minute) while choking spam.
const textShareLimiter = createLimiter(60, "1 h", "swiftshare:rl:text");
// Password verification: separate per-IP cap stops credential stuffing across
// many transfers in a short window. Per-transfer attempts are tracked elsewhere.
const passwordLimiter = createLimiter(30, "10 m", "swiftshare:rl:password");
const RATE_LIMIT_MESSAGE = "Rate limit active: You are sending files too quickly. Please wait a moment.";

// IP-based rate limiting fallback (optimized with LRU-style cleanup)
const ipRateLimitMap = new Map();
const IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IP_RATE_LIMIT_MAX_REQUESTS = 100; // Generous fallback limit
const MAX_IP_ENTRIES = 10000; // Prevent memory bloat

function ipBasedRateLimit(ip, maxRequests = IP_RATE_LIMIT_MAX_REQUESTS) {
	const now = Date.now();
	const entry = ipRateLimitMap.get(ip);

	if (!entry) {
		// Prevent memory bloat: if map is too large, clear expired entries
		if (ipRateLimitMap.size > MAX_IP_ENTRIES) {
			for (const [key, val] of ipRateLimitMap) {
				if (now > val.resetAt) {
					ipRateLimitMap.delete(key);
				}
			}
		}
		ipRateLimitMap.set(ip, { count: 1, resetAt: now + IP_RATE_LIMIT_WINDOW_MS });
		return { success: true };
	}

	if (now > entry.resetAt) {
		entry.count = 1;
		entry.resetAt = now + IP_RATE_LIMIT_WINDOW_MS;
		return { success: true };
	}

	if (entry.count >= maxRequests) {
		return { success: false };
	}

	entry.count++;
	return { success: true };
}

// Cleanup old IP rate limit entries every 15 minutes (less frequent = better performance)
setInterval(() => {
	try {
		const now = Date.now();
		// Batch delete for better performance
		const toDelete = [];
		for (const [ip, entry] of ipRateLimitMap) {
			if (now > entry.resetAt) {
				toDelete.push(ip);
			}
		}
		for (const ip of toDelete) {
			ipRateLimitMap.delete(ip);
		}
	} catch (err) {
		logError("IP rate limit cleanup crashed", err);
	}
}, 15 * 60 * 1000).unref(); // unref to not block process exit

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

			const ip = getClientIp(req) || "unknown";

			// Try Redis-based rate limiting first
			if (limiter) {
				try {
					const result = await limiter.limit(ip);

					if (!result.success) {
						logEvent(
							"Rate limit triggered (Redis)",
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
				} catch (redisError) {
					logError("Redis rate limiter failed, falling back to IP-based", redisError);
					// Fall through to IP-based rate limiting
				}
			}

			// Fallback to IP-based rate limiting
			const ipResult = ipBasedRateLimit(ip);
			if (!ipResult.success) {
				logEvent(
					"Rate limit triggered (IP-based fallback)",
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
	rateLimitText: createRateLimitMiddleware(textShareLimiter),
	rateLimitPassword: createRateLimitMiddleware(passwordLimiter),
};

