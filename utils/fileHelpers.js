const path = require("path");

function getFileIcon(mimeType = "") {
	const normalized = String(mimeType).toLowerCase();

	if (normalized.includes("pdf")) {
		return "pdf";
	}
	if (normalized.startsWith("image/")) {
		return "image";
	}
	if (normalized.startsWith("video/")) {
		return "video";
	}
	if (normalized.includes("zip") || normalized.includes("compressed")) {
		return "zip";
	}
	if (
		normalized.includes("word") ||
		normalized.includes("msword") ||
		normalized.includes("officedocument.wordprocessingml")
	) {
		return "doc";
	}

	return "file";
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

function getTotalSize(files = []) {
	return files.reduce((total, file) => total + Number(file.size || 0), 0);
}

module.exports = {
	getFileIcon,
	sanitizeFilename,
	getTotalSize,
};
