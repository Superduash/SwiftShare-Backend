const request = require("supertest");
const { app } = require("../server");

describe("Security Headers", () => {
	it("sets all required security headers", async () => {
		const res = await request(app).get("/api/ping");
		
		expect(res.headers["x-content-type-options"]).toBe("nosniff");
		expect(res.headers["referrer-policy"]).toBe("no-referrer");
		expect(res.headers["x-frame-options"]).toBe("DENY");
		expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
	});

	it("preserves CORS headers", async () => {
		const res = await request(app)
			.options("/api/ping")
			.set("Origin", "https://swiftshare.vercel.app");
			
		expect(res.headers["access-control-allow-origin"]).toBe("https://swiftshare.vercel.app");
		expect(res.headers["access-control-expose-headers"]).toContain("Content-Length");
	});
});
