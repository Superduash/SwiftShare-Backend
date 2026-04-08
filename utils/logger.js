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

function logError(event, error, ...parts) {
	if (!shouldLog("error")) {
		return;
	}

	const hasError = error !== undefined && error !== null;
	const message = hasError
		? (error.message ? error.message : String(error))
		: "";
	const suffixParts = hasError ? [...parts, `ERROR: ${message}`] : parts;
	writeStderr(withTimestamp(`[✗] ${event}${buildSuffix(suffixParts)}`));
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
	logEvent,
	logError,
	formatSizeMB,
};

