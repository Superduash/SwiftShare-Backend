const express = require("express");
const bcrypt = require("bcryptjs");

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
const {
	getClientIp,
	getDeviceName,
	isTransferExpired,
	getTransferStatus,
	getRequestFingerprint,
	isBurnClaimOwner,
} = require("../utils/helpers");

const router = express.Router();
const MINUTE_MS = 60 * 1000;
const STATUS_CACHE_TTL_MS = 1200;
const ACTIVITY_CACHE_TTL_MS = 1200;
const statusCache = new Map();
const activityCache = new Map();

function getCachedPayload(cache, code) {
	const entry = cache.get(code);
	if (!entry) {
		return null;
	}

	if (entry.expiresAt <= Date.now()) {
		cache.delete(code);
		return null;
	}

	return entry.payload;
}

function setCachedPayload(cache, code, payload, ttlMs) {
	cache.set(code, {
		payload,
		expiresAt: Date.now() + ttlMs,
	});
}

function invalidateTransferCache(code) {
	statusCache.delete(code);
	activityCache.delete(code);
}

function extractPasswordFromRequest(req) {
	const value = req.body?.password;
	if (typeof value !== "string") {
		return "";
	}

	return value;
}

function getDefaultSessionExpiryMinutes() {
	const configuredMinutes = Number(process.env.SESSION_EXPIRY_MINUTES);
	return Number.isFinite(configuredMinutes) && configuredMinutes > 0
		? Math.floor(configuredMinutes)
		: 10;
}

function inferOriginalSessionMinutes(transfer) {
	const fallbackMinutes = getDefaultSessionExpiryMinutes();
	const createdAtMs = transfer?.createdAt ? new Date(transfer.createdAt).getTime() : NaN;
	const expiresAtMs = transfer?.expiresAt ? new Date(transfer.expiresAt).getTime() : NaN;

	if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= createdAtMs) {
		return fallbackMinutes;
	}

	return Math.max(1, Math.round((expiresAtMs - createdAtMs) / MINUTE_MS));
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

		if (isTransferExpired(transfer)) {
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
		const cached = getCachedPayload(activityCache, code);
		if (cached) {
			return res.status(200).json(cached);
		}

		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const payload = {
			code: transfer.code,
			activity: Array.isArray(transfer.activity) ? transfer.activity : [],
		};

		setCachedPayload(activityCache, code, payload, ACTIVITY_CACHE_TTL_MS);
		return res.status(200).json(payload);
	} catch (error) {
		return next(error);
	}
});

router.get("/:code/status", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const cached = getCachedPayload(statusCache, code);
		if (cached) {
			return res.status(200).json(cached);
		}

		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const secondsRemaining = transfer.expiresAt
			? Math.max(0, Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000))
			: 0;

		const payload = {
			code: transfer.code,
			status: getTransferStatus(transfer),
			downloadCount: Number(transfer.downloadCount || 0),
			expiresAt: transfer.expiresAt,
			secondsRemaining,
		};

		setCachedPayload(statusCache, code, payload, STATUS_CACHE_TTL_MS);
		return res.status(200).json(payload);
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

		if (isTransferExpired(transfer)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
		}

		if (transfer.extendedOnce) {
			return res.status(409).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Transfer can only be extended once"));
		}

		const extensionMinutes = inferOriginalSessionMinutes(transfer);
		const currentExpiryMs = transfer.expiresAt ? new Date(transfer.expiresAt).getTime() : Date.now();
		const baseExpiryMs = Number.isFinite(currentExpiryMs)
			? Math.max(Date.now(), currentExpiryMs)
			: Date.now();
		const expiresAt = new Date(baseExpiryMs + extensionMinutes * MINUTE_MS);

		// Clear old countdown BEFORE saving to prevent race condition
		clearTransferCountdown(code);

		transfer.expiresAt = expiresAt;
		transfer.extendedOnce = true;
		transfer.activity.push({
			event: "extended",
			device: getDeviceName(req.get("user-agent") || ""),
			ip: getClientIp(req),
			timestamp: new Date(),
		});
		await transfer.save();
		invalidateTransferCache(code);

		// Schedule new countdown AFTER save
		scheduleTransferCountdown(code, expiresAt);
		emitToRoom(code, "transfer-extended", { code, expiresAt, extensionMinutes });
		logEvent(
			"Transfer extended",
			`CODE: ${code}`,
			`EXTENSION_MINUTES: ${extensionMinutes}`,
			`EXPIRES_AT: ${expiresAt.toISOString()}`,
		);

		return res.status(200).json({
			success: true,
			code,
			expiresAt,
			extensionMinutes,
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
			transfer.cancelledAt = new Date();
			transfer.activity.push({
				event: "cancelled",
				device: getDeviceName(req.get("user-agent") || ""),
				ip: getClientIp(req),
				timestamp: new Date(),
			});
			await transfer.save();
			invalidateTransferCache(code);
			clearTransferCountdown(code);
			emitToRoom(code, "transfer-cancelled", { code, status: "CANCELLED" });
			logEvent("Transfer cancelled", `CODE: ${code}`);
		}

		return res.status(200).json({
			success: true,
			code,
		});
	} catch (error) {
		return next(error);
	}
});

router.post("/:code/burn-finalize", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code });

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (!transfer.burnAfterDownload) {
			return res.status(200).json({ success: true, code, status: transfer.status || "ACTIVE" });
		}

		if (transfer.isDeleted) {
			return res.status(200).json({ success: true, code, status: "DELETED" });
		}

		if (!transfer.burnClaimOwner) {
			return res.status(409).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Burn session has not been claimed yet"));
		}

		if (!isBurnClaimOwner(transfer, req)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}

		await deleteFilesFromR2(transfer.files);

		const finalizedAt = new Date();
		await Transfer.updateOne(
			{ _id: transfer._id, isDeleted: false },
			{
				$set: {
					isDeleted: true,
					burnFinalizedAt: finalizedAt,
					burnLastActiveAt: finalizedAt,
				},
				$push: {
					activity: {
						event: "burned",
						device: getDeviceName(req.get("user-agent") || ""),
						ip: getClientIp(req),
						timestamp: finalizedAt,
					},
				},
			},
		);
		invalidateTransferCache(code);

		clearTransferCountdown(code);
		emitToRoom(code, "transfer-deleted", { code, status: "DELETED", reason: "burn" });
		logEvent("Burn finalized", `CODE: ${code}`, `OWNER: ${getRequestFingerprint(req).slice(0, 12)}`);

		return res.status(200).json({ success: true, code, status: "DELETED" });
	} catch (error) {
		return next(error);
	}
});

module.exports = router;

