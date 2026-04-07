const express = require("express");
const bcrypt = require("bcrypt");

const Transfer = require("../models/Transfer");
const { deleteFilesFromR2 } = require("../services/fileManager");
const {
	emitToRoom,
	clearTransferCountdown,
	scheduleTransferCountdown,
} = require("../config/socket");
const { validateCode } = require("../middleware/validateCode");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logEvent } = require("../utils/logger");
const { getClientIp, getDeviceName } = require("../utils/helpers");

const router = express.Router();

function isExpired(transfer) {
	return Boolean(transfer?.expiresAt) && new Date(transfer.expiresAt).getTime() < Date.now();
}

function getTransferStatus(transfer) {
	if (!transfer) {
		return "deleted";
	}

	if (isExpired(transfer)) {
		return "expired";
	}

	if (transfer.burnAfterDownload && Number(transfer.downloadCount || 0) >= 1) {
		return "downloaded";
	}

	if (transfer.isDeleted) {
		return "deleted";
	}

	return "active";
}

function extractPasswordFromRequest(req) {
	const value = req.body?.password;
	if (typeof value !== "string") {
		return "";
	}

	return value;
}

router.post("/:code/verify-password", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code });

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.CODE_NOT_FOUND));
		}

		if (transfer.isDeleted) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}

		if (isExpired(transfer)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
		}

		if (!transfer.passwordProtected) {
			return res.status(200).json({ success: true, data: { verified: true } });
		}

		if (Number(transfer.passwordAttempts || 0) >= 5) {
			return res
				.status(429)
				.json(buildErrorResponse(ERROR_CODES.INVALID_PASSWORD, "Too many incorrect password attempts"));
		}

		const password = extractPasswordFromRequest(req);
		if (!password) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.PASSWORD_REQUIRED));
		}

		const isValidPassword = Boolean(
			transfer.passwordHash && await bcrypt.compare(password, transfer.passwordHash),
		);

		if (!isValidPassword) {
			transfer.passwordAttempts = Number(transfer.passwordAttempts || 0) + 1;
			await transfer.save();
			return res.status(401).json(buildErrorResponse(ERROR_CODES.INVALID_PASSWORD));
		}

		if (Number(transfer.passwordAttempts || 0) > 0) {
			transfer.passwordAttempts = 0;
			await transfer.save();
		}

		return res.status(200).json({ success: true, data: { verified: true } });
	} catch (error) {
		return next(error);
	}
});

router.get("/:code/activity", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		return res.status(200).json({
			code: transfer.code,
			activity: Array.isArray(transfer.activity) ? transfer.activity : [],
		});
	} catch (error) {
		return next(error);
	}
});

router.get("/:code/status", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const secondsRemaining = transfer.expiresAt
			? Math.max(0, Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000))
			: 0;

		return res.status(200).json({
			code: transfer.code,
			status: getTransferStatus(transfer),
			downloadCount: Number(transfer.downloadCount || 0),
			expiresAt: transfer.expiresAt,
			secondsRemaining,
		});
	} catch (error) {
		return next(error);
	}
});

router.post("/:code/extend", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code });

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (transfer.isDeleted) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}

		if (isExpired(transfer)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
		}

		if (transfer.extendedOnce) {
			return res.status(409).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Transfer can only be extended once"));
		}

		const extensionMinutes = Number(process.env.SESSION_EXPIRY_MINUTES) > 0
			? Number(process.env.SESSION_EXPIRY_MINUTES)
			: 10;
		const expiresAt = new Date(Date.now() + extensionMinutes * 60 * 1000);

		transfer.expiresAt = expiresAt;
		transfer.extendedOnce = true;
		transfer.activity.push({
			event: "extended",
			device: getDeviceName(req.get("user-agent") || ""),
			ip: getClientIp(req),
			timestamp: new Date(),
		});
		await transfer.save();

		scheduleTransferCountdown(code, expiresAt);
		emitToRoom(code, "transfer-extended", { code, expiresAt });
		logEvent("Transfer extended", `CODE: ${code}`, `EXPIRES_AT: ${expiresAt.toISOString()}`);

		return res.status(200).json({
			success: true,
			code,
			expiresAt,
			extendedOnce: true,
		});
	} catch (error) {
		return next(error);
	}
});

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

