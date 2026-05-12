const request = require("supertest");
const { app } = require("../server");
const { isBlockedExtension } = require("../utils/helpers");

// ── Unit tests for extension validation (no HTTP, no timeout) ──────────────
describe("Upload Validation — isBlockedExtension helper", () => {
	it("blocks .exe files", () => {
		expect(isBlockedExtension("malware.exe")).toBe(true);
	});

	it("blocks .bat files", () => {
		expect(isBlockedExtension("run.bat")).toBe(true);
	});

	it("blocks .sh files", () => {
		expect(isBlockedExtension("script.sh")).toBe(true);
	});

	it("blocks .ps1 files", () => {
		expect(isBlockedExtension("attack.ps1")).toBe(true);
	});

	it("blocks .jar files", () => {
		expect(isBlockedExtension("app.jar")).toBe(true);
	});

	it("allows safe extensions", () => {
		expect(isBlockedExtension("photo.jpg")).toBe(false);
		expect(isBlockedExtension("doc.pdf")).toBe(false);
		expect(isBlockedExtension("data.zip")).toBe(false);
		expect(isBlockedExtension("video.mp4")).toBe(false);
	});

	it("handles edge cases safely", () => {
		expect(isBlockedExtension("")).toBe(false);
		expect(isBlockedExtension("noextension")).toBe(false);
		// path.extname(".EXE") returns "" (treated as hidden file, no extension),
		// so this correctly returns false — same as .gitignore behaviour in Node.
		expect(isBlockedExtension(".EXE")).toBe(false);
		// Case-insensitive check with a real filename
		expect(isBlockedExtension("virus.EXE")).toBe(true);
		expect(isBlockedExtension("virus.Exe")).toBe(true);
	});
});

// ── E2E: Content-type guard fires before R2 check ─────────────────────────
// Sending application/json (not multipart/form-data) to /api/upload must
// return 400 even when R2 is not configured — the content-type check happens
// first in the streaming route.
describe("Upload Route — content-type guard", () => {
	it("rejects non-multipart requests with 400", async () => {
		const res = await request(app)
			.post("/api/upload")
			.set("Content-Type", "application/json")
			.send({ file: "test" });

		expect(res.status).toBe(400);
		// buildErrorResponse shape: { success, error: { code, message } }
		expect(res.body.error).toBeDefined();
		expect(res.body.error.code).toBe("INVALID_FILE_TYPE");
	}, 10000);
});
