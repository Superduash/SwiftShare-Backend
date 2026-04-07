const Sentry = require("@sentry/node");
require("dotenv").config();

if (process.env.SENTRY_DSN) {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		tracesSampleRate: 0.1,
		sendDefaultPii: false,
	});

	console.log("Sentry initialized");
} else {
	console.log("Sentry disabled (no DSN)");
}

module.exports = Sentry;
