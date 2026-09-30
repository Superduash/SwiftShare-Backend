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
const textShareLimiter = createLimiter(60, "1 h", "swiftshare:rl:text");
const passwordLimiter = createLimiter(30, "10 m", "swiftshare:rl:password");
const pageViewLimiter = createLimiter(120, "1 h", "swiftshare:rl:pv");
const adminLoginLimiter = createLimiter(5, "15 m", "swiftshare:rl:admin:login");

const RATE_LIMIT_MESSAGE = "Rate limit active: You are sending files too quickly. Please wait a moment.";

// IP-based rate limiting fallback (optimized with LRU-style cleanup)
const ipRateLimitMap = new Map();
const IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IP_RATE_LIMIT_MAX_REQUESTS = 100; // Generous fallback limit
const MAX_IP_ENTRIES = 10000; // Prevent memory bloat

// Admin login attempt & lockout map
const adminLockoutMap = new Map();

function checkAdminLoginLockout(ip) {
	const now = Date.now();
	const entry = adminLockoutMap.get(ip);
	if (!entry) return { locked: false };

	if (entry.lockedUntil && now < entry.lockedUntil) {
		const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
		return { locked: true, retryAfter };
	}

	// Reset if 24h window passed
	if (entry.firstAttempt && now - entry.firstAttempt > 24 * 60 * 60 * 1000) {
		adminLockoutMap.delete(ip);
		return { locked: false };
	}

	return { locked: false };
}

function recordAdminLoginFailure(ip) {
	const now = Date.now();
	const entry = adminLockoutMap.get(ip) || { failures: 0, firstAttempt: now, failures24h: 0 };

	entry.failures += 1;
	entry.failures24h += 1;

	// Progressive lockout:
	// 5 failures -> 15 min lockout
	// 10 failures in 24h -> 1 hr lockout
	if (entry.failures24h >= 10) {
		entry.lockedUntil = now + 60 * 60 * 1000; // 1 hour
		entry.failures = 0;
	} else if (entry.failures >= 5) {
		entry.lockedUntil = now + 15 * 60 * 1000; // 15 mins
		entry.failures = 0;
	}

	adminLockoutMap.set(ip, entry);
	return entry.lockedUntil ? Math.ceil((entry.lockedUntil - now) / 1000) : null;
}

function clearAdminLoginFailures(ip) {
	adminLockoutMap.delete(ip);
}

function ipBasedRateLimit(ip, maxRequests = IP_RATE_LIMIT_MAX_REQUESTS, windowMs = IP_RATE_LIMIT_WINDOW_MS) {
	const now = Date.now();
	const entry = ipRateLimitMap.get(ip);

	if (!entry) {
		if (ipRateLimitMap.size > MAX_IP_ENTRIES) {
			for (const [key, val] of ipRateLimitMap) {
				if (now > val.resetAt) {
					ipRateLimitMap.delete(key);
				}
			}
		}
		ipRateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
		return { success: true };
	}

	if (now > entry.resetAt) {
		entry.count = 1;
		entry.resetAt = now + windowMs;
		return { success: true };
	}

	if (entry.count >= maxRequests) {
		return { success: false, resetAt: entry.resetAt };
	}

	entry.count++;
	return { success: true };
}

// Cleanup old IP rate limit entries every 15 minutes (less frequent = better performance)
setInterval(() => {
	try {
		const now = Date.now();
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
}, 15 * 60 * 1000).unref();

function createRateLimitMiddleware(limiter, fallbackLimit = IP_RATE_LIMIT_MAX_REQUESTS, fallbackWindowMs = IP_RATE_LIMIT_WINDOW_MS) {
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
						if (result.reset) {
							const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
							res.setHeader('Retry-After', String(retryAfterSeconds));
						}
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
			const ipResult = ipBasedRateLimit(ip, fallbackLimit, fallbackWindowMs);
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
				const entry = ipRateLimitMap.get(ip);
				if (entry?.resetAt) {
					const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
					res.setHeader('Retry-After', String(retryAfterSeconds));
				}
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

// Dedicated Admin Login Rate Limiter (5 attempts / 15 min + progressive lockout)
function rateLimitAdminLogin(req, res, next) {
	try {
		const ip = getClientIp(req) || "unknown";

		// Check active lockout
		const lockout = checkAdminLoginLockout(ip);
		if (lockout.locked) {
			res.setHeader("Retry-After", String(lockout.retryAfter));
			return res.status(429).json({
				error: "Too many failed login attempts. Account temporarily locked.",
				retryAfter: lockout.retryAfter,
			});
		}

		if (adminLoginLimiter) {
			adminLoginLimiter.limit(ip).then((result) => {
				if (!result.success) {
					const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
					res.setHeader("Retry-After", String(retryAfter));
					return res.status(429).json({
						error: "Too many login attempts. Please try again later.",
						retryAfter,
					});
				}
				next();
			}).catch((err) => {
				logError("Admin Redis rate limiter failed, falling back to in-memory", err);
				const fallback = ipBasedRateLimit(`admin_login:${ip}`, 5, 15 * 60 * 1000);
				if (!fallback.success) {
					const retryAfter = Math.max(1, Math.ceil(((fallback.resetAt || Date.now() + 900000) - Date.now()) / 1000));
					res.setHeader("Retry-After", String(retryAfter));
					return res.status(429).json({
						error: "Too many login attempts. Please try again later.",
						retryAfter,
					});
				}
				next();
			});
			return;
		}

		// In-memory fallback
		const fallback = ipBasedRateLimit(`admin_login:${ip}`, 5, 15 * 60 * 1000);
		if (!fallback.success) {
			const retryAfter = Math.max(1, Math.ceil(((fallback.resetAt || Date.now() + 900000) - Date.now()) / 1000));
			res.setHeader("Retry-After", String(retryAfter));
			return res.status(429).json({
				error: "Too many login attempts. Please try again later.",
				retryAfter,
			});
		}
		next();
	} catch (err) {
		logError("Admin rate limit error", err);
		next();
	}
}

module.exports = {
	rateLimitUpload: createRateLimitMiddleware(uploadLimiter),
	rateLimitDownload: createRateLimitMiddleware(downloadLimiter),
	rateLimitMetadata: createRateLimitMiddleware(metadataLimiter),
	rateLimitStats: createRateLimitMiddleware(statsLimiter),
	rateLimitText: createRateLimitMiddleware(textShareLimiter),
	rateLimitPassword: createRateLimitMiddleware(passwordLimiter),
	rateLimitPageView: createRateLimitMiddleware(pageViewLimiter, 120, 60 * 60 * 1000),
	rateLimitAdminLogin,
	recordAdminLoginFailure,
	clearAdminLoginFailures,
	checkAdminLoginLockout,
};

