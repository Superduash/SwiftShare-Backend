const {
	generateNumericCode,
	generateAlphanumericCode,
	generateUniqueCode,
} = require("../services/codeGenerator");
const { CODE_REGEX } = require("../utils/constants");
const {
	checkCodeLookupLockout,
	recordCodeLookupFailure,
	clearCodeLookupFailures,
} = require("../middleware/rateLimiter");
const Transfer = require("../models/Transfer");

describe("Share Code Generation — Numeric & Alphanumeric", () => {
	it("generates 6-digit numeric codes with proper zero-padding", () => {
		for (let i = 0; i < 50; i++) {
			const code = generateNumericCode(6);
			expect(code).toMatch(/^\d{6}$/);
			expect(code.length).toBe(6);
		}
	});

	it("generates 8-character secure mode alphanumeric codes without ambiguous characters", () => {
		const ambiguousChars = /[O0I1l]/;
		for (let i = 0; i < 50; i++) {
			const code = generateAlphanumericCode(8);
			expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
			expect(code.length).toBe(8);
			expect(ambiguousChars.test(code)).toBe(false);
		}
	});

	it("retries on active code collision and succeeds when a free code is found", async () => {
		const originalFindOne = Transfer.findOne;
		let attempts = 0;

		// Mock Transfer.findOne: simulate collision on first 2 attempts, then return null (free)
		Transfer.findOne = jest.fn().mockImplementation(() => ({
			lean: jest.fn().mockImplementation(() => {
				attempts++;
				if (attempts < 3) {
					return Promise.resolve({ code: "123456", isDeleted: false });
				}
				return Promise.resolve(null);
			}),
		}));

		try {
			const code = await generateUniqueCode();
			expect(attempts).toBe(3);
			expect(code).toMatch(/^\d{6}$/);
		} finally {
			Transfer.findOne = originalFindOne;
		}
	});

	it("throws a clean error when maximum collision retries are exhausted", async () => {
		const originalFindOne = Transfer.findOne;

		// Simulate collision on every attempt
		Transfer.findOne = jest.fn().mockImplementation(() => ({
			lean: jest.fn().mockResolvedValue({ code: "999999", isDeleted: false }),
		}));

		try {
			await expect(generateUniqueCode({ maxRetries: 5 })).rejects.toThrow(
				"Unable to generate a unique transfer code. Please try again."
			);
		} finally {
			Transfer.findOne = originalFindOne;
		}
	});
});

describe("Share Code Validation — New 6-digit & Legacy/Secure formats", () => {
	it("validates 6-digit numeric codes", () => {
		expect(CODE_REGEX.test("000000")).toBe(true);
		expect(CODE_REGEX.test("012345")).toBe(true);
		expect(CODE_REGEX.test("999999")).toBe(true);
		expect(CODE_REGEX.test("482910")).toBe(true);
	});

	it("accepts legacy 6-char alphanumeric codes", () => {
		expect(CODE_REGEX.test("ABCDEF")).toBe(true);
		expect(CODE_REGEX.test("A1B2C3")).toBe(true);
		expect(CODE_REGEX.test("xyz789")).toBe(true);
	});

	it("accepts 8-character secure mode codes", () => {
		expect(CODE_REGEX.test("ABCDEF23")).toBe(true);
		expect(CODE_REGEX.test("98765432")).toBe(true);
	});

	it("rejects invalid formats and lengths", () => {
		expect(CODE_REGEX.test("12345")).toBe(false); // too short (5 chars)
		expect(CODE_REGEX.test("12345678901")).toBe(false); // too long (11 chars)
		expect(CODE_REGEX.test("123-45")).toBe(false); // symbols
		expect(CODE_REGEX.test("abc def")).toBe(false); // spaces
		expect(CODE_REGEX.test("")).toBe(false); // empty
	});
});

describe("Code Lookup Rate-Limit & Lockout Protection", () => {
	const testIp = "192.168.1.199";

	beforeEach(() => {
		clearCodeLookupFailures(testIp);
	});

	afterEach(() => {
		clearCodeLookupFailures(testIp);
	});

	it("starts unlocked for a new IP", () => {
		const status = checkCodeLookupLockout(testIp);
		expect(status.locked).toBe(false);
	});

	it("locks out IP after 5 failed lookup attempts", () => {
		for (let i = 1; i <= 4; i++) {
			recordCodeLookupFailure(testIp);
			const status = checkCodeLookupLockout(testIp);
			expect(status.locked).toBe(false);
		}

		// 5th failure triggers lockout
		const retryAfter = recordCodeLookupFailure(testIp);
		expect(retryAfter).toBeGreaterThan(0);

		const lockedStatus = checkCodeLookupLockout(testIp);
		expect(lockedStatus.locked).toBe(true);
		expect(lockedStatus.retryAfter).toBeGreaterThan(0);
	});

	it("clears failed lookup attempts on clearCodeLookupFailures", () => {
		for (let i = 0; i < 5; i++) {
			recordCodeLookupFailure(testIp);
		}
		expect(checkCodeLookupLockout(testIp).locked).toBe(true);

		clearCodeLookupFailures(testIp);
		expect(checkCodeLookupLockout(testIp).locked).toBe(false);
	});
});
