const express = require("express");

const Transfer = require("../models/Transfer");
const { rateLimitMetadata } = require("../middleware/rateLimiter");
const { validateCode } = require("../middleware/validateCode");
const { getClientIp, getDeviceName, isTransferExpired, getTransferStatus, isBurnClaimOwner, getRequestFingerprint } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { getObjectFromR2 } = require("../services/fileManager");
const { analyzeTransfer } = require("../services/aiAnalyzer");
const { emitToRoom } = require("../config/socket");
const { logError } = require("../utils/logger");

const router = express.Router();

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

function isUsableAiResult(aiResult) {
	if (!aiResult || aiResult.success === false) {
		return false;
	}

	const summary = String(aiResult.overall_summary || aiResult.summary || "").trim();
	return Boolean(summary && Array.isArray(aiResult.files) && aiResult.files.length > 0);
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

router.post("/:code/analyze", rateLimitMetadata, validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		const { forceFallback } = req.body;
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}
		if (transfer.isDeleted) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}
		if (isBurnLockedForRequester(transfer, req)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
		}
		if (isTransferExpired(transfer)) {
			return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
		}

		// Download files in parallel (bounded) to buffer for re-analysis. Sequential
		// fetches were the bottleneck on multi-file analyze — for 5 files at ~200ms
		// each that's a full second of avoidable latency.
		const ANALYZE_FETCH_CONCURRENCY = 3;
		const ANALYZE_BUFFER_LIMIT = 6 * 1024 * 1024; // mirror upload's AI_BUFFER_LIMIT
		const incomingFiles = new Array(transfer.files.length).fill(null);

		const fetchOne = async (idx) => {
			const file = transfer.files[idx];
			if (!file?.storedKey) return;
			try {
				const response = await getObjectFromR2(file.storedKey);
				const chunks = [];
				let total = 0;
				for await (const chunk of response.Body) {
					const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					total += buf.length;
					if (total > ANALYZE_BUFFER_LIMIT) {
						// Cap memory usage; AI gets the first 6MB which is enough for classification.
						chunks.push(buf.subarray(0, Math.max(0, buf.length - (total - ANALYZE_BUFFER_LIMIT))));
						break;
					}
					chunks.push(buf);
				}
				incomingFiles[idx] = {
					buffer: Buffer.concat(chunks),
					originalname: file.originalName,
					mimetype: file.mimeType,
					size: file.size,
				};
			} catch (err) {
				logError(`Failed to fetch file for analysis`, err, `CODE: ${code}`, `FILE: ${file.originalName}`);
			}
		};

		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(ANALYZE_FETCH_CONCURRENCY, transfer.files.length) }, async () => {
				while (cursor < transfer.files.length) {
					const idx = cursor++;
					await fetchOne(idx);
				}
			}),
		);
		const validIncomingFiles = incomingFiles.filter(Boolean);

		const aiResult = await analyzeTransfer(validIncomingFiles, code, Boolean(forceFallback));
		if (isUsableAiResult(aiResult)) {
			await Transfer.updateOne(
				{ code },
				{
					$set: { ai: aiResult },
					$push: {
						activity: {
							event: "ai_analyzed",
							device: getDeviceName(req.get("user-agent") || ""),
							ip: getClientIp(req),
							timestamp: new Date(),
						},
					},
				}
			);

			return res.status(200).json({ success: true, ai: aiResult });
		}

		return res.status(200).json({
			success: false,
			warning: aiResult?.warning || "AI analysis unavailable",
		});
	} catch (error) {
		return next(error);
	}
});

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
				ai: transfer.ai || null,
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
