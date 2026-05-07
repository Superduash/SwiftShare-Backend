const mongoose = require("mongoose");
const { logEvent, logError } = require("../utils/logger");

// Dynamic pool sizing based on environment
function getPoolConfig() {
	const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
	const isRender = Boolean(process.env.RENDER);
	
	// Render free tier: 512MB RAM, 0.1 CPU - conservative pooling
	if (isRender) {
		return {
			maxPoolSize: 5,
			minPoolSize: 1,
		};
	}
	
	// Production (non-Render): more aggressive pooling
	if (isProduction) {
		return {
			maxPoolSize: 10,
			minPoolSize: 2,
		};
	}
	
	// Development: minimal pooling
	return {
		maxPoolSize: 5,
		minPoolSize: 1,
	};
}

async function connectDB() {
	const uri = process.env.MONGODB_URI;

	if (!uri) {
		throw new Error("MONGODB_URI is not set in environment variables");
	}

	const poolConfig = getPoolConfig();
	const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";

	// Ultra-fast local startup: 1s timeout in dev, 15s in production
	// Allow override via env for custom scenarios
	const defaultTimeoutMs = isProduction ? 15000 : 1000;
	const serverSelectionTimeoutMS =
		Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) > 0
			? Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS)
			: defaultTimeoutMs;

	await mongoose.connect(uri, {
		...poolConfig,
		serverSelectionTimeoutMS,
		socketTimeoutMS: 45000,
		// Prevent buffering queries when disconnected (fail fast instead of OOM)
		bufferCommands: false,
		maxIdleTimeMS: 30000,
		heartbeatFrequencyMS: 10000,
		retryWrites: true,
	});
	
	// Connection event handlers for monitoring
	mongoose.connection.on('connected', () => {
		logEvent('MongoDB connected successfully');
	});
	
	mongoose.connection.on('error', (err) => {
		logError('MongoDB connection error', err);
	});
	
	mongoose.connection.on('disconnected', () => {
		logEvent('MongoDB disconnected');
	});
	
	return mongoose.connection;
}

// Check if MongoDB is ready for queries
function isMongoReady() {
	return mongoose.connection.readyState === 1;
}

module.exports = {
	connectDB,
	isMongoReady,
};

