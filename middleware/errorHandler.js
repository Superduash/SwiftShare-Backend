const { ERROR_CODES, buildErrorResponse } = require("../utils/constants");
const { logError } = require("../utils/logger");

function errorHandler(err, req, res, next) {
	// If response already sent, delegate to Express default handler
	if (res.headersSent) {
		return next(err);
	}

	// Extract error details with safe fallbacks
	const status = Number(err?.status) || 500;
	const errorCode = err?.errorCode || ERROR_CODES.SERVER_ERROR;
	
	// Don't expose internal error messages in production for 5xx errors
	const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
	const message = status >= 500 && isProduction
		? "Something went wrong"
		: (err?.message || "An error occurred");

	// Log server errors (5xx) for debugging
	if (status >= 500) {
		logError("Unhandled request error", err, `${req.method} ${req.originalUrl}`);
	}

	// Build consistent error response
	const response = buildErrorResponse(errorCode, message);
	
	// Include request ID for tracing if available
	if (req.requestId) {
		response.requestId = req.requestId;
	}
	
	// Send error response
	try {
		res.status(status).json(response);
	} catch (sendError) {
		// Last resort: if JSON serialization fails, send plain text
		logError("Error response serialization failed", sendError);
		res.status(500).send("Internal Server Error");
	}
}

module.exports = {
	errorHandler,
};

