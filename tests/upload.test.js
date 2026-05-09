const request = require("supertest");
const { app } = require("../server");

describe("Upload Validation Edge Cases", () => {
	it("rejects uploads with blocked extensions", async () => {
		const res = await request(app)
			.post("/api/upload")
			.attach("file", Buffer.from("test"), "test.exe");
			
		expect(res.status).toBe(400);
		expect(res.body.error).toContain("Blocked file extension");
	});
});
