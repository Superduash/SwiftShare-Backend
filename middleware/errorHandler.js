const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logError } = require("../utils/logger");

function errorHandler(err, req, res, next) {
	if (res.headersSent) {
		return next(err);
	}

	const status = err?.status || 500;
	const errorCode = err?.errorCode || ERROR_CODES.SERVER_ERROR;
	const message = status >= 500 ? "Something went wrong" : err?.message;

	if (status >= 500) {
		logError("Unhandled request error", err, `${req.method} ${req.originalUrl}`);
	}

	res.status(status).json(buildErrorResponse(errorCode, message));
}

module.exports = {
	errorHandler,
};

