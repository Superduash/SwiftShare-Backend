const express = require("express");
const { Readable } = require("stream");

const Transfer = require("../models/Transfer");
const { getObjectFromR2, deleteFilesFromR2 } = require("../services/fileManager");
const { emitToRoom, clearTransferCountdown } = require("../config/socket");
const { streamZipFromR2 } = require("../services/zipService");
const { rateLimitDownload } = require("../middleware/rateLimiter");
const { validateCode } = require("../middleware/validateCode");
const {
	sanitizeFilename,
	getDeviceName,
	getClientIp,
	formatBytes,
} = require("../utils/helpers");
const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logEvent } = require("../utils/logger");

const router = express.Router();

function isExpired(transfer) {
	return transfer.expiresAt && new Date(transfer.expiresAt).getTime() < Date.now();
}

function sendUnavailableTransferResponse(res, transfer) {
	if (!transfer) {
		return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
	}

	if (isExpired(transfer)) {
		return res.status(410).json(buildErrorResponse(ERROR_CODES.TRANSFER_EXPIRED));
	}

	if (transfer.isDeleted || (transfer.burnAfterDownload && transfer.downloadCount >= 1)) {
		return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
	}

	return null;
}

async function toReadable(body) {
	if (body && typeof body.pipe === "function") {
		return body;
	}

	if (body && typeof body.transformToByteArray === "function") {
		const bytes = await body.transformToByteArray();
		return Readable.from(Buffer.from(bytes));
	}

	throw new Error("Unable to read object stream");
}

async function streamSingleFile(res, file, code) {
	const objectResponse = await getObjectFromR2(file.storedKey);

	const stream = await toReadable(objectResponse.Body);
	const downloadName = sanitizeFilename(file.originalName || "download");
	const totalBytes = Number(objectResponse.ContentLength || file.size || 0);
	let processedBytes = 0;

	res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
	res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);

	if (objectResponse.ContentLength != null) {
		res.setHeader("Content-Length", objectResponse.ContentLength);
	}

	stream.on("data", (chunk) => {
		if (totalBytes <= 0) {
			return;
		}

		processedBytes += chunk.length;
		const percent = Math.min(100, Math.round((processedBytes / totalBytes) * 100));
		emitToRoom(code, "download-progress", { percent });
	});

	await new Promise((resolve, reject) => {
		stream.on("error", reject);
		res.on("finish", resolve);
		res.on("error", reject);
		stream.pipe(res);
	});

	return processedBytes || totalBytes;
}

async function streamZip(res, code, files) {
	const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
	let processedBytes = 0;

	await streamZipFromR2({
		code,
		files,
		res,
		onChunk: (chunkLength) => {
			if (totalBytes <= 0) {
				return;
			}

			processedBytes += chunkLength;
			const percent = Math.min(100, Math.round((processedBytes / totalBytes) * 100));
			emitToRoom(code, "download-progress", { percent });
		},
	});

	return totalBytes;
}

async function claimBurnDownload(transferId) {
	return Transfer.findOneAndUpdate(
		{
			_id: transferId,
			isDeleted: false,
			burnAfterDownload: true,
			downloadCount: 0,
		},
		{ $inc: { downloadCount: 1 } },
		{ new: true },
	);
}

async function finalizeDownload(transfer, {
	isBurnFlow,
	downloadDuration,
	downloadSpeed,
	receiverDevice,
	receiverIp,
}) {
	if (isBurnFlow) {
		await deleteFilesFromR2(transfer.files);
		await Transfer.updateOne(
			{ _id: transfer._id },
			{
				$set: {
					isDeleted: true,
					downloadDuration,
					downloadSpeed,
				},
				$push: {
					activity: {
						event: "downloaded",
						device: receiverDevice,
						ip: receiverIp,
						timestamp: new Date(),
					},
				},
			},
		);
		clearTransferCountdown(transfer.code);
		return;
	}

	await Transfer.updateOne(
		{ _id: transfer._id },
		{
			$inc: { downloadCount: 1 },
			$set: {
				downloadDuration,
				downloadSpeed,
			},
			$push: {
				activity: {
					event: "downloaded",
					device: receiverDevice,
					ip: receiverIp,
					timestamp: new Date(),
				},
			},
		},
	);
}

function buildTransferReceipt({
	code,
	fileName,
	fileSizeBytes,
	sender,
	receiver,
	downloadDuration,
	downloadSpeed,
}) {
	const durationSeconds = Math.max(downloadDuration / 1000, 0);

	return {
		transferId: code,
		fileName,
		fileSize: formatBytes(fileSizeBytes),
		sender,
		receiver,
		duration: `${durationSeconds.toFixed(1)}s`,
		speed: `${formatBytes(downloadSpeed)}/s`,
		timestamp: new Date().toISOString(),
	};
}

