const crypto = require("crypto");
const Transfer = require("../models/Transfer");
const { CODE_LENGTH: CONFIG_LENGTH, CODE_CHARSET } = require("../utils/constants");

const DEFAULT_CODE_LENGTH = Number.isInteger(CONFIG_LENGTH) && CONFIG_LENGTH > 0 ? CONFIG_LENGTH : 6;
const SECURE_CODE_LENGTH = 8;
const SECURE_CODE_CHARACTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // Unambiguous characters: no O, 0, I, 1, L
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
 * Generate secure alphanumeric code (8 chars, unambiguous alphabet).
 */
function generateAlphanumericCode(length = SECURE_CODE_LENGTH) {
	let code = "";
	for (let i = 0; i < length; i += 1) {
		code += SECURE_CODE_CHARACTERS[crypto.randomInt(0, SECURE_CODE_CHARACTERS.length)];
	}
	return code;
}

/**
 * Generate a unique code checking collision against currently active transfers.
 * Active transfers: { isDeleted: false, expiresAt: { $gt: new Date() } }
 */
async function generateUniqueCode(options = {}) {
	const secureMode = Boolean(options && options.secureMode);
	const useAlphanumeric = secureMode || CODE_CHARSET === "alphanumeric";
	const maxRetries = Number(options && options.maxRetries) || MAX_GENERATION_RETRIES;

	for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
		const code = useAlphanumeric ? generateAlphanumericCode() : generateNumericCode();

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
	generateAlphanumericCode,
	DEFAULT_CODE_LENGTH,
	SECURE_CODE_LENGTH,
};

