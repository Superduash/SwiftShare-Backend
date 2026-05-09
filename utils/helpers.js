const path = require("path");
const crypto = require("crypto");

const BLOCKED_EXTENSIONS = new Set([
	".exe",
	".bat",
	".sh",
	".cmd",
	".msi",
	".scr",
	".com",
	".vbs",
	".ps1",
	".jar",
]);

const DANGEROUS_SIGNATURES = [
	Buffer.from([0x4d, 0x5a]), // MZ (Windows PE)
	Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF (Linux executable)
	Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O universal binary
	Buffer.from([0xfe, 0xed, 0xfa, 0xce]), // Mach-O 32-bit
	Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), // Mach-O 64-bit
];

/**
 * Safely parse environment variable as positive integer with fallback
 * @param {string} value - Environment variable value
 * @param {number} defaultValue - Fallback value if parsing fails
 * @param {number} [min] - Optional minimum value
 * @param {number} [max] - Optional maximum value
 * @returns {number} Parsed integer or default
 */
function parseEnvInt(value, defaultValue, min = 0, max = Infinity) {
	try {
		const parsed = Number(value);
		if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
			return defaultValue;
		}
		return Math.floor(parsed);
	} catch {
		return defaultValue;
	}
}

function getClientIp(req) {
	try {
		const forwarded = req.headers["x-forwarded-for"];

		if (typeof forwarded === "string" && forwarded.length > 0) {
			return normalizeIp(forwarded.split(",")[0].trim());
		}

		if (Array.isArray(forwarded) && forwarded.length > 0) {
			return normalizeIp(String(forwarded[0]).trim());
		}

		return normalizeIp(req.socket?.remoteAddress || req.ip || "");
	} catch {
		return "127.0.0.1"; // Fallback for any parsing errors
	}
}

function normalizeIp(ip) {
	const raw = String(ip || "").trim();
	
	// Handle IPv6-mapped IPv4 addresses (::ffff:192.168.1.1 -> 192.168.1.1)
	if (raw.startsWith("::ffff:")) {
		return raw.replace("::ffff:", "");
	}
	
	// Handle IPv6 localhost (::1 -> 127.0.0.1 for consistency)
	if (raw === "::1") {
		return "127.0.0.1";
	}
	
	return raw;
}

function getSubnet(ip) {
	try {
		const normalized = normalizeIp(ip);
		
		// Handle IPv6 addresses - return empty (not supported for nearby devices)
		if (normalized.includes(":")) {
			return "";
		}
		
		// Handle IPv4
		if (!normalized.includes(".")) {
			return "";
		}

		const octets = normalized.split(".");
		if (octets.length !== 4) {
			return "";
		}
		
		// Validate each octet is a number 0-255
		for (const octet of octets) {
			const num = Number(octet);
			if (!Number.isFinite(num) || num < 0 || num > 255) {
				return "";
			}
		}

		// Return first 3 octets for /24 subnet
		return `${octets[0]}.${octets[1]}.${octets[2]}`;
	} catch {
		return ""; // Fallback for any parsing errors
	}
}

function getDeviceName(userAgent = "") {
	const ua = String(userAgent || "");

	let browser = "Browser";
	if (/Edg\//i.test(ua)) {
		browser = "Edge";
	} else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) {
		browser = "Opera";
	} else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) {
		browser = "Chrome";
	} else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
		browser = "Safari";
	} else if (/Firefox\//i.test(ua)) {
		browser = "Firefox";
	}

	let platform = "Device";
	if (/iPhone/i.test(ua)) {
		platform = "iPhone";
	} else if (/iPad/i.test(ua)) {
		platform = "iPad";
	} else if (/Android/i.test(ua)) {
		platform = "Android";
	} else if (/Windows/i.test(ua)) {
		platform = "Windows";
	} else if (/Mac OS X|Macintosh/i.test(ua)) {
		platform = "Mac";
	} else if (/Linux/i.test(ua)) {
		platform = "Linux";
	}

	return `${browser} on ${platform}`;
}

