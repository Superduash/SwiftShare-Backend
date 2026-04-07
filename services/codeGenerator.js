const crypto = require("crypto");
const Transfer = require("../models/Transfer");

const CODE_CHARACTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const MAX_GENERATION_RETRIES = 10;

function createCode(length) {
	let code = "";

	for (let i = 0; i < length; i += 1) {
		code += CODE_CHARACTERS[crypto.randomInt(0, CODE_CHARACTERS.length)];
	}

	return code;
}

async function generateUniqueCode() {
	for (let attempt = 1; attempt <= MAX_GENERATION_RETRIES; attempt += 1) {
		const code = createCode(CODE_LENGTH);
		const exists = await Transfer.exists({ code });

		if (!exists) {
			return code;
		}
	}

	throw new Error("Failed to generate a unique transfer code after max retries");
}

module.exports = {
	generateUniqueCode,
};

