const express = require("express");

const Transfer = require("../models/Transfer");
const { validateCode } = require("../middleware/validateCode");
const { ERROR_CODES } = require("../utils/constants");

const router = express.Router();

function isExpired(transfer) {
	return transfer.expiresAt && new Date(transfer.expiresAt).getTime() < Date.now();
}

router.get("/:code", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer || transfer.isDeleted) {
			return res.status(404).json({
				success: false,
				error: ERROR_CODES.CODE_NOT_FOUND,
			});
		}

		if (isExpired(transfer)) {
			return res.status(410).json({
				success: false,
				error: ERROR_CODES.TRANSFER_EXPIRED,
			});
		}

		if (transfer.burnAfterDownload && transfer.downloadCount >= 1) {
			return res.status(410).json({
				success: false,
				error: ERROR_CODES.ALREADY_DOWNLOADED,
			});
		}

		return res.status(200).json({
			code: transfer.code,
			files: (transfer.files || []).map((file) => ({
				name: file.originalName,
				size: file.size,
				type: file.mimeType,
				icon: file.icon,
			})),
			totalSize: transfer.totalSize,
			fileCount: transfer.fileCount,
			expiresAt: transfer.expiresAt,
			burnAfterDownload: transfer.burnAfterDownload,
			senderDeviceName: transfer.senderDeviceName,
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

