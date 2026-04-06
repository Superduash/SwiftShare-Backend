const { ERROR_CODES } = require("../utils/constants");

function errorHandler(err, req, res, next) {
	const status = err?.status || 500;
	const errorCode = err?.errorCode || ERROR_CODES.SERVER_ERROR;

	if (status >= 500) {
		console.error(err);
	}

	res.status(status).json({
		success: false,
		error: errorCode,
	});
}

module.exports = {
	errorHandler,
};

