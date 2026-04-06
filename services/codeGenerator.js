const crypto = require("crypto");
const Transfer = require("../models/Transfer");

const CODE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function getCodeLength() {
	const parsed = Number(process.env.CODE_LENGTH);
	if (Number.isInteger(parsed) && parsed > 0) {
		return parsed;
	}
	return 6;
}

function createCode(length) {
	let code = "";

	for (let i = 0; i < length; i += 1) {
		code += CODE_CHARACTERS[crypto.randomInt(0, CODE_CHARACTERS.length)];
	}

	return code;
}

async function generateUniqueCode() {
	const codeLength = getCodeLength();

	while (true) {
		const code = createCode(codeLength);
		const exists = await Transfer.exists({ code });

		if (!exists) {
			return code;
		}
	}
}

module.exports = {
	generateUniqueCode,
};

