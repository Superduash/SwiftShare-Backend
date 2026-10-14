const crypto = require("crypto");
const Transfer = require("../models/Transfer");
const { CODE_LENGTH: CONFIG_LENGTH } = require("../utils/constants");

const DEFAULT_CODE_LENGTH = Number.isInteger(CONFIG_LENGTH) && CONFIG_LENGTH > 0 ? CONFIG_LENGTH : 6;
const MAX_GENERATION_RETRIES = 15;

/**
 * Generate 6 cryptographically secure numeric digits, zero-padded (000000 - 999999).
 */
function generateNumericCode(length = DEFAULT_CODE_LENGTH) {
	const max = Math.pow(10, length);
	const num = crypto.randomInt(0, max);
	return String(num).padStart(length, "0");
}

/**
 * Generate a unique code checking collision against currently active transfers.
 * Active transfers: { isDeleted: false, expiresAt: { $gt: new Date() } }
 * Standardized on 6-digit numeric codes (000000 - 999999) with cryptographic randomness.
 */
async function generateUniqueCode(options = {}) {
	const maxRetries = Number(options && options.maxRetries) || MAX_GENERATION_RETRIES;

	for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
		const code = generateNumericCode();

		// Check for collision against active (non-expired, non-deleted) transfers only
		const existing = await Transfer.findOne(
			{
				code,
				isDeleted: false,
				expiresAt: { $gt: new Date() },
			},
			{ _id: 1 }
		).lean();

		if (!existing) {
			return code;
		}
	}

	throw new Error("Unable to generate a unique transfer code. Please try again.");
}

module.exports = {
	generateUniqueCode,
	generateNumericCode,
	DEFAULT_CODE_LENGTH,
};

