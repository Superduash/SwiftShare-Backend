const Sentry = require("@sentry/node");
require("dotenv").config({ quiet: true });

if (process.env.SENTRY_DSN) {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		tracesSampleRate: 0.1,
		sendDefaultPii: false,
	});
}

module.exports = Sentry;