function mimeToIcon(mimeType = "") {
	const mime = String(mimeType || "").toLowerCase();

	if (mime.includes("pdf")) {
		return "pdf";
	}
	if (mime.startsWith("image/")) {
		return "image";
	}
	if (mime.startsWith("video/")) {
		return "video";
	}
	if (mime.includes("zip") || mime.includes("compressed")) {
		return "zip";
	}
	if (mime.includes("word") || mime.includes("msword") || mime.includes("officedocument.wordprocessingml")) {
		return "doc";
	}

	return "file";
}

function formatBytes(bytes) {
	const value = Number(bytes || 0);
	if (value <= 0) {
		return "0 B";
	}

	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	const size = value / Math.pow(1024, exponent);
	return `${size.toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function sanitizeFilename(name = "file") {
	const baseName = path.basename(String(name));
	const sanitized = baseName
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim();

	if (!sanitized) {
		return `file_${Date.now()}`;
	}

	return sanitized;
}

function isBlockedExtension(name = "") {
	const extension = path.extname(String(name || "")).toLowerCase();
	return BLOCKED_EXTENSIONS.has(extension);
}

function hasDangerousSignature(bufferLike) {
	if (!bufferLike) {
		return false;
	}

	const buffer = Buffer.isBuffer(bufferLike)
		? bufferLike
		: Buffer.from(bufferLike);

	for (const signature of DANGEROUS_SIGNATURES) {
		if (buffer.length < signature.length) {
			continue;
		}

		if (buffer.subarray(0, signature.length).equals(signature)) {
			return true;
		}
	}

	return false;
}

function getTotalSize(files = []) {
	return files.reduce((total, file) => total + Number(file?.size || 0), 0);
}

function isTransferExpired(transfer) {
	return Boolean(transfer?.expiresAt) && new Date(transfer.expiresAt).getTime() < Date.now();
}

function getRequestFingerprint(req) {
	try {
		const ip = getClientIp(req);
		const userAgent = String(req?.get?.("user-agent") || req?.headers?.["user-agent"] || "");
		return crypto
			.createHash("sha256")
			.update(`${ip}|${userAgent}`)
			.digest("hex");
	} catch {
		// Fallback fingerprint if hashing fails
		return crypto.randomBytes(16).toString("hex");
	}
}

function isBurnClaimOwner(transfer, reqOrFingerprint) {
	if (!transfer?.burnClaimOwner) {
		return false;
	}

	const fingerprint = typeof reqOrFingerprint === "string"
		? reqOrFingerprint
		: getRequestFingerprint(reqOrFingerprint);

	return transfer.burnClaimOwner === fingerprint;
}

function isBurnClaimOpen(transfer) {
	return Boolean(transfer?.burnAfterDownload && transfer?.burnClaimOwner && !transfer?.isDeleted);
}

function getTransferStatus(transfer) {
	if (!transfer) {
		return "DELETED";
	}

	if (transfer.isDeleted && transfer.cancelledAt) {
		return "CANCELLED";
	}

	if (transfer.isDeleted) {
		return "DELETED";
	}

	if (isBurnClaimOpen(transfer)) {
		return "CLAIMED";
	}

	if (isTransferExpired(transfer)) {
		return "EXPIRED";
	}

	return "ACTIVE";
}

module.exports = {
	getClientIp,
	getSubnet,
	getDeviceName,
	mimeToIcon,
	formatBytes,
	sanitizeFilename,
	isBlockedExtension,
	hasDangerousSignature,
	getTotalSize,
	isTransferExpired,
	getRequestFingerprint,
	isBurnClaimOwner,
	isBurnClaimOpen,
	getTransferStatus,
	parseEnvInt,
	// Backward-compatible aliases used by existing Hour 1-3 code.
	extractClientIp: getClientIp,
	parseDeviceName: getDeviceName,
};

