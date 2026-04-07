const QRCode = require("qrcode");

async function generateQR(code) {
	const shareBaseUrl = process.env.SHARE_BASE_URL;

	if (!shareBaseUrl) {
		throw new Error("SHARE_BASE_URL is not set in environment variables");
	}

	const shareLink = `${shareBaseUrl}/g/${code}`;
	const useBrandedQr = String(process.env.QR_BRANDED || "true").toLowerCase() !== "false";
	const baseOptions = {
		errorCorrectionLevel: "H",
		margin: 4,
		width: 1024,
		scale: 8,
	};

	if (!useBrandedQr) {
		return QRCode.toDataURL(shareLink, baseOptions);
	}

	return QRCode.toDataURL(shareLink, {
		...baseOptions,
		color: {
			dark: "#0F172A",
			light: "#FFFFFF",
		},
	});
}

module.exports = {
	generateQR,
};

