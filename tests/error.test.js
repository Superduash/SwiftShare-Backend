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
		
		// Create a mock error endpoint just for this test
		app.get("/api/test-error", (req, res, next) => {
			next(new Error("Secret database error"));
		});

		const res = await request(app).get("/api/test-error");
		
		expect(res.status).toBe(500);
		expect(res.body.error).toBe("Something went wrong");
		expect(res.body.stack).toBeUndefined();
		
		process.env.NODE_ENV = originalEnv;
	});
});
