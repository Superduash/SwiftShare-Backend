// Jest global test setup — runs once per worker before any tests execute.
// Suppress the Sentry "express is not instrumented" console.warn.
// This warning fires because Jest requires server.js (which imports express) before
// Sentry's OpenTelemetry integration can patch it. It's a false alarm in test
// environments — production deployments start instrument.js first via -r flag.

const originalWarn = console.warn;
console.warn = (...args) => {
	const msg = String(args[0] || "");
	if (msg.includes("[Sentry]") && msg.includes("not instrumented")) {
		// Suppress — this is expected when requiring server.js directly in tests.
		return;
	}
	originalWarn.apply(console, args);
};
