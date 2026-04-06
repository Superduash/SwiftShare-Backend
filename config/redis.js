const { Redis } = require("@upstash/redis");

if (!process.env.UPSTASH_REDIS_REST_URL) {
	throw new Error("UPSTASH_REDIS_REST_URL is not set in environment variables");
}

if (!process.env.UPSTASH_REDIS_REST_TOKEN) {
	throw new Error("UPSTASH_REDIS_REST_TOKEN is not set in environment variables");
}

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function checkRedisConnection() {
	await redis.ping();
}

module.exports = {
	redis,
	checkRedisConnection,
};

