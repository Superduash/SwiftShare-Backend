/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: "node",
	testMatch: ["**/tests/**/*.test.js"],
	// Runs before each test file — suppresses Sentry's "express is not instrumented"
	// console.warn, which fires because Jest requires server.js (importing express)
	// before Sentry's OTel integration can hook into it. False alarm in test envs.
	setupFiles: ["./tests/setup.js"],
	// Jest 30 default — be explicit so behaviour is predictable.
	testTimeout: 15000,
};
