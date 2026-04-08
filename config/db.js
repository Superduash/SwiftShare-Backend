const mongoose = require("mongoose");

async function connectDB() {
	const uri = process.env.MONGODB_URI;

	if (!uri) {
		throw new Error("MONGODB_URI is not set in environment variables");
	}

	await mongoose.connect(uri, {
		// Constrained for Render free tier (512MB RAM, 0.1 CPU)
		maxPoolSize: 5,
		minPoolSize: 1,
		serverSelectionTimeoutMS: 15000,
		socketTimeoutMS: 45000,
		// Prevent buffering queries when disconnected (fail fast instead of OOM)
		bufferCommands: true,
		maxIdleTimeMS: 30000,
	});
	return mongoose.connection;
}

module.exports = {
	connectDB,
};

