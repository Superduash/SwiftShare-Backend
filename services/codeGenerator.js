const crypto = require("crypto");
const Transfer = require("../models/Transfer");

const CODE_CHARACTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function createCode(length) {
	let code = "";

	for (let i = 0; i < length; i += 1) {
		code += CODE_CHARACTERS[crypto.randomInt(0, CODE_CHARACTERS.length)];
	}

	return code;
}

async function generateUniqueCode() {
	while (true) {
		const code = createCode(CODE_LENGTH);
		const exists = await Transfer.exists({ code });

		if (!exists) {
			return code;
		}
	}
}

module.exports = {
	generateUniqueCode,
};

