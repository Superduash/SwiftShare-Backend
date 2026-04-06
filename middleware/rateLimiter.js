const { Ratelimit } = require("@upstash/ratelimit");
const { Redis } = require("@upstash/redis");

const { getClientIp } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

function createRedisClient() {
	const url = process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!url || !token) {
		return null;
	}

	try {
		return new Redis({ url, token });
	} catch (error) {
		console.error(`Redis client init failed: ${error.message}`);
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

function createRateLimitMiddleware(limiter) {
	return async (req, res, next) => {
		try {
			if (!limiter) {
				return next();
			}

			const ip = getClientIp(req) || "unknown";
			const result = await limiter.limit(ip);

			if (!result.success) {
				return res
					.status(429)
					.json(buildErrorResponse(ERROR_CODES.RATE_LIMIT_EXCEEDED));
			}

			return next();
		} catch (error) {
			console.error(`Rate limiter fallback (allow request): ${error.message}`);
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

