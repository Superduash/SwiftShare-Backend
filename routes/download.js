const express = require("express");
const archiver = require("archiver");
const { Readable } = require("stream");
const {
	GetObjectCommand,
	DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const Transfer = require("../models/Transfer");
const { r2Client, r2Bucket } = require("../config/r2");
const { validateCode } = require("../middleware/validateCode");
const { sanitizeFilename } = require("../utils/fileHelpers");
const { ERROR_CODES } = require("../utils/constants");

const router = express.Router();

function isExpired(transfer) {
	return transfer.expiresAt && new Date(transfer.expiresAt).getTime() < Date.now();
}

function sendUnavailableTransferResponse(res, transfer) {
	if (!transfer) {
		return res.status(404).json({
			success: false,
			error: ERROR_CODES.CODE_NOT_FOUND,
		});
	}

	if (isExpired(transfer)) {
		return res.status(410).json({
			success: false,
			error: ERROR_CODES.TRANSFER_EXPIRED,
		});
	}

	if (transfer.isDeleted || (transfer.burnAfterDownload && transfer.downloadCount >= 1)) {
		return res.status(410).json({
			success: false,
			error: ERROR_CODES.ALREADY_DOWNLOADED,
		});
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

async function deleteTransferFilesFromR2(files) {
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

async function streamSingleFile(res, file) {
	const objectResponse = await r2Client.send(
		new GetObjectCommand({
			Bucket: r2Bucket,
			Key: file.storedKey,
		}),
	);

	const stream = await toReadable(objectResponse.Body);
	const downloadName = sanitizeFilename(file.originalName || "download");

	res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
	res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);

	if (objectResponse.ContentLength != null) {
		res.setHeader("Content-Length", objectResponse.ContentLength);
	}

	await new Promise((resolve, reject) => {
		stream.on("error", reject);
		res.on("finish", resolve);
		res.on("error", reject);
		stream.pipe(res);
	});
}

async function streamZip(res, code, files) {
	res.setHeader("Content-Type", "application/zip");
	res.setHeader(
		"Content-Disposition",
		`attachment; filename="swiftshare-${code}.zip"`,
	);

	const archive = archiver("zip", { zlib: { level: 9 } });
	archive.pipe(res);

	for (const file of files) {
		const objectResponse = await r2Client.send(
			new GetObjectCommand({
				Bucket: r2Bucket,
				Key: file.storedKey,
			}),
		);

		const stream = await toReadable(objectResponse.Body);
		archive.append(stream, { name: sanitizeFilename(file.originalName || "file") });
	}

	await new Promise((resolve, reject) => {
		archive.on("error", reject);
		res.on("finish", resolve);
		res.on("error", reject);
		const finalizeResult = archive.finalize();
		if (finalizeResult && typeof finalizeResult.catch === "function") {
			finalizeResult.catch(reject);
		}
	});
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

async function incrementDownloadCount(transferId) {
	await Transfer.updateOne({ _id: transferId }, { $inc: { downloadCount: 1 } });
}

async function finalizeBurnDownload(transfer) {
	await deleteTransferFilesFromR2(transfer.files);
	await Transfer.updateOne({ _id: transfer._id }, { $set: { isDeleted: true } });
}

router.get("/:code", validateCode, async (req, res, next) => {
	try {
		const { code } = req.params;
		let transfer = await Transfer.findOne({ code });

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		let isBurnFlow = false;
		if (transfer.burnAfterDownload) {
			const claimedTransfer = await claimBurnDownload(transfer._id);
			if (!claimedTransfer) {
				return res.status(410).json({
					success: false,
					error: ERROR_CODES.ALREADY_DOWNLOADED,
				});
			}
			transfer = claimedTransfer;
			isBurnFlow = true;
		}

		if (!transfer.files || transfer.files.length === 0) {
			return res.status(404).json({
				success: false,
				error: ERROR_CODES.CODE_NOT_FOUND,
			});
		}

		if (transfer.files.length === 1) {
			await streamSingleFile(res, transfer.files[0]);
		} else {
			await streamZip(res, transfer.code, transfer.files);
		}

		if (isBurnFlow) {
			await finalizeBurnDownload(transfer);
		} else {
			await incrementDownloadCount(transfer._id);
		}
		return null;
	} catch (error) {
		if (res.headersSent) {
			console.error(`Download post-stream error: ${error.message}`);
			return null;
		}
		return next(error);
	}
});

router.get("/:code/single/:index", validateCode, async (req, res, next) => {
	try {
		const { code, index } = req.params;
		let transfer = await Transfer.findOne({ code });

		const unavailableResponse = sendUnavailableTransferResponse(res, transfer);
		if (unavailableResponse) {
			return unavailableResponse;
		}

		let isBurnFlow = false;
		if (transfer.burnAfterDownload) {
			const claimedTransfer = await claimBurnDownload(transfer._id);
			if (!claimedTransfer) {
				return res.status(410).json({
					success: false,
					error: ERROR_CODES.ALREADY_DOWNLOADED,
				});
			}
			transfer = claimedTransfer;
			isBurnFlow = true;
		}

		const fileIndex = Number(index);
		if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= transfer.files.length) {
			return res.status(404).json({
				success: false,
				error: ERROR_CODES.CODE_NOT_FOUND,
			});
		}

		await streamSingleFile(res, transfer.files[fileIndex]);
		if (isBurnFlow) {
			await finalizeBurnDownload(transfer);
		} else {
			await incrementDownloadCount(transfer._id);
		}
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

