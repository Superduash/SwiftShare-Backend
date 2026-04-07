const { GoogleGenerativeAI } = require("@google/generative-ai");

const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiClient = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
const model = geminiClient
	? geminiClient.getGenerativeModel({ model: "gemini-2.5-flash" })
	: null;

let geminiPingCache = {
	checkedAt: 0,
	ok: false,
};

async function generateAIResponse(prompt, fileBuffer, mimeType) {
	if (!model) {
		return null;
	}

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

function checkGeminiConnection() {
	return Boolean(model);
}

async function checkGeminiConnectionLive() {
	if (!model) {
		return false;
	}

	const now = Date.now();
	if (now - geminiPingCache.checkedAt < 60_000) {
		return geminiPingCache.ok;
	}

	try {
		await model.generateContent("ping");
		geminiPingCache = { checkedAt: now, ok: true };
		return true;
	} catch (error) {
		geminiPingCache = { checkedAt: now, ok: false };
		return false;
	}
}

module.exports = {
	generateAIResponse,
	checkGeminiConnection,
	checkGeminiConnectionLive,
};

