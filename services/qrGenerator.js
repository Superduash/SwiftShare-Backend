const QRCode = require("qrcode");

async function generateQR(code) {
	const shareBaseUrl = process.env.SHARE_BASE_URL;

	if (!shareBaseUrl) {
		throw new Error("SHARE_BASE_URL is not set in environment variables");
	}

	const shareLink = `${shareBaseUrl}/g/${code}`;
	const useBrandedQr = String(process.env.QR_BRANDED || "true").toLowerCase() !== "false";

	if (!useBrandedQr) {
		return QRCode.toDataURL(shareLink, {
			errorCorrectionLevel: "M",
			margin: 4,
			width: 1024,
		});
	}

	return QRCode.toDataURL(shareLink, {
		errorCorrectionLevel: "M",
		margin: 4,
		width: 1024,
		color: {
			dark: "#0EA5E9",
			light: "#0F172A",
		},
	});
}

module.exports = {
	generateQR,
};

