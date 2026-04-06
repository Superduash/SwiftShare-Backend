const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
	throw new Error("GEMINI_API_KEY is not set in environment variables");
}

const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = geminiClient.getGenerativeModel({ model: "gemini-2.5-flash" });

async function generateAIResponse(prompt, fileBuffer, mimeType) {
	let result;

	if (fileBuffer && mimeType && /^image\//i.test(mimeType)) {
		const imagePart = {
			inlineData: {
				mimeType,
				data: Buffer.from(fileBuffer).toString("base64"),
			},
		};

		result = await model.generateContent([prompt, imagePart]);
	} else {
		result = await model.generateContent(prompt);
	}

	return result.response.text();
}

module.exports = {
	generateAIResponse,
};

