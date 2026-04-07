const express = require("express");

const Transfer = require("../models/Transfer");
const { deleteFilesFromR2 } = require("../services/fileManager");
const { emitToRoom, clearTransferCountdown } = require("../config/socket");
const { validateCode } = require("../middleware/validateCode");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logEvent } = require("../utils/logger");

const router = express.Router();

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
			logEvent("Transfer deleted", `CODE: ${code}`);
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

