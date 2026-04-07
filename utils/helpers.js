const path = require("path");

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
	Buffer.from([0x4d, 0x5a]), // MZ
	Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
];

function getClientIp(req) {
	const forwarded = req.headers["x-forwarded-for"];

	if (typeof forwarded === "string" && forwarded.length > 0) {
		return normalizeIp(forwarded.split(",")[0].trim());
	}

	if (Array.isArray(forwarded) && forwarded.length > 0) {
		return normalizeIp(String(forwarded[0]).trim());
	}

	return normalizeIp(req.socket?.remoteAddress || req.ip || "");
}

function normalizeIp(ip) {
	const raw = String(ip || "").trim();
	if (raw.startsWith("::ffff:")) {
		return raw.replace("::ffff:", "");
	}
	return raw;
}

function getSubnet(ip) {
	const normalized = normalizeIp(ip);
	if (!normalized.includes(".")) {
		return "";
	}

	const octets = normalized.split(".");
	if (octets.length < 3) {
		return "";
	}

	return `${octets[0]}.${octets[1]}.${octets[2]}`;
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
	// Backward-compatible aliases used by existing Hour 1-3 code.
	extractClientIp: getClientIp,
	parseDeviceName: getDeviceName,
};

