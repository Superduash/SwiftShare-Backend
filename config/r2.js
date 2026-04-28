const { S3Client, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const https = require("https");
const http = require("http");

const required = [
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_BUCKET_NAME",
];

const isR2Configured = required.every((key) => Boolean(process.env[key]));

// Reuse TCP/TLS connections for every R2 call. Default Node agents close-after-each-request,
// so on slow/mobile networks we'd pay the TLS handshake cost (~200-500ms) per part of a
// multipart upload — devastating on Render's 0.1 CPU. Keep-alive cuts upload latency
// dramatically and lets Upload's 4-way concurrency actually parallelize.
const r2KeepAliveSocketsRaw = Number(process.env.R2_KEEPALIVE_MAX_SOCKETS);
const maxSockets = Number.isFinite(r2KeepAliveSocketsRaw) && r2KeepAliveSocketsRaw > 0
	? r2KeepAliveSocketsRaw
	: 50;

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets, keepAliveMsecs: 15000 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets, keepAliveMsecs: 15000 });

const connectionTimeoutMs = Number(process.env.R2_CONNECTION_TIMEOUT_MS) > 0
	? Number(process.env.R2_CONNECTION_TIMEOUT_MS)
	: 8000;
const socketTimeoutMs = Number(process.env.R2_SOCKET_TIMEOUT_MS) > 0
	? Number(process.env.R2_SOCKET_TIMEOUT_MS)
	: 120000;
const maxAttempts = Number(process.env.R2_MAX_ATTEMPTS) > 0
	? Number(process.env.R2_MAX_ATTEMPTS)
	: 4;

const r2Client = isR2Configured
	? new S3Client({
		region: process.env.R2_REGION || "auto",
		endpoint:
			process.env.R2_ENDPOINT ||
			`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY_ID,
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
		},
		// SDK retries transient errors (5xx, throttling, network) up to maxAttempts
		// using its built-in adaptive backoff. We add an outer retry layer in
		// fileManager.js for getObject/headObject/deleteObject — the SDK does not
		// retry stream-body GETs once the stream has begun, but our wrapper handles
		// pre-stream failures and head/delete idempotency.
		maxAttempts,
		requestHandler: new NodeHttpHandler({
			httpsAgent,
			httpAgent,
			connectionTimeout: connectionTimeoutMs,
			socketTimeout: socketTimeoutMs,
		}),
	})
	: null;

async function checkR2Connection() {
	if (!isR2Configured || !r2Client) {
		return false;
	}

	try {
		await r2Client.send(
			new HeadBucketCommand({
				Bucket: process.env.R2_BUCKET_NAME,
			}),
		);
		return true;
	} catch (error) {
		return false;
	}
}

module.exports = {
	r2Client,
	r2Bucket: process.env.R2_BUCKET_NAME || "",
	isR2Configured,
	checkR2Connection,
};
