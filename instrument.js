const Sentry = require("@sentry/node");
require("dotenv").config({ quiet: true });

const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.CI) || process.env.JEST_WORKER_ID !== undefined;

if (process.env.SENTRY_DSN && !isTest) {
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		environment: process.env.NODE_ENV || "production",
		tracesSampleRate: 0.1,
		sendDefaultPii: false,
		beforeSend(event, hint) {
			if (hint?.originalException?.message === "Secret database error") {
				return null;
			}
			return event;
		},
	});
}

module.exports = Sentry;

