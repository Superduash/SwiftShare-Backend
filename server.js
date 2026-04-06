require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const { connectDB } = require("./config/db");
const { checkRedisConnection } = require("./config/redis");
const { r2Client } = require("./config/r2");
const { getGeminiModel } = require("./config/gemini");
const { initSocket } = require("./config/socket");

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(helmet());
app.use(express.json());

app.get("/api/health", (req, res) => {
	res.json({ status: "ok" });
});

async function startServer() {
	// Ensure SDK clients are initialized without doing feature-level calls.
	if (!r2Client) {
		throw new Error("R2 client failed to initialize");
	}

	if (!getGeminiModel()) {
		throw new Error("Gemini client failed to initialize");
	}

	initSocket(server);

	const port = Number(process.env.PORT) || 3001;
	server.listen(port, () => {
		console.log(`Server listening on port ${port}`);
	});

	// Keep retrying external connections so dev server does not crash on transient network/DNS issues.
	const mongoRetryMs = 5000;
	const redisRetryMs = 5000;

	const tryConnectMongo = async () => {
		try {
			await connectDB();
			console.log("MongoDB connected");
		} catch (error) {
			console.error(`MongoDB connection failed: ${error.message}`);
			setTimeout(tryConnectMongo, mongoRetryMs);
		}
	};

	const tryConnectRedis = async () => {
		try {
			await checkRedisConnection();
			console.log("Redis connected");
		} catch (error) {
			console.error(`Redis connection failed: ${error.message}`);
			setTimeout(tryConnectRedis, redisRetryMs);
		}
	};

	void tryConnectMongo();
	void tryConnectRedis();
}

startServer().catch((error) => {
	console.error("Server failed to start:", error.message);
	process.exit(1);
});

