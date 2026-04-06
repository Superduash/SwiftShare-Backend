const { CODE_REGEX, ERROR_CODES, buildErrorResponse } = require("../utils/constants");

function validateCode(req, res, next) {
	try {
		const { code } = req.params;

		if (!CODE_REGEX.test(String(code || ""))) {
			return res.status(400).json(buildErrorResponse(ERROR_CODES.INVALID_CODE));
		}

		return next();
	} catch (error) {
		return res.status(500).json(buildErrorResponse(ERROR_CODES.SERVER_ERROR));
	}
}

module.exports = {
	validateCode,
};

