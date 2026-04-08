const { GoogleGenerativeAI } = require("@google/generative-ai");
const { redis } = require("../config/redis");
const { logEvent, logError } = require("../utils/logger");

const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;
const CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS) > 0
	? Number(process.env.AI_CACHE_TTL_SECONDS)
	: 60 * 60;

const GEMINI_PRIMARY_MODEL = "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash";
const GROQ_MODEL = "llama3-70b-8192";
const OPENROUTER_QUALITY_MODEL = "nvidia/nemotron-3-super";
const OPENROUTER_STRUCTURE_MODEL = "qwen/qwen3-next-80b-instruct";

const WEAK_TERMS = ["file type", "analyzed using", "metadata", "cannot extract", "binary content", "pdf_text_extraction_failed", "image containing readable text"];

const geminiApiKey = String(process.env.GEMINI_API_KEY || "").trim();
const groqApiKey = String(process.env.GROQ_API_KEY || "").trim();
const openRouterApiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
const geminiClient = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

const memoryCache = new Map();

function getCacheKey(transferCode) {
	const normalized = String(transferCode || "").trim().toUpperCase();
	if (!normalized) {
		return "";
	}

	return `ai_${normalized}`;
}

function stripMarkdownJson(text) {
	const raw = String(text || "").trim();

	const fencedJson = raw.match(/```json\s*([\s\S]*?)```/i);
	if (fencedJson) {
		return fencedJson[1].trim();
	}

	const fenced = raw.match(/```\s*([\s\S]*?)```/i);
	if (fenced) {
		return fenced[1].trim();
	}

	return raw;
}

function safeParseJson(rawText) {
	const base = stripMarkdownJson(rawText);
	const candidates = [
		base,
		base.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
		base.replace(/,\s*([}\]])/g, "$1"),
	];

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed;
			}
		} catch (error) {
			// Continue to next candidate.
		}
	}

	return null;
}

function hasWeakTerms(text) {
	const lower = String(text || "").toLowerCase();
	return WEAK_TERMS.some((term) => lower.includes(term));
}

function validateParsedOutput(parsed, rawText) {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "invalid_json" };
	}

	const normalizedRaw = stripMarkdownJson(rawText);
	if (normalizedRaw.length < 80) {
		return { ok: false, reason: "weak_output" };
	}

	if (hasWeakTerms(normalizedRaw) || hasWeakTerms(JSON.stringify(parsed))) {
		return { ok: false, reason: "weak_output" };
	}

	if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
		return { ok: false, reason: "missing_files" };
	}

	return { ok: true };
}

function isValidCachedResult(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	if (!Array.isArray(value.files) || value.files.length === 0) {
		return false;
	}

	const raw = JSON.stringify(value);
	if (raw.length < 80) {
		return false;
	}

	if (hasWeakTerms(raw)) {
		return false;
	}

	return true;
}

function getMemoryCacheEntry(key) {
	if (!key) {
		return null;
	}

	const entry = memoryCache.get(key);
	if (!entry) {
		return null;
	}

	if (entry.expiresAt <= Date.now()) {
		memoryCache.delete(key);
		return null;
	}

	return entry.value;
}

function setMemoryCacheEntry(key, value) {
	if (!key || !isValidCachedResult(value)) {
		return;
	}

	memoryCache.set(key, {
		value,
		expiresAt: Date.now() + (CACHE_TTL_SECONDS * 1000),
	});
}

async function getCachedAiResult(transferCode) {
	const key = getCacheKey(transferCode);
	if (!key) {
		return null;
	}

	const memoryValue = getMemoryCacheEntry(key);
	if (memoryValue) {
		return memoryValue;
	}

	if (!redis) {
		return null;
	}

	try {
		const redisValue = await redis.get(key);
		if (!redisValue) {
			return null;
		}

		const parsed = typeof redisValue === "string"
			? safeParseJson(redisValue)
			: redisValue;

		if (!isValidCachedResult(parsed)) {
			return null;
		}

		setMemoryCacheEntry(key, parsed);
		return parsed;
	} catch (error) {
		logError("AI cache read failed", error, `KEY: ${key}`);
		return null;
	}
}

async function setCachedAiResult(transferCode, value) {
	const key = getCacheKey(transferCode);
	if (!key || !isValidCachedResult(value)) {
		return;
	}

	setMemoryCacheEntry(key, value);

	if (!redis) {
		return;
	}

	try {
		await redis.set(key, JSON.stringify(value), { ex: CACHE_TTL_SECONDS });
	} catch (error) {
		logError("AI cache write failed", error, `KEY: ${key}`);
	}
}

async function fetchWithTimeout(url, options) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		const text = await response.text();
		let json = null;

		try {
			json = text ? JSON.parse(text) : null;
		} catch (error) {
			json = null;
		}

		return { ok: response.ok, status: response.status, text, json };
	} catch (error) {
		if (error?.name === "AbortError") {
			return { ok: false, status: 0, reason: "timeout", text: "", json: null };
		}

		return { ok: false, status: 0, reason: "network_error", text: "", json: null };
	} finally {
		clearTimeout(timeoutId);
	}
}

function normalizeProviderFailure(result) {
	if (!result) {
		return { ok: false, reason: "provider_error" };
	}

	if (result.reason === "timeout") {
		return { ok: false, reason: "timeout" };
	}

	if (result.status === 429) {
		return { ok: false, reason: "rate_limit" };
	}

	if (result.reason === "network_error") {
		return { ok: false, reason: "timeout" };
	}

	if (result.status === 404) {
		return { ok: false, reason: "model_unavailable" };
	}

	return { ok: false, reason: "provider_error" };
}

