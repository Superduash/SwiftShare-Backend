const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");

function errorHandler(err, req, res, next) {
	const status = err?.status || 500;
	const errorCode = err?.errorCode || ERROR_CODES.SERVER_ERROR;
	const message = err?.message;

	if (status >= 500) {
		console.error(err);
	}

	res.status(status).json(buildErrorResponse(errorCode, message));
}

module.exports = {
	errorHandler,
};

