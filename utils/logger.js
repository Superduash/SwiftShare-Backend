function getTimestamp() {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
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

function logEvent(event, ...parts) {
	console.log(`[${getTimestamp()}] ${event}${buildSuffix(parts)}`);
}

function logError(event, error, ...parts) {
	const message = error && error.message ? error.message : String(error || "Unknown error");
	console.error(`[${getTimestamp()}] ${event}${buildSuffix([...parts, `ERROR: ${message}`])}`);
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
	logEvent,
	logError,
	formatSizeMB,
};

