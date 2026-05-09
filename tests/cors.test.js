const { corsOrigin, originsMatch, isPlatformDeployOrigin } = require("../server");

describe("CORS Edge Cases", () => {
	describe("isPlatformDeployOrigin", () => {
		it("allows known platform suffixes", () => {
			expect(isPlatformDeployOrigin("https://swiftshare.vercel.app")).toBe(true);
			expect(isPlatformDeployOrigin("https://my-app.netlify.app")).toBe(true);
			expect(isPlatformDeployOrigin("https://preview.railway.app")).toBe(true);
		});

		it("rejects unknown suffixes", () => {
			expect(isPlatformDeployOrigin("https://evil.app")).toBe(false);
			expect(isPlatformDeployOrigin("https://vercel.app.evil.com")).toBe(false);
		});
	});

	describe("originsMatch", () => {
		it("matches exact origins", () => {
			expect(originsMatch("https://example.com", "https://example.com")).toBe(true);
			expect(originsMatch("http://example.com:8080", "http://example.com:8080")).toBe(true);
		});

		it("matches wildcards", () => {
			expect(originsMatch("https://sub.example.com", "https://*.example.com")).toBe(true);
			expect(originsMatch("http://sub.example.com", "https://*.example.com")).toBe(false); // protocol mismatch
		});

		it("handles loopback equivalence", () => {
			expect(originsMatch("http://localhost:3000", "http://127.0.0.1:3000")).toBe(true);
			expect(originsMatch("http://[::1]:3000", "http://localhost:3000")).toBe(true);
			expect(originsMatch("http://localhost:3000", "http://localhost:3001")).toBe(false); // port mismatch
		});
	});

	describe("corsOrigin", () => {
		// Mock process.env for these tests
		const originalEnv = process.env;
		
		beforeEach(() => {
			jest.resetModules();
			process.env = { ...originalEnv };
		});
		
		afterAll(() => {
			process.env = originalEnv;
		});

		it("allows all origins if CORS_ALLOW_ALL_ORIGINS is true", (done) => {
			process.env.CORS_ALLOW_ALL_ORIGINS = "true";
			corsOrigin("https://evil.com", (err, allowed) => {
				expect(allowed).toBe(true);
				done();
			});
		});

		it("allows localhost and private IPs in dev mode", (done) => {
			process.env.NODE_ENV = "development";
			corsOrigin("http://192.168.1.10:5173", (err, allowed) => {
				expect(allowed).toBe(true);
				done();
			});
		});

		it("rejects private IPs in production mode if not explicitly allowed", (done) => {
			process.env.NODE_ENV = "production";
			process.env.FRONTEND_URL = "https://example.com";
			corsOrigin("http://192.168.1.10:5173", (err, allowed) => {
				expect(allowed).toBe(false);
				done();
			});
		});
	});
});
