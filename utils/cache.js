// Multi-layer caching system with LRU eviction and TTL support
// L1: In-memory cache (hot data, sub-millisecond access)
// L2: Redis cache (warm data, ~1-5ms access)

const { redis } = require("../config/redis");
const { logEvent, logError } = require("./logger");

// L1 Cache: In-memory LRU cache with TTL
class LRUCache {
	constructor(maxSize = 1000, defaultTTL = 60000) {
		this.cache = new Map();
		this.maxSize = maxSize;
		this.defaultTTL = defaultTTL;
		this.hits = 0;
		this.misses = 0;
	}

	get(key) {
		const entry = this.cache.get(key);
		if (!entry) {
			this.misses++;
			return null;
		}

		// Check if expired
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			this.misses++;
			return null;
		}

		// Move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, entry);
		this.hits++;
		return entry.value;
	}

	set(key, value, ttl = this.defaultTTL) {
		// Evict oldest if at capacity
		if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
			const firstKey = this.cache.keys().next().value;
			this.cache.delete(firstKey);
		}

		this.cache.set(key, {
			value,
			expiresAt: Date.now() + ttl,
		});
	}

	delete(key) {
		return this.cache.delete(key);
	}

	clear() {
		this.cache.clear();
		this.hits = 0;
		this.misses = 0;
	}

	getStats() {
		const total = this.hits + this.misses;
		return {
			size: this.cache.size,
			maxSize: this.maxSize,
			hits: this.hits,
			misses: this.misses,
			hitRate: total > 0 ? (this.hits / total * 100).toFixed(2) + '%' : '0%',
		};
	}

	// Cleanup expired entries (run periodically)
	cleanup() {
		const now = Date.now();
		let cleaned = 0;
		for (const [key, entry] of this.cache) {
			if (now > entry.expiresAt) {
				this.cache.delete(key);
				cleaned++;
			}
		}
		return cleaned;
	}
}

// Global L1 caches for different data types
const transferMetadataCache = new LRUCache(500, 30000); // 30s TTL for transfer metadata
const nearbyDevicesCache = new LRUCache(200, 15000); // 15s TTL for nearby devices
const healthCheckCache = new LRUCache(10, 15000); // 15s TTL for health checks
const statsCache = new LRUCache(50, 60000); // 60s TTL for stats

// Cleanup expired entries every 5 minutes
setInterval(() => {
	const cleaned = transferMetadataCache.cleanup() +
		nearbyDevicesCache.cleanup() +
		healthCheckCache.cleanup() +
		statsCache.cleanup();
	if (cleaned > 0) {
		logEvent(`Cache cleanup: removed ${cleaned} expired entries`);
	}
}, 5 * 60 * 1000).unref();

// L2 Cache: Redis-backed cache with fallback
async function getFromRedis(key) {
	if (!redis) return null;
	try {
		const value = await redis.get(key);
		return value ? JSON.parse(value) : null;
	} catch (error) {
		logError("Redis get failed", error, `KEY: ${key}`);
		return null;
	}
}

async function setInRedis(key, value, ttlSeconds = 60) {
	if (!redis) return false;
	try {
		await redis.setex(key, ttlSeconds, JSON.stringify(value));
		return true;
	} catch (error) {
		logError("Redis set failed", error, `KEY: ${key}`);
		return false;
	}
}

async function deleteFromRedis(key) {
	if (!redis) return false;
	try {
		await redis.del(key);
		return true;
	} catch (error) {
		logError("Redis delete failed", error, `KEY: ${key}`);
		return false;
	}
}

// Multi-layer cache get: L1 -> L2 -> fallback
async function getCached(key, fetchFn, options = {}) {
	const {
		l1Cache = transferMetadataCache,
		l1TTL = 30000,
		l2TTL = 60,
		skipL1 = false,
		skipL2 = false,
	} = options;

	// Try L1 cache first
	if (!skipL1) {
		const l1Value = l1Cache.get(key);
		if (l1Value !== null) {
			return l1Value;
		}
	}

	// Try L2 cache (Redis)
	if (!skipL2) {
		const l2Value = await getFromRedis(key);
		if (l2Value !== null) {
			// Populate L1 cache
			if (!skipL1) {
				l1Cache.set(key, l2Value, l1TTL);
			}
			return l2Value;
		}
	}

	// Cache miss - fetch from source
	try {
		const value = await fetchFn();
		if (value !== null && value !== undefined) {
			// Populate both caches
			if (!skipL1) {
				l1Cache.set(key, value, l1TTL);
			}
			if (!skipL2) {
				await setInRedis(key, value, l2TTL);
			}
		}
		return value;
	} catch (error) {
		logError("Cache fetch function failed", error, `KEY: ${key}`);
		throw error;
	}
}

// Invalidate cache entry across all layers
async function invalidateCache(key, l1Cache = transferMetadataCache) {
	l1Cache.delete(key);
	await deleteFromRedis(key);
}

// Get cache statistics
function getCacheStats() {
	return {
		transferMetadata: transferMetadataCache.getStats(),
		nearbyDevices: nearbyDevicesCache.getStats(),
		healthCheck: healthCheckCache.getStats(),
		stats: statsCache.getStats(),
	};
}

module.exports = {
	LRUCache,
	transferMetadataCache,
	nearbyDevicesCache,
	healthCheckCache,
	statsCache,
	getCached,
	invalidateCache,
	getCacheStats,
	getFromRedis,
	setInRedis,
	deleteFromRedis,
};
