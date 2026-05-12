const request = require("supertest");
const { app } = require("../server");

describe("Error Handler Edge Cases", () => {
	it("includes request ID in error responses", async () => {
		const res = await request(app).get("/api/non-existent-route-for-testing");
		
		expect(res.status).toBe(404);
		expect(res.body.requestId).toBeDefined();
		expect(res.body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it("hides stack traces in production for 500 errors", async () => {
		const originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";

		// server.js registers /api/test-error when NODE_ENV is "test" at load time;
		// we hit it directly here — the errorHandler hides the message in production.
		const res = await request(app).get("/api/test-error");
		
		expect(res.status).toBe(500);
		// buildErrorResponse nests the error as { error: { code, message } }
		expect(res.body.error.message).toBe("Something went wrong");
		expect(res.body.stack).toBeUndefined();
		
		process.env.NODE_ENV = originalEnv;
	});
});
