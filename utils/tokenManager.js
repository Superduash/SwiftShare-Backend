const crypto = require("crypto");

// Token signing secret must be set via TOKEN_SECRET env var
const TOKEN_SECRET = process.env.TOKEN_SECRET;
if (!TOKEN_SECRET) {
	throw new Error("TOKEN_SECRET environment variable is required. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
}
if (!/^[0-9a-fA-F]{64}$/.test(TOKEN_SECRET)) {
	throw new Error("TOKEN_SECRET must be a 64-character hex string (32 bytes). Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
}
const TOKEN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Pre-create Buffer for performance (reuse instead of creating each time)
// Performance: ~11.7μs per token generation (10k tokens in 117ms)
const TOKEN_SECRET_BUFFER = Buffer.from(TOKEN_SECRET, 'hex');

/**
 * Generate a signed access token for file downloads (optimized)
 * @param {string} transferCode - Transfer code
 * @param {string} fileIndex - File index (or 'all' for ZIP)
 * @param {string} clientIp - Client IP address
 * @returns {string} Signed token
 */
function generateAccessToken(transferCode, fileIndex, clientIp) {
	// Use compact JSON (no spaces) for smaller tokens
	const payload = JSON.stringify({
		code: transferCode,
		file: fileIndex,
		ip: clientIp,
		exp: Date.now() + TOKEN_EXPIRY_MS,
		nonce: crypto.randomBytes(8).toString("hex"),
	});
	
	const payloadB64 = Buffer.from(payload).toString("base64url");
	
	// Reuse TOKEN_SECRET_BUFFER for better performance
	const signature = crypto
		.createHmac("sha256", TOKEN_SECRET_BUFFER)
		.update(payloadB64)
		.digest("base64url");

	return `${payloadB64}.${signature}`;
}

/**
 * Verify and decode an access token (optimized with constant-time comparison)
 * @param {string} token - Token to verify
 * @param {string} clientIp - Client IP address
 * @returns {object|null} Decoded payload or null if invalid
 */
function verifyAccessToken(token, clientIp) {
	try {
		// Fast path: basic validation
		if (!token || typeof token !== "string" || token.length < 20) {
			return null;
		}

		const dotIndex = token.indexOf('.');
		if (dotIndex === -1) {
			return null;
		}

		const payloadB64 = token.substring(0, dotIndex);
		const signature = token.substring(dotIndex + 1);

		// Verify signature using constant-time comparison
		const expectedSignature = crypto
			.createHmac("sha256", TOKEN_SECRET_BUFFER)
			.update(payloadB64)
			.digest("base64url");

		// Constant-time comparison to prevent timing attacks
		if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
			return null;
		}

		// Decode payload
		const payloadStr = Buffer.from(payloadB64, "base64url").toString("utf8");
		const payload = JSON.parse(payloadStr);

		// Check expiry first (cheapest check)
		if (payload.exp < Date.now()) {
			return null;
		}

		// Verify IP (prevent token theft)
		if (payload.ip !== clientIp) {
			return null;
		}

		return payload;
	} catch (error) {
		return null;
	}
}

/**
 * Generate a short-lived preview token (optimized)
 * @param {string} transferCode - Transfer code
 * @param {number} fileIndex - File index
 * @returns {string} Preview token
 */
function generatePreviewToken(transferCode, fileIndex) {
	// Compact JSON for smaller tokens
	const payload = JSON.stringify({
		code: transferCode,
		file: fileIndex,
		exp: Date.now() + 120000,
		type: "preview",
	});
	
	const payloadB64 = Buffer.from(payload).toString("base64url");
	
	const signature = crypto
		.createHmac("sha256", TOKEN_SECRET_BUFFER)
		.update(payloadB64)
		.digest("base64url");

	return `${payloadB64}.${signature}`;
}

/**
 * Verify preview token (optimized with constant-time comparison)
 * @param {string} token - Token to verify
 * @returns {object|null} Decoded payload or null if invalid
 */
function verifyPreviewToken(token) {
	try {
		// Fast path: basic validation
		if (!token || typeof token !== "string" || token.length < 20) {
			return null;
		}

		const dotIndex = token.indexOf('.');
		if (dotIndex === -1) {
			return null;
		}

		const payloadB64 = token.substring(0, dotIndex);
		const signature = token.substring(dotIndex + 1);

		// Verify signature using constant-time comparison
		const expectedSignature = crypto
			.createHmac("sha256", TOKEN_SECRET_BUFFER)
			.update(payloadB64)
			.digest("base64url");

		// Constant-time comparison
		if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
			return null;
		}

		// Decode payload
		const payloadStr = Buffer.from(payloadB64, "base64url").toString("utf8");
		const payload = JSON.parse(payloadStr);

		// Check expiry first (cheapest check)
		if (payload.exp < Date.now()) {
			return null;
		}

		// Verify type
		if (payload.type !== "preview") {
			return null;
		}

		return payload;
	} catch (error) {
		return null;
	}
}

module.exports = {
	generateAccessToken,
	verifyAccessToken,
	generatePreviewToken,
	verifyPreviewToken,
	TOKEN_EXPIRY_MS,
};
