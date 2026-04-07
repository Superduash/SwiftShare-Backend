const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { generateAIResponse } = require("../config/gemini");
const { logEvent } = require("../utils/logger");

const ALLOWED_CATEGORIES = new Set([
	"Assignment",
	"Notes",
	"Invoice",
	"Report",
	"Image",
	"Video",
	"Audio",
	"Code",
	"Presentation",
	"Spreadsheet",
	"Other",
]);

const CODE_EXTENSIONS = new Set([".js", ".py", ".java", ".cpp", ".html", ".css", ".ts", ".jsx", ".go", ".rs"]);
const PRESENTATION_EXTENSIONS = new Set([".ppt", ".pptx"]);
const SPREADSHEET_EXTENSIONS = new Set([".xls", ".xlsx", ".csv"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac"]);

let currentWindowStart = Date.now();
let requestCountInWindow = 0;

function canUseAI() {
	const now = Date.now();
	if (now - currentWindowStart >= 60_000) {
		currentWindowStart = now;
		requestCountInWindow = 0;
	}

	if (requestCountInWindow >= 14) {
		return false;
	}

	requestCountInWindow += 1;
	return true;
}

function cleanPreviewText(text) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 4000);
}

function extractJsonBlock(text) {
	const raw = String(text || "").trim();

	const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
	if (fencedMatch) {
		return fencedMatch[1].trim();
	}

	const firstBrace = raw.indexOf("{");
	const lastBrace = raw.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return raw.slice(firstBrace, lastBrace + 1);
	}

	return raw;
}

function normalizeAiResult(parsed, filename) {
	const extensionlessName = path.parse(filename || "file").name || "file";

	const category = ALLOWED_CATEGORIES.has(parsed.category)
		? parsed.category
		: "Other";

	return {
		summary: typeof parsed.summary === "string" ? parsed.summary : null,
		suggestedName:
			typeof parsed.suggestedName === "string" && parsed.suggestedName.trim()
				? parsed.suggestedName.trim()
				: extensionlessName,
		category,
		imageDescription:
			typeof parsed.imageDescription === "string" ? parsed.imageDescription : null,
	};
}

function detectCategoryWithoutAI(filename, mimeType) {
	const ext = String(path.extname(filename || "")).toLowerCase();
	const lowerMime = String(mimeType || "").toLowerCase();

	if (CODE_EXTENSIONS.has(ext)) {
		return "Code";
	}

	if (PRESENTATION_EXTENSIONS.has(ext)) {
		return "Presentation";
	}

	if (SPREADSHEET_EXTENSIONS.has(ext)) {
		return "Spreadsheet";
	}

	if (VIDEO_EXTENSIONS.has(ext) || lowerMime.startsWith("video/")) {
		return "Video";
	}

	if (AUDIO_EXTENSIONS.has(ext) || lowerMime.startsWith("audio/")) {
		return "Audio";
	}

	return null;
}

async function buildPreviewFromFile(buffer, filename, mimeType) {
	const lowerMime = String(mimeType || "").toLowerCase();
	const ext = String(path.extname(filename || "")).toLowerCase();

	if (lowerMime.includes("pdf") || ext === ".pdf") {
		const parsed = await pdfParse(buffer);
		return cleanPreviewText(parsed.text);
	}

	if (lowerMime.includes("wordprocessingml") || ext === ".docx") {
		const parsed = await mammoth.extractRawText({ buffer });
		return cleanPreviewText(parsed.value);
	}

	if (lowerMime.startsWith("text/") || ext === ".txt") {
		return cleanPreviewText(Buffer.from(buffer).toString("utf8"));
	}

	return cleanPreviewText(`File name: ${filename}\nMime type: ${mimeType}`);
}

function createPrompt({ filename, mimeType, contentPreview }) {
	return `You are a file analysis assistant. Given the following file content, respond in JSON only:
{
  "summary": "2-3 sentence description of what this file contains",
  "suggestedName": "a_clean_filename_without_extension",
  "category": "one of: Assignment, Notes, Invoice, Report, Image, Video, Code, Presentation, Spreadsheet, Other",
  "imageDescription": "if image, describe what's in it, otherwise null"
}

File name: ${filename}
File type: ${mimeType}
Content preview:
${contentPreview}`;
}

async function analyzeFile(buffer, filename, mimeType) {
	try {
		const directCategory = detectCategoryWithoutAI(filename, mimeType);
		if (directCategory) {
			const extensionlessName = path.parse(filename || "file").name || "file";
			return {
				summary: null,
				suggestedName: extensionlessName,
				category: directCategory,
				imageDescription: null,
			};
		}

		if (!canUseAI()) {
			logEvent("AI analysis skipped", "local rate safety limit reached");
			return null;
		}

		const lowerMime = String(mimeType || "").toLowerCase();
		let responseText;

		if (lowerMime.startsWith("image/")) {
			const imagePrompt = createPrompt({
				filename,
				mimeType,
				contentPreview: "Image input provided as binary.",
			});

			responseText = await generateAIResponse(imagePrompt, buffer, mimeType);
		} else {
			const contentPreview = await buildPreviewFromFile(buffer, filename, mimeType);
			const prompt = createPrompt({ filename, mimeType, contentPreview });
			responseText = await generateAIResponse(prompt);
		}

		if (!responseText) {
			return null;
		}

		const jsonString = extractJsonBlock(responseText);
		const parsed = JSON.parse(jsonString);
		return normalizeAiResult(parsed, filename);
	} catch (error) {
		console.error(`AI analysis failed for ${filename}: ${error.message}`);
		return null;
	}
}

module.exports = {
	analyzeFile,
};

