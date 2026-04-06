const { CODE_REGEX, ERROR_CODES } = require("../utils/constants");

function validateCode(req, res, next) {
	try {
		const { code } = req.params;

		if (!CODE_REGEX.test(String(code || ""))) {
			return res.status(400).json({
				success: false,
				error: ERROR_CODES.INVALID_CODE,
			});
		}

		return next();
	} catch (error) {
		return res.status(500).json({
			success: false,
			error: ERROR_CODES.SERVER_ERROR,
		});
	}
}

module.exports = {
	validateCode,
};

