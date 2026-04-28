// Performance monitoring and profiling utilities
const { logEvent, logError } = require("./logger");

// Event loop lag monitoring
let eventLoopLag = 0;
let lastCheck = Date.now();

function measureEventLoopLag() {
	const now = Date.now();
	const expected = 100; // Check every 100ms
	const actual = now - lastCheck;
	eventLoopLag = Math.max(0, actual - expected);
	lastCheck = now;
}

// Start monitoring event loop lag
setInterval(measureEventLoopLag, 100).unref();

function getEventLoopLag() {
	return eventLoopLag;
}

// Memory usage tracking
function getMemoryUsage() {
	const usage = process.memoryUsage();
	return {
		heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
		heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
		external: Math.round(usage.external / 1024 / 1024), // MB
		rss: Math.round(usage.rss / 1024 / 1024), // MB
		heapUsedPercent: ((usage.heapUsed / usage.heapTotal) * 100).toFixed(2) + '%',
	};
}

// CPU usage tracking
let lastCpuUsage = process.cpuUsage();
let lastCpuCheck = Date.now();

function getCpuUsage() {
	const now = Date.now();
	const currentUsage = process.cpuUsage(lastCpuUsage);
	const elapsedMs = now - lastCpuCheck;
	
	// Calculate CPU percentage
	const userPercent = (currentUsage.user / 1000 / elapsedMs * 100).toFixed(2);
	const systemPercent = (currentUsage.system / 1000 / elapsedMs * 100).toFixed(2);
	
	lastCpuUsage = process.cpuUsage();
	lastCpuCheck = now;
	
	return {
		user: userPercent + '%',
		system: systemPercent + '%',
		total: (parseFloat(userPercent) + parseFloat(systemPercent)).toFixed(2) + '%',
	};
}

// Request timing middleware
function createTimingMiddleware() {
	return (req, res, next) => {
		const start = process.hrtime.bigint();
		
		// Track when response finishes
		res.on('finish', () => {
			const end = process.hrtime.bigint();
			const durationMs = Number(end - start) / 1000000; // Convert to ms
			
			// Add timing header
			res.setHeader('X-Response-Time', `${durationMs.toFixed(2)}ms`);
			
			// Log slow requests (> 1000ms)
			if (durationMs > 1000) {
				logEvent(
					'Slow request detected',
					`PATH: ${req.method} ${req.originalUrl}`,
					`DURATION: ${durationMs.toFixed(2)}ms`,
					`STATUS: ${res.statusCode}`
				);
			}
		});
		
		next();
	};
}

// Performance metrics aggregation
const metrics = {
	requests: {
		total: 0,
		success: 0,
		error: 0,
		byStatus: {},
	},
	timing: {
		min: Infinity,
		max: 0,
		sum: 0,
		count: 0,
	},
	uploads: {
		total: 0,
		bytes: 0,
	},
	downloads: {
		total: 0,
		bytes: 0,
	},
};

function recordRequest(statusCode, durationMs) {
	metrics.requests.total++;
	if (statusCode >= 200 && statusCode < 400) {
		metrics.requests.success++;
	} else {
		metrics.requests.error++;
	}
	metrics.requests.byStatus[statusCode] = (metrics.requests.byStatus[statusCode] || 0) + 1;
	
	metrics.timing.min = Math.min(metrics.timing.min, durationMs);
	metrics.timing.max = Math.max(metrics.timing.max, durationMs);
	metrics.timing.sum += durationMs;
	metrics.timing.count++;
}

function recordUpload(bytes) {
	metrics.uploads.total++;
	metrics.uploads.bytes += bytes;
}

function recordDownload(bytes) {
	metrics.downloads.total++;
	metrics.downloads.bytes += bytes;
}

function getMetrics() {
	const avgResponseTime = metrics.timing.count > 0
		? (metrics.timing.sum / metrics.timing.count).toFixed(2)
		: 0;
	
	return {
		requests: {
			...metrics.requests,
			successRate: metrics.requests.total > 0
				? ((metrics.requests.success / metrics.requests.total) * 100).toFixed(2) + '%'
				: '0%',
		},
		timing: {
			min: metrics.timing.min === Infinity ? 0 : metrics.timing.min.toFixed(2),
			max: metrics.timing.max.toFixed(2),
			avg: avgResponseTime,
			unit: 'ms',
		},
		uploads: {
			...metrics.uploads,
			avgSize: metrics.uploads.total > 0
				? Math.round(metrics.uploads.bytes / metrics.uploads.total)
				: 0,
		},
		downloads: {
			...metrics.downloads,
			avgSize: metrics.downloads.total > 0
				? Math.round(metrics.downloads.bytes / metrics.downloads.total)
				: 0,
		},
	};
}

function resetMetrics() {
	metrics.requests.total = 0;
	metrics.requests.success = 0;
	metrics.requests.error = 0;
	metrics.requests.byStatus = {};
	metrics.timing.min = Infinity;
	metrics.timing.max = 0;
	metrics.timing.sum = 0;
	metrics.timing.count = 0;
	metrics.uploads.total = 0;
	metrics.uploads.bytes = 0;
	metrics.downloads.total = 0;
	metrics.downloads.bytes = 0;
}

// Memory pressure detection
const MEMORY_PRESSURE_THRESHOLD = 0.85; // 85% heap usage

function isMemoryPressure() {
	const usage = process.memoryUsage();
	const heapUsedPercent = usage.heapUsed / usage.heapTotal;
	return heapUsedPercent > MEMORY_PRESSURE_THRESHOLD;
}

function checkMemoryPressure() {
	if (isMemoryPressure()) {
		const usage = getMemoryUsage();
		logEvent(
			'Memory pressure detected',
			`HEAP_USED: ${usage.heapUsed}MB / ${usage.heapTotal}MB (${usage.heapUsedPercent})`,
			'Consider triggering GC or reducing cache size'
		);
		
		// Trigger garbage collection if available
		if (global.gc) {
			global.gc();
			logEvent('Manual GC triggered');
		}
	}
}

// Check memory pressure every 30 seconds
setInterval(checkMemoryPressure, 30000).unref();

// Get comprehensive performance snapshot
function getPerformanceSnapshot() {
	return {
		eventLoopLag: `${eventLoopLag.toFixed(2)}ms`,
		memory: getMemoryUsage(),
		cpu: getCpuUsage(),
		metrics: getMetrics(),
		uptime: process.uptime(),
		memoryPressure: isMemoryPressure(),
	};
}

module.exports = {
	getEventLoopLag,
	getMemoryUsage,
	getCpuUsage,
	createTimingMiddleware,
	recordRequest,
	recordUpload,
	recordDownload,
	getMetrics,
	resetMetrics,
	isMemoryPressure,
	checkMemoryPressure,
	getPerformanceSnapshot,
};
