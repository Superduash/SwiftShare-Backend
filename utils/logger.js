function getTimestamp() {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

const LOG_LEVELS = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

function getConfiguredLogLevel() {
	const rawLevel = String(process.env.LOG_LEVEL || "").trim().toLowerCase();
	if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, rawLevel)) {
		return rawLevel;
	}

	const isProduction = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
	return isProduction ? "warn" : "info";
}

function shouldLog(level) {
	const configured = getConfiguredLogLevel();
	return LOG_LEVELS[level] <= LOG_LEVELS[configured];
}

function withTimestamp(message) {
	return `[${getTimestamp()}] ${message}`;
}

function writeStdout(line) {
	process.stdout.write(`${line}\n`);
}

function writeStderr(line) {
	process.stderr.write(`${line}\n`);
}

function buildSuffix(parts) {
	const clean = (parts || [])
		.filter((part) => part !== undefined && part !== null && String(part).length > 0)
		.map((part) => String(part));

	if (!clean.length) {
		return "";
	}

	return ` - ${clean.join(" - ")}`;
}

/**
 * Redact sensitive data from objects before logging
 * @param {any} data - Data to redact
 * @returns {any} Redacted data
 */
function redactSensitiveData(data) {
	if (!data || typeof data !== "object") {
		return data;
	}

	// Handle arrays
	if (Array.isArray(data)) {
		return data.map(item => redactSensitiveData(item));
	}

	const redacted = {};
	const sensitiveKeys = ["password", "token", "apikey", "secret", "authorization", "api_key", "apiKey"];

	for (const key in data) {
		const lowerKey = key.toLowerCase();
		
		// Check if key is sensitive
		if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
			redacted[key] = "[REDACTED]";
		} else if (data[key] && typeof data[key] === "object") {
			// Recursively redact nested objects
			redacted[key] = redactSensitiveData(data[key]);
		} else {
			redacted[key] = data[key];
		}
	}

	return redacted;
}

function logSuccess(message, useTimestamp = false) {
	const line = `[✓] ${message}`;
	writeStdout(useTimestamp ? withTimestamp(line) : line);
}

function logInfo(message, useTimestamp = false) {
	if (!shouldLog("info")) {
		return;
	}

	const line = `[•] ${message}`;
	writeStdout(useTimestamp ? withTimestamp(line) : line);
}

function logEvent(event, ...parts) {
	logInfo(`${event}${buildSuffix(parts)}`, true);
}

function logWarn(event, ...parts) {
	if (!shouldLog("warn")) {
		return;
	}

	const line = `[!] ${event}${buildSuffix(parts)}`;
	writeStdout(withTimestamp(line));
}

function logError(event, error, ...parts) {
	if (!shouldLog("error")) {
		return;
	}

	const hasError = error !== undefined && error !== null;
	// Avoid logging stack traces for expected operational errors (e.g. client disconnects)
	const isOperational = hasError && (error.code === 'ECONNRESET' || error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED');
	const message = hasError
		? (error.message ? error.message : String(error))
		: "";
	
	// Redact sensitive data from parts
	const redactedParts = parts.map(part => {
		if (typeof part === "object") {
			return JSON.stringify(redactSensitiveData(part));
		}
		return part;
	});
	
	const suffixParts = hasError ? [...redactedParts, `ERROR: ${message}`] : redactedParts;
	writeStderr(withTimestamp(`[✗] ${event}${buildSuffix(suffixParts)}`));
	// Only log stack traces for non-operational errors in development
	if (hasError && !isOperational && error.stack && String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
		writeStderr(error.stack);
	}
}

function formatSizeMB(bytes) {
	const size = Number(bytes || 0);
	if (size <= 0) {
		return "0MB";
	}

	const mb = size / (1024 * 1024);
	return `${mb >= 10 ? Math.round(mb) : mb.toFixed(2)}MB`;
}

module.exports = {
	logSuccess,
	logInfo,
	logWarn,
	logEvent,
	logError,
	formatSizeMB,
	redactSensitiveData,
};

