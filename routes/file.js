const express = require("express");

const Transfer = require("../models/Transfer");
const { rateLimitMetadata } = require("../middleware/rateLimiter");
const { validateCode } = require("../middleware/validateCode");
const { getClientIp, getDeviceName, isTransferExpired, getTransferStatus, isBurnClaimOwner, getRequestFingerprint, validateOwnershipToken } = require("../utils/helpers");
const { sanitizeString } = require("../middleware/inputValidator");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { getObjectFromR2 } = require("../services/fileManager");
const { emitToRoom } = require("../config/socket");
const { logError } = require("../utils/logger");

const router = express.Router();

router.use((req, res, next) => {
	// File streams set their own cache headers; only apply to metadata routes
	if (req.method === 'GET' && (req.path === '/' || /^\/?[A-Za-z0-9]{6}\/?$/.test(req.path))) {
		res.setHeader('Cache-Control', 'no-store');
	}
	next();
});

// Throttle "viewed" activity writes per (code,fingerprint). Without this, a polling
// frontend (e.g. status refresh every few seconds) would push a viewed event on every
// GET — bloating activity[] and killing write throughput. 30s is short enough to
// capture distinct viewers, long enough to suppress polls.
const VIEW_DEDUPE_WINDOW_MS = Number(process.env.VIEW_DEDUPE_WINDOW_MS) > 0
	? Number(process.env.VIEW_DEDUPE_WINDOW_MS)
	: 30_000;
const recentViews = new Map(); // key: `${code}|${fingerprint}` → expiresAt

function shouldRecordView(code, fingerprint) {
	const key = `${code}|${fingerprint}`;
	const now = Date.now();
	const expiresAt = recentViews.get(key);
	if (expiresAt && expiresAt > now) return false;
	recentViews.set(key, now + VIEW_DEDUPE_WINDOW_MS);
	// Periodic prune to keep map bounded — runs whenever the map exceeds 5k entries.
	if (recentViews.size > 5000) {
		for (const [k, exp] of recentViews) {
			if (exp <= now) recentViews.delete(k);
		}
	}
	return true;
}

function isBurnLockedForRequester(transfer, req) {
	if (!transfer?.burnAfterDownload || !transfer?.burnClaimOwner || transfer?.isDeleted) {
		return false;
	}

	const senderIp = String(transfer?.senderIp || "").trim();
	if (senderIp && getClientIp(req) === senderIp) {
		return false;
	}

	return !isBurnClaimOwner(transfer, req);
}

