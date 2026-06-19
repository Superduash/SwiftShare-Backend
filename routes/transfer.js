const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const Transfer = require("../models/Transfer");
const { deleteFilesFromR2 } = require("../services/fileManager");
const {
	emitToRoom,
	clearTransferCountdown,
	scheduleTransferCountdown,
} = require("../config/socket");
const { validateCode } = require("../middleware/validateCode");
const { rateLimitPassword } = require("../middleware/rateLimiter");
const { sanitizeRequestBody, isValidPassword } = require("../middleware/inputValidator");
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

function validateOwnershipToken(transfer, req) {
  const provided = (
    req.headers['x-ownership-token'] ||
    req.body?.ownershipToken ||
    ''
  ).trim();
  const stored = String(transfer.ownershipToken || '').trim();
  
  // If transfer has no ownership token, allow the operation (old transfers)
  if (!stored) return true;
  
  // If token is required but not provided, deny
  if (!provided) return false;
  
  if (provided.length !== stored.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
  } catch {
    return false;
  }
}

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
	// Always extend by exactly 10 minutes regardless of original expiry time
	return 10;
}

router.post("/:code/verify-password", rateLimitPassword, validateCode, sanitizeRequestBody, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

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
		
		// Validate password format
		if (!isValidPassword(password)) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_REQUEST, "Invalid password format"));
		}

		const passwordMatches = Boolean(
			transfer.passwordHash && await bcrypt.compare(password, transfer.passwordHash),
		);

		if (!passwordMatches) {
			// Atomic increment — prevents lost updates if two devices try the same wrong
			// password concurrently (otherwise both would read N and write N+1, missing one).
			await Transfer.updateOne(
				{ _id: transfer._id },
				{ $inc: { passwordAttempts: 1 } },
			);
			return res.status(401).json(buildErrorResponse(ERROR_CODES.INVALID_PASSWORD));
		}

		if (Number(transfer.passwordAttempts || 0) > 0) {
			await Transfer.updateOne(
				{ _id: transfer._id },
				{ $set: { passwordAttempts: 0 } },
			);
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
			serverTime: Date.now(), // Add server time for sync
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
		const { minutes } = req.body; // Get minutes from request body
		const transfer = await Transfer.findOne({ code }).lean();

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

		if (!validateOwnershipToken(transfer, req)) {
			return res.status(403).json(buildErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Ownership token required to extend this transfer'));
		}

		// Allow 10, 30, or 60 minute extensions
		const validMinutes = [10, 30, 60];
		const extensionMinutes = validMinutes.includes(Number(minutes)) ? Number(minutes) : 10;
		
		const currentExpiryMs = transfer.expiresAt ? new Date(transfer.expiresAt).getTime() : Date.now();
		const baseExpiryMs = Number.isFinite(currentExpiryMs)
			? Math.max(Date.now(), currentExpiryMs)
			: Date.now();
		const expiresAt = new Date(baseExpiryMs + extensionMinutes * MINUTE_MS);

		// Clear old countdown BEFORE saving to prevent race condition
		clearTransferCountdown(code);

		// Atomic extend with extendedOnce guard — two concurrent extend requests cannot
		// both succeed, even on the same Mongo replica.
		const extendResult = await Transfer.updateOne(
			{ _id: transfer._id, extendedOnce: false, isDeleted: false },
			{
				$set: { expiresAt, extendedOnce: true },
				$push: {
					activity: {
						$each: [{
							event: "extended",
							device: getDeviceName(req.get("user-agent") || ""),
							ip: getClientIp(req),
							timestamp: new Date(),
						}],
						$slice: -200,
					},
				},
			},
		);
		if (extendResult.modifiedCount === 0) {
			// Lost the race — restore countdown using prior expiry to avoid leaving the
			// transfer without a timer.
			scheduleTransferCountdown(code, transfer.expiresAt);
			return res.status(409).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Transfer can only be extended once"));
		}
		invalidateTransferCache(code);

		// Schedule new countdown AFTER save
		scheduleTransferCountdown(code, expiresAt);
		emitToRoom(code, "transfer-extended", { 
			code, 
			expiresAt, 
			extensionMinutes,
			serverTime: Date.now() // Add server timestamp for sync
		});
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
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (!validateOwnershipToken(transfer, req)) {
			return res.status(403).json(buildErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Ownership token required to delete this transfer'));
		}

		if (!transfer.isDeleted) {
			// Atomic claim of the cancel: only one request marks the transfer cancelled,
			// even if the user double-taps the button on a flaky connection.
			const cancelResult = await Transfer.updateOne(
				{ _id: transfer._id, isDeleted: false },
				{
					$set: { isDeleted: true, cancelledAt: new Date() },
					$push: {
						activity: {
							$each: [{
								event: "cancelled",
								device: getDeviceName(req.get("user-agent") || ""),
								ip: getClientIp(req),
								timestamp: new Date(),
							}],
							$slice: -200,
						},
					},
				},
			);
			if (cancelResult.modifiedCount > 0) {
				// Delete from R2 only after we've successfully claimed the cancel — otherwise
				// a duplicate request could double-delete (no-op but wasteful).
				await deleteFilesFromR2(transfer.files);
				invalidateTransferCache(code);
				clearTransferCountdown(code);
				emitToRoom(code, "transfer-cancelled", { code, status: "CANCELLED" });
				logEvent("Transfer cancelled", `CODE: ${code}`);
			}
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
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (!transfer.burnAfterDownload) {
			return res.status(200).json({ success: true, code, status: getTransferStatus(transfer) || "ACTIVE" });
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

