const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
	throw new Error("GEMINI_API_KEY is not set in environment variables");
}

const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function getGeminiModel() {
	return geminiClient.getGenerativeModel({ model: "gemini-1.5-flash" });
}

module.exports = {
	geminiClient,
	getGeminiModel,
};

