const { Redis } = require("@upstash/redis");

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = redisUrl && redisToken
	? new Redis({
		url: redisUrl,
		token: redisToken,
	})
	: null;

async function checkRedisConnection() {
	if (!redis) {
		return false;
	}

	try {
		const result = await Promise.race([
			redis.ping(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
		]);
		return result === "PONG";
	} catch {
		return false;
	}
}

module.exports = {
	redis,
	checkRedisConnection,
};