router.get("/:code", rateLimitDownload, validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		let transfer = await Transfer.findOne({ code });
		const receiverDevice = getDeviceName(req.get("user-agent") || "");
		const receiverIp = getClientIp(req);

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		emitToRoom(code, "download-started", { receiverDevice });
		logEvent("Download started", `CODE: ${code}`, `DEVICE: ${receiverDevice}`);

		let isBurnFlow = false;
		if (transfer.burnAfterDownload) {
			const claimedTransfer = await claimBurnDownload(transfer._id);
			if (!claimedTransfer) {
				return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
			}
			transfer = claimedTransfer;
			isBurnFlow = true;
		}

		if (!transfer.files || transfer.files.length === 0) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const streamStart = Date.now();
		let streamedBytes = 0;
		let receiptFileName = `swiftshare-${code}.zip`;

		if (transfer.files.length === 1) {
			receiptFileName = transfer.files[0].originalName || receiptFileName;
			streamedBytes = await streamSingleFile(res, {
				...transfer.files[0].toObject(),
			}, code);
		} else {
			streamedBytes = await streamZip(res, transfer.code, transfer.files);
		}

		const downloadDuration = Math.max(Date.now() - streamStart, 1);
		const downloadSpeed = Math.round(streamedBytes / (downloadDuration / 1000));

		await finalizeDownload(transfer, {
			isBurnFlow,
			downloadDuration,
			downloadSpeed,
			receiverDevice,
			receiverIp,
		});

		const receipt = buildTransferReceipt({
			code,
			fileName: receiptFileName,
			fileSizeBytes: streamedBytes,
			sender: transfer.senderDeviceName || "Unknown Device",
			receiver: receiverDevice,
			downloadDuration,
			downloadSpeed,
		});

		emitToRoom(code, "download-complete", { receiverDevice });
		emitToRoom(code, "transfer-receipt", receipt);
		logEvent("Download completed", `CODE: ${code}`, `DEVICE: ${receiverDevice}`);
		return null;
	} catch (error) {
		if (res.headersSent) {
			console.error(`Download post-stream error: ${error.message}`);
			return null;
		}
		return next(error);
	}
});

router.get("/:code/single/:index", rateLimitDownload, validateCode, async (req, res, next) => {
	try {
		const { code, index } = req.params;
		let transfer = await Transfer.findOne({ code });
		const receiverDevice = getDeviceName(req.get("user-agent") || "");
		const receiverIp = getClientIp(req);

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		emitToRoom(code, "download-started", { receiverDevice });
		logEvent("Download started", `CODE: ${code}`, `DEVICE: ${receiverDevice}`, "MODE: single");

		let isBurnFlow = false;
		if (transfer.burnAfterDownload) {
			const claimedTransfer = await claimBurnDownload(transfer._id);
			if (!claimedTransfer) {
				return res.status(410).json(buildErrorResponse(ERROR_CODES.ALREADY_DOWNLOADED));
			}
			transfer = claimedTransfer;
			isBurnFlow = true;
		}

		const fileIndex = Number(index);
		if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= transfer.files.length) {
			return res.status(404).json(buildErrorResponse(ERROR_CODES.TRANSFER_NOT_FOUND));
		}

		const selectedFile = transfer.files[fileIndex];
		const streamStart = Date.now();
		const streamedBytes = await streamSingleFile(res, {
			...transfer.files[fileIndex].toObject(),
		}, code);
		const downloadDuration = Math.max(Date.now() - streamStart, 1);
		const downloadSpeed = Math.round(streamedBytes / (downloadDuration / 1000));

		await finalizeDownload(transfer, {
			isBurnFlow,
			downloadDuration,
			downloadSpeed,
			receiverDevice,
			receiverIp,
		});

		const receipt = buildTransferReceipt({
			code,
			fileName: selectedFile.originalName || "download",
			fileSizeBytes: streamedBytes,
			sender: transfer.senderDeviceName || "Unknown Device",
			receiver: receiverDevice,
			downloadDuration,
			downloadSpeed,
		});

		emitToRoom(code, "download-complete", { receiverDevice });
		emitToRoom(code, "transfer-receipt", receipt);
		logEvent("Download completed", `CODE: ${code}`, `DEVICE: ${receiverDevice}`, "MODE: single");
		return null;
	} catch (error) {
		if (res.headersSent) {
			console.error(`Single download post-stream error: ${error.message}`);
			return null;
		}
		return next(error);
	}
});

module.exports = router;

