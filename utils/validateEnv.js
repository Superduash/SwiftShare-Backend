const { logError, logEvent } = require("./logger");

const REQUIRED_ENV_VARS = [
	"MONGODB_URI",
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_BUCKET_NAME",
	"FRONTEND_URL",
	"SHARE_BASE_URL",
	"TOKEN_SECRET",
];

const OPTIONAL_ENV_VARS = [
	"UPSTASH_REDIS_REST_URL",
	"UPSTASH_REDIS_REST_TOKEN",
	"SENTRY_DSN",
	"CORS_EXTRA_ORIGINS",
	"CORS_ALLOW_ALL_ORIGINS",
];

function validateEnvOrExit() {
	const isTest = String(process.env.NODE_ENV || "").toLowerCase() === "test";
	if (isTest) return;

	const missingRequired = REQUIRED_ENV_VARS.filter((key) => !process.env[key] || !process.env[key].trim());
	if (missingRequired.length > 0) {
		logError("Missing required environment variables", null);
		for (const key of missingRequired) {
			logEvent("Missing required env var", key);
		}
		process.exit(1);
	}

	const missingOptional = OPTIONAL_ENV_VARS.filter((key) => !process.env[key]);
	if (missingOptional.length > 0) {
		logEvent("Optional env vars missing (graceful mode)", missingOptional.join(", "));
	}

	// Admin Panel validation
	const adminEnabled = String(process.env.ADMIN_ENABLED || "").toLowerCase() === "true";
	if (adminEnabled) {
		const adminUsername = String(process.env.ADMIN_USERNAME || "").trim();
		const adminHash = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
		const adminJwtSecret = String(process.env.ADMIN_JWT_SECRET || "").trim();
		const analyticsSalt = String(process.env.ANALYTICS_HASH_SALT || "").trim();

		const bcryptRegex = /^\$2[aby]\$\d{2}\$.{53}$/;
		const hex64Regex = /^[0-9a-fA-F]{64}$/;

		const errors = [];
		if (!adminUsername) errors.push("ADMIN_USERNAME is required when ADMIN_ENABLED=true");
		if (!adminHash || !bcryptRegex.test(adminHash)) {
			errors.push("ADMIN_PASSWORD_HASH must be a valid bcrypt hash (cost >= 10, length 60)");
		}
		if (!adminJwtSecret || !hex64Regex.test(adminJwtSecret)) {
			errors.push("ADMIN_JWT_SECRET must be a 64-character hex string (32 bytes)");
		}
		if (!analyticsSalt || !hex64Regex.test(analyticsSalt)) {
			errors.push("ANALYTICS_HASH_SALT must be a 64-character hex string (32 bytes)");
		}

		if (errors.length > 0) {
			logError("Admin environment configuration invalid", null);
			for (const err of errors) {
				logEvent("Admin env error", err);
			}
			process.exit(1);
		}
	}
}

module.exports = {
	validateEnvOrExit,
	REQUIRED_ENV_VARS,
	OPTIONAL_ENV_VARS,
};