function extractGeminiText(responseJson) {
	const parts = responseJson?.candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts)) {
		return "";
	}

	return parts
		.map((part) => String(part?.text || ""))
		.join("\n")
		.trim();
}

function extractChatCompletionText(responseJson) {
	const content = responseJson?.choices?.[0]?.message?.content;
	if (typeof content === "string") {
		return content.trim();
	}

	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") {
					return part;
				}
				return part?.text ? String(part.text) : "";
			})
			.join("\n")
			.trim();
	}

	return "";
}

async function requestGeminiModel(modelName, prompt) {
	if (!geminiClient || !geminiApiKey) {
		return { ok: false, reason: "provider_unavailable" };
	}

	const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
	const payload = {
		contents: [
			{
				role: "user",
				parts: [{ text: String(prompt || "") }],
			},
		],
		generationConfig: {
			temperature: 0.1,
			responseMimeType: "application/json",
			maxOutputTokens: 2048,
		},
	};

	const result = await fetchWithTimeout(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!result.ok) {
		return normalizeProviderFailure(result);
	}

	const text = extractGeminiText(result.json);
	if (!text) {
		return { ok: false, reason: "provider_error" };
	}

	return { ok: true, rawText: text };
}

async function tryGeminiFamily(prompt) {
	const primary = await requestGeminiModel(GEMINI_PRIMARY_MODEL, prompt);
	if (primary.ok) {
		return primary;
	}

	// Only use the alternate Gemini model when the primary model is unavailable.
	if (primary.reason !== "model_unavailable") {
		return primary;
	}

	return requestGeminiModel(GEMINI_FALLBACK_MODEL, prompt);
}

async function tryGroq(prompt) {
	if (!groqApiKey) {
		return { ok: false, reason: "provider_unavailable" };
	}

	const payload = {
		model: GROQ_MODEL,
		temperature: 0.1,
		messages: [{ role: "user", content: String(prompt || "") }],
	};

	const result = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${groqApiKey}`,
		},
		body: JSON.stringify(payload),
	});

	if (!result.ok) {
		return normalizeProviderFailure(result);
	}

	const text = extractChatCompletionText(result.json);
	if (!text) {
		return { ok: false, reason: "provider_error" };
	}

	return { ok: true, rawText: text };
}

async function tryOpenRouterModel(prompt, modelName) {
	if (!openRouterApiKey) {
		return { ok: false, reason: "provider_unavailable" };
	}

	const payload = {
		model: modelName,
		temperature: 0.1,
		messages: [{ role: "user", content: String(prompt || "") }],
	};

	const result = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${openRouterApiKey}`,
			"HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://swiftshare.local",
			"X-Title": process.env.OPENROUTER_APP_NAME || "SwiftShare Backend",
		},
		body: JSON.stringify(payload),
	});

	if (!result.ok) {
		return normalizeProviderFailure(result);
	}

	const text = extractChatCompletionText(result.json);
	if (!text) {
		return { ok: false, reason: "provider_error" };
	}

	return { ok: true, rawText: text };
}

function evaluateOutput(rawText) {
	const parsed = safeParseJson(rawText);
	if (!parsed) {
		return { ok: false, reason: "invalid_json" };
	}

	return validateParsedOutput(parsed, rawText);
}

async function runProviderStep(stepName, run) {
	let result;
	try {
		result = await run();
	} catch (error) {
		logError("AI provider failure", error, `STEP: ${stepName}`);
		return { ok: false, reason: "provider_error" };
	}

	if (!result?.ok) {
		return { ok: false, reason: result?.reason || "provider_error" };
	}

	const evaluation = evaluateOutput(result.rawText);
	if (!evaluation.ok) {
		return { ok: false, reason: evaluation.reason || "invalid_json" };
	}

	return { ok: true, parsed: safeParseJson(result.rawText) };
}

async function tryOpenRouterFamily(prompt) {
	const nemotron = await runProviderStep("openrouter:nemotron", () => tryOpenRouterModel(prompt, OPENROUTER_QUALITY_MODEL));
	if (nemotron.ok) {
		return nemotron;
	}

	return runProviderStep("openrouter:qwen", () => tryOpenRouterModel(prompt, OPENROUTER_STRUCTURE_MODEL));
}

async function analyzeWithFallback(prompt, transferCode) {
	const cached = await getCachedAiResult(transferCode);
	if (cached) {
		return cached;
	}

	const steps = [
		{ name: "gemini", run: () => runProviderStep("gemini", () => tryGeminiFamily(prompt)) },
		{ name: "groq", run: () => runProviderStep("groq", () => tryGroq(prompt)) },
		{ name: "openrouter", run: () => tryOpenRouterFamily(prompt) },
	];

	let attempts = 0;
	for (const step of steps) {
		if (attempts >= MAX_ATTEMPTS) {
			break;
		}

		attempts += 1;
		const result = await step.run();
		if (!result.ok || !result.parsed) {
			logEvent("AI fallback switch", `STEP: ${step.name}`, `REASON: ${result?.reason || "failed"}`);
			continue;
		}

		await setCachedAiResult(transferCode, result.parsed);
		return result.parsed;
	}

	return null;
}

module.exports = {
	analyzeWithFallback,
};
