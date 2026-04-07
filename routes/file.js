const express = require("express");

const Transfer = require("../models/Transfer");
const { rateLimitMetadata } = require("../middleware/rateLimiter");
const { validateCode } = require("../middleware/validateCode");
const { getClientIp, getDeviceName, isTransferExpired, getTransferStatus } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

const router = express.Router();

router.get("/:code", rateLimitMetadata, validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		// Check burn-before-isDeleted so we return ALREADY_DOWNLOADED (not CODE_NOT_FOUND)
		// even after finalizeBurnDownload has set isDeleted: true.
		if (transfer.burnAfterDownload && transfer.downloadCount >= 1) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}

		if (transfer.isDeleted) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (isTransferExpired(transfer)) {
			// Expired transfers return metadata as read-only with status
			const expiredFiles = (transfer.files || []).map((file) => ({
				name: file.originalName,
				size: file.size,
				type: file.mimeType,
				icon: file.icon,
			}));
			return res.status(200).json({
				code: transfer.code,
				status: "EXPIRED",
				passwordProtected: Boolean(transfer.passwordProtected),
				files: expiredFiles,
				totalSize: transfer.totalSize,
				fileCount: transfer.fileCount,
				expiresAt: transfer.expiresAt,
				secondsRemaining: 0,
				burnAfterDownload: transfer.burnAfterDownload,
				senderDeviceName: transfer.senderDeviceName,
				ai: transfer.ai || null,
			});
		}

		const receiverDevice = getDeviceName(req.get("user-agent") || "");
		const receiverIp = getClientIp(req);
		const secondsRemaining = transfer.expiresAt
			? Math.max(0, Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000))
			: 0;

		await Transfer.updateOne(
			{ code },
			{
				$push: {
					activity: {
						event: "viewed",
						device: receiverDevice,
						ip: receiverIp,
						timestamp: new Date(),
					},
				},
			},
		);

		return res.status(200).json({
			code: transfer.code,
			status: getTransferStatus(transfer),
			passwordProtected: Boolean(transfer.passwordProtected),
			files: (transfer.files || []).map((file) => ({
				name: file.originalName,
				size: file.size,
				type: file.mimeType,
				icon: file.icon,
			})),
			totalSize: transfer.totalSize,
			fileCount: transfer.fileCount,
			expiresAt: transfer.expiresAt,
			createdAt: transfer.createdAt,
			secondsRemaining,
			burnAfterDownload: transfer.burnAfterDownload,
			senderDeviceName: transfer.senderDeviceName,
			ai: transfer.ai || null,
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;
