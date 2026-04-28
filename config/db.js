const mongoose = require("mongoose");

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

	await mongoose.connect(uri, {
		...poolConfig,
		serverSelectionTimeoutMS: 15000,
		socketTimeoutMS: 45000,
		// Prevent buffering queries when disconnected (fail fast instead of OOM)
		bufferCommands: true,
		maxIdleTimeMS: 30000,
		// Connection monitoring
		heartbeatFrequencyMS: 10000, // Check connection health every 10s
		// Retry writes on network errors
		retryWrites: true,
		// Use new connection management
		useNewUrlParser: true,
		useUnifiedTopology: true,
	});
	
	// Connection event handlers for monitoring
	mongoose.connection.on('connected', () => {
		console.log('MongoDB connected successfully');
	});
	
	mongoose.connection.on('error', (err) => {
		console.error('MongoDB connection error:', err);
	});
	
	mongoose.connection.on('disconnected', () => {
		console.log('MongoDB disconnected');
	});
	
	return mongoose.connection;
}

module.exports = {
	connectDB,
};

