const express = require("express");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");

const Transfer = require("../models/Transfer");
const { r2Client, r2Bucket } = require("../config/r2");
const { emitToRoom, clearTransferCountdown } = require("../config/socket");
const { validateCode } = require("../middleware/validateCode");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

const router = express.Router();

async function deleteFilesFromR2(files) {
	await Promise.all(
		(files || []).map(async (file) => {
			try {
				await r2Client.send(
					new DeleteObjectCommand({
						Bucket: r2Bucket,
						Key: file.storedKey,
					}),
				);
			} catch (error) {
				console.error(`Failed deleting ${file.storedKey}: ${error.message}`);
			}
		}),
	);
}

router.delete("/:code", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code });

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (!transfer.isDeleted) {
			await deleteFilesFromR2(transfer.files);
			transfer.isDeleted = true;
			await transfer.save();
			clearTransferCountdown(code);
			emitToRoom(code, "transfer-cancelled", { code });
		}

		return res.status(200).json({
			success: true,
			code,
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

