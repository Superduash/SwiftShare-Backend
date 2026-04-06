const QRCode = require("qrcode");

async function generateQR(code) {
	const shareBaseUrl = process.env.SHARE_BASE_URL;

	if (!shareBaseUrl) {
		throw new Error("SHARE_BASE_URL is not set in environment variables");
	}

	const shareLink = `${shareBaseUrl}/g/${code}`;
	return QRCode.toDataURL(shareLink);
}

module.exports = {
	generateQR,
};

