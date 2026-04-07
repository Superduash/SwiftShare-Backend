const archiver = require("archiver");
const { Readable } = require("stream");

const { getObjectFromR2 } = require("./fileManager");
const { sanitizeFilename } = require("../utils/helpers");

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

async function streamZipFromR2({ code, files, res, onChunk }) {
	res.setHeader("Content-Type", "application/zip");
	res.setHeader(
		"Content-Disposition",
		`attachment; filename="swiftshare-${code}.zip"`,
	);

	const archive = archiver("zip", { zlib: { level: 1 } });
	archive.pipe(res);

	for (const file of files) {
		const objectResponse = await getObjectFromR2(file.storedKey);

		const stream = await toReadable(objectResponse.Body);
		if (typeof onChunk === "function") {
			stream.on("data", (chunk) => onChunk(chunk.length));
		}

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

module.exports = {
	streamZipFromR2,
};

