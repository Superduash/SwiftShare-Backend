const express = require("express");

const { isR2Configured } = require("../config/r2");
const { uploadBufferToR2 } = require("../services/fileManager");
const { generateUniqueCode } = require("../services/codeGenerator");
const { bindSocketToRoom } = require("../config/socket");
const { rateLimitText } = require("../middleware/rateLimiter");
const uploadModule = require("./upload");
const Transfer = require("../models/Transfer");
const { sanitizeFilename } = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logEvent, logError } = require("../utils/logger");

const router = express.Router();

// Plain-text snippets are cheaper than full file uploads but should not be
// open-ended — 256 KB lets you paste a sizable code file or chat log without
// letting the route be abused for blob storage. Anything bigger goes through
// the regular file upload pipeline.
const MAX_TEXT_BYTES = 256 * 1024;

function trimNonString(value) {
	return typeof value === "string" ? value : "";
}

router.post("/share", rateLimitText, async (req, res) => {
	if (!isR2Configured) {
		return res
			.status(503)
			.json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "Storage is not configured"));
	}

	if (!process.env.SHARE_BASE_URL) {
		return res
			.status(500)
			.json(buildErrorResponse(ERROR_CODES.SERVER_ERROR, "SHARE_BASE_URL is not set"));
	}

	try {
		const {
			content,
			title,
			burnAfterDownload,
			passwordProtected,
			password,
			expiryMinutes,
			senderSocketId,
			socketId,
		} = req.body || {};

		const text = trimNonString(content);
		if (!text || !text.trim()) {
			return res
				.status(400)
				.json(buildErrorResponse(ERROR_CODES.NO_FILE_UPLOADED, "Snippet content is required"));
		}

		const buffer = Buffer.from(text, "utf8");
		if (buffer.length > MAX_TEXT_BYTES) {
			return res.status(400).json(
				buildErrorResponse(
					ERROR_CODES.FILE_TOO_LARGE,
					`Snippet exceeds ${Math.round(MAX_TEXT_BYTES / 1024)} KB limit`,
				),
			);
		}

		const safeTitle = sanitizeFilename(trimNonString(title) || "snippet");
		// .txt extension keeps the receiver UX consistent with file downloads —
		// browser/OS handle it as text, the existing preview route renders it,
		// and the AI analyzer's text path can extract meaning from it directly.
		const filename = /\.txt$/i.test(safeTitle) ? safeTitle : `${safeTitle}.txt`;

		const code = await generateUniqueCode();
		const storedKey = `transfers/${code}/${sanitizeFilename(filename)}`;
		const senderId = trimNonString(senderSocketId) || trimNonString(socketId) || "";
		if (senderId) bindSocketToRoom(code, senderId);
		req._senderSocketId = senderId;

		await uploadBufferToR2({
			key: storedKey,
			body: buffer,
			contentType: "text/plain; charset=utf-8",
		});

		const finalize = uploadModule.finalizeTransfer;
		const fireAi = uploadModule.fireAndForgetAi;
		const parseBool = uploadModule.parseBooleanFlag;
		const parsePass = uploadModule.parsePassword;
		const parseExpiry = uploadModule.parseExpiryMinutes;

		const response = await finalize({
			req,
			code,
			files: [{
				originalName: filename,
				storedKey,
				mimeType: "text/plain; charset=utf-8",
				size: buffer.length,
			}],
			totalSize: buffer.length,
			uploadStartedAt: Date.now(),
			burnAfterDownload: parseBool(burnAfterDownload),
			password: parsePass(password),
			passwordProtected: parseBool(passwordProtected),
			expiryMinutes: parseExpiry(expiryMinutes),
		});

		// Persist inline text into the transfer document so metadata can include
		// the snippet immediately without needing to hit R2. This is safe because
		// text shares are capped (MAX_TEXT_BYTES) and stored as UTF-8.
		try {
			await Transfer.updateOne({ code }, { $set: { 'files.0.inlineContent': text } });
		} catch (err) {
			logError('Failed to persist inline text for transfer', err, `CODE: ${code}`);
		}

		// AI: text content is small enough to pass directly. Marker in the response
		// so the frontend can render the snippet inline without an extra fetch.
		fireAi(code, [{
			originalname: filename,
			mimetype: "text/plain; charset=utf-8",
			size: buffer.length,
			buffer,
		}]);

		logEvent("Text snippet shared", `CODE: ${code}`, `BYTES: ${buffer.length}`);
		return res.status(200).json({ ...response, kind: "text" });
	} catch (error) {
		logError("Text snippet share failed", error);
		const status = error?.status || 500;
		const errorCode = error?.errorCode || ERROR_CODES.SERVER_ERROR;
		return res.status(status).json(buildErrorResponse(errorCode, error.message));
	}
});

module.exports = router;
