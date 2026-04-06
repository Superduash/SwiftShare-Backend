function extractClientIp(req) {
	const forwarded = req.headers["x-forwarded-for"];

	if (typeof forwarded === "string" && forwarded.length > 0) {
		return forwarded.split(",")[0].trim();
	}

	if (Array.isArray(forwarded) && forwarded.length > 0) {
		return String(forwarded[0]).trim();
	}

	return req.ip || "";
}

function parseDeviceName(userAgent = "") {
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

module.exports = {
	extractClientIp,
	parseDeviceName,
};