router.get("/:code", rateLimitMetadata, validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (transfer.isDeleted) {
			if (transfer.burnAfterDownload && !transfer.cancelledAt) {
				return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
			}
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		if (isBurnLockedForRequester(transfer, req)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
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
			});
		}

		const receiverDevice = getDeviceName(req.get("user-agent") || "");
		const receiverIp = getClientIp(req);
		const secondsRemaining = transfer.expiresAt
			? Math.max(0, Math.ceil((new Date(transfer.expiresAt).getTime() - Date.now()) / 1000))
			: 0;

		const viewerFingerprint = getRequestFingerprint(req);
		if (shouldRecordView(code, viewerFingerprint)) {
			await Transfer.updateOne(
				{ code },
				{
					$push: {
						activity: {
							$each: [{
								event: "viewed",
								device: receiverDevice,
								ip: receiverIp,
								timestamp: new Date(),
							}],
							$slice: -200,
						},
					},
				},
			);

			emitToRoom(code, "activity-updated", { code, event: "viewed" });
		}

		// If this is a single-file text share, attempt to include the text content
		// directly in the metadata response to avoid an extra round-trip from the
		// frontend. Only include when allowed (not deleted/expired) and when the
		// requester either doesn't need a password or has supplied a valid one.
		let textPayload = null;
		try {
			if (transfer.files && transfer.files.length === 1 && transfer.files[0].originalName.endsWith('.txt')) {
				const file = transfer.files[0];
				// Prefer inline content stored in the DB (written at share time), but
				// respect password protection: only include inline content if the
				// transfer is not password-protected or the correct password is supplied.
				if (file.inlineContent) {
					let allowedInline = true;
					if (transfer.passwordProtected) {
						if (!validateOwnershipToken(transfer, req)) {
							const providedPassword = req.headers['x-transfer-password'];
							if (!providedPassword) allowedInline = false;
							else {
								const bcrypt = require('bcryptjs');
								allowedInline = Boolean(transfer.passwordHash && await bcrypt.compare(providedPassword, transfer.passwordHash));
							}
						}
					}
					if (allowedInline) {
						textPayload = {
							content: String(file.inlineContent || ''),
							title: file.originalName.replace(/\.txt$/i, ''),
						};
					}
				} else {
					let allowed = true;
					if (transfer.passwordProtected) {
						if (!validateOwnershipToken(transfer, req)) {
							const providedPassword = req.headers['x-transfer-password'];
							if (!providedPassword) allowed = false;
							else {
								const bcrypt = require('bcryptjs');
								allowed = Boolean(transfer.passwordHash && await bcrypt.compare(providedPassword, transfer.passwordHash));
							}
						}
					}
					if (allowed) {
						try {
							const response = await getObjectFromR2(file.storedKey);
							const stream = response?.Body || response?.body;
							if (stream) {
								const chunks = [];
								let total = 0;
								for await (const chunk of stream) {
									const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
									total += buf.length;
									chunks.push(buf);
									// Safety cap: avoid returning huge text blocks in metadata
									if (total > 256 * 1024) { // 256KB
										break;
									}
								}
								textPayload = {
									content: Buffer.concat(chunks).toString('utf-8'),
									title: file.originalName.replace(/\.txt$/i, ''),
								};
							}
						} catch (err) {
							// Ignore failures to inline text; frontend can fetch via /text route.
							logError('Failed to inline text content for metadata', err, `CODE: ${code}`);
						}
					}
				}
			}
		} catch (err) {
			// Non-fatal - continue without textPayload
			logError('Error while attempting to include text in metadata', err, `CODE: ${code}`);
		}

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
			text: textPayload,
		});
	} catch (error) {
		return next(error);
	}
});

// Get text content for text shares
router.get("/:code/text", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
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

		// Check if it's a text share (single .txt file)
		if (!transfer.files || transfer.files.length !== 1 || !transfer.files[0].originalName.endsWith('.txt')) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_REQUEST, "Not a text share"));
		}

		// Check password if protected
		if (transfer.passwordProtected) {
			if (!validateOwnershipToken(transfer, req)) {
				const providedPassword = req.headers['x-transfer-password'];
				if (!providedPassword) {
					return res.status(401).json(buildErrorResponse(ERROR_CODES.PASSWORD_REQUIRED));
				}

				const bcrypt = require("bcryptjs");
				const passwordMatches = Boolean(
					transfer.passwordHash && await bcrypt.compare(providedPassword, transfer.passwordHash)
				);

				if (!passwordMatches) {
					return res.status(401).json(buildErrorResponse(ERROR_CODES.INVALID_PASSWORD));
				}
			}
		}

		// Fetch text content from either inline DB field (preferred) or R2
		const file = transfer.files[0];
		if (file.inlineContent) {
			return res.status(200).json({
				success: true,
				data: {
					content: String(file.inlineContent || ''),
					title: file.originalName.replace(/\.txt$/i, ''),
				},
			});
		}

		const response = await getObjectFromR2(file.storedKey);
		const stream = response?.Body || response?.body;

		if (!stream) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.FILE_NOT_FOUND));
		}

		// Convert stream to string
		const chunks = [];
		for await (const chunk of stream) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			chunks.push(buf);
		}
		const textContent = Buffer.concat(chunks).toString('utf-8');

		return res.status(200).json({
			success: true,
			data: {
				content: textContent,
				title: file.originalName.replace(/\.txt$/i, ''),
			}
		});
	} catch (error) {
		return next(error);
	}
});

module.exports = router;
