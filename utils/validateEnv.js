const { logError, logEvent } = require("./logger");

const REQUIRED_ENV_VARS = [
	"MONGODB_URI",
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_BUCKET_NAME",
	"FRONTEND_URL",
	"SHARE_BASE_URL",
];

const OPTIONAL_ENV_VARS = [
	"GEMINI_API_KEY",
	"UPSTASH_REDIS_REST_URL",
	"UPSTASH_REDIS_REST_TOKEN",
	"SENTRY_DSN",
	"CORS_EXTRA_ORIGINS",
	"CORS_ALLOW_ALL_ORIGINS",
];

function validateEnvOrExit() {
	const missingRequired = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
	if (missingRequired.length > 0) {
		logError("Missing required environment variables", null);
		for (const key of missingRequired) {
			logEvent("Missing required env var", key);
		}
		process.exit(1);
	}

	const missingOptional = OPTIONAL_ENV_VARS.filter((key) => !process.env[key]);
	if (missingOptional.length > 0) {
		logEvent("Optional environment variables not set (graceful mode)");
		for (const key of missingOptional) {
			logEvent("Missing optional env var", key);
		}
	}
}

module.exports = {
	validateEnvOrExit,
	REQUIRED_ENV_VARS,
	OPTIONAL_ENV_VARS,
};
