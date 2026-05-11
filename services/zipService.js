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

	// Use lightweight/store-only ZIP streaming (disable zlib compression)
	// to prevent CPU starvation on constrained hosts, as most files are
	// already-compressed media anyway.
	const archive = archiver("zip", { store: true });

	// Track every upstream R2 stream so we can destroy them if the client aborts
	// or the archiver errors. Otherwise an aborted download leaves N R2 sockets
	// in CLOSE_WAIT until OS timeout.
	const upstreamStreams = [];
	const destroyAllUpstream = () => {
		for (const s of upstreamStreams) {
			try { s.destroy(); } catch { /* already destroyed */ }
		}
	};

	archive.on("error", destroyAllUpstream);
	res.on("close", destroyAllUpstream);

	archive.pipe(res);

	try {
		for (const file of files) {
			const objectResponse = await getObjectFromR2(file.storedKey);

			const stream = await toReadable(objectResponse.Body);
			upstreamStreams.push(stream);
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
	} catch (err) {
		destroyAllUpstream();
		throw err;
	}
}

module.exports = {
	streamZipFromR2,
};
