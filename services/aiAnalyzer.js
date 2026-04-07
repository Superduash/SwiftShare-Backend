const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { generateAIResponse } = require("../config/gemini");
const { logEvent, logError } = require("../utils/logger");

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

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".py", ".java", ".cpp", ".c", ".h", ".hpp", ".html", ".css", ".ts", ".tsx", ".jsx", ".go", ".rs", ".php", ".rb", ".swift", ".kt", ".sql", ".json", ".yaml", ".yml", ".xml"]);
const PRESENTATION_EXTENSIONS = new Set([".ppt", ".pptx", ".key"]);
const SPREADSHEET_EXTENSIONS = new Set([".xls", ".xlsx", ".csv", ".tsv", ".ods"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".heic"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".rtf", ".log"]);

const KEYWORD_STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it", "its",
	"of", "on", "or", "that", "the", "to", "was", "were", "with", "this", "these", "those", "your", "you",
	"will", "can", "not", "null", "true", "false", "let", "const", "var", "function", "class", "import", "export",
]);

const MAX_PREVIEW_CHARS = 6000;
const MAX_MODEL_FILES = 3;

let currentWindowStart = Date.now();
let requestCountInWindow = 0;

function getAiAnalyzerMaxRequests() {
	const configured = Number(process.env.AI_ANALYZER_MAX_RPM);
	if (Number.isFinite(configured) && configured > 0) {
		return Math.max(1, Math.floor(configured));
	}

	return 14;
}

function canUseAI() {
	const now = Date.now();
	if (now - currentWindowStart >= 60_000) {
		currentWindowStart = now;
		requestCountInWindow = 0;
	}

	if (requestCountInWindow >= getAiAnalyzerMaxRequests()) {
		return false;
	}

	requestCountInWindow += 1;
	return true;
}

function cleanPreviewText(text, maxChars = MAX_PREVIEW_CHARS) {
	return String(text || "")
		.replace(/\u0000/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, maxChars);
}

function safeTextFromBuffer(buffer) {
	if (!buffer) {
		return "";
	}

	try {
		return Buffer.from(buffer).toString("utf8");
	} catch (error) {
		return "";
	}
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

function parseAiJson(responseText) {
	const base = extractJsonBlock(responseText);
	const candidates = [
		base,
		base.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
		base.replace(/,\s*([}\]])/g, "$1"),
	];

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch (error) {
			// Try next candidate.
		}
	}

	return null;
}

function sanitizeSuggestedName(value, fallback = "file") {
	const parsedBase = path.parse(String(value || "")).name;
	const raw = (parsedBase || fallback || "file").toLowerCase();
	const slug = raw
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);

	if (!slug) {
		const safeFallback = String(fallback || "file").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		return safeFallback || "file";
	}

	return slug;
}

function formatSize(bytes) {
	const value = Number(bytes || 0);
	if (!value) {
		return "0 B";
	}

	const units = ["B", "KB", "MB", "GB"];
	const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	const amount = value / Math.pow(1024, exponent);
	return `${amount.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function keywordHintsFromText(text, limit = 6) {
	const words = String(text || "")
		.toLowerCase()
		.match(/[a-z][a-z0-9_-]{2,24}/g) || [];

	const counts = new Map();
	for (const word of words) {
		if (KEYWORD_STOPWORDS.has(word)) {
			continue;
		}

		counts.set(word, (counts.get(word) || 0) + 1);
	}

	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([word]) => word);
}

function detectCategoryWithoutAI(filename, mimeType, previewText = "") {
	const ext = String(path.extname(filename || "")).toLowerCase();
	const lowerMime = String(mimeType || "").toLowerCase();
	const lowerName = String(filename || "").toLowerCase();
	const lowerPreview = String(previewText || "").toLowerCase();

	if (IMAGE_EXTENSIONS.has(ext) || lowerMime.startsWith("image/")) {
		return "Image";
	}

	if (CODE_EXTENSIONS.has(ext)) {
		return "Code";
	}

	if (PRESENTATION_EXTENSIONS.has(ext) || lowerMime.includes("presentation")) {
		return "Presentation";
	}

	if (SPREADSHEET_EXTENSIONS.has(ext) || lowerMime.includes("spreadsheet") || lowerMime.includes("csv")) {
		return "Spreadsheet";
	}

	if (VIDEO_EXTENSIONS.has(ext) || lowerMime.startsWith("video/")) {
		return "Video";
	}

	if (AUDIO_EXTENSIONS.has(ext) || lowerMime.startsWith("audio/")) {
		return "Audio";
	}

	if (/invoice|receipt|bill|quotation/.test(lowerName) || /invoice|subtotal|tax|amount due|bill to/.test(lowerPreview)) {
		return "Invoice";
	}

	if (/assignment|homework|coursework|lab/.test(lowerName) || /question\s*\d+|submission|deadline|student/.test(lowerPreview)) {
		return "Assignment";
	}

	if (/report|analysis|findings|executive/.test(lowerName) || /executive summary|methodology|conclusion/.test(lowerPreview)) {
		return "Report";
	}

	if (/notes|meeting|minutes|lecture/.test(lowerName) || /agenda|notes|minutes/.test(lowerPreview)) {
		return "Notes";
	}

	if (TEXT_EXTENSIONS.has(ext) || lowerMime.startsWith("text/")) {
		return "Notes";
	}

	return "Other";
}

function buildFallbackSummary({
	fileCount,
	totalSize,
	category,
	primaryFilename,
	keywords,
}) {
	const keywordText = Array.isArray(keywords) && keywords.length
		? ` Key topics detected: ${keywords.slice(0, 4).join(", ")}.`
		: "";

	if (fileCount > 1) {
		return `This transfer contains ${fileCount} files (${formatSize(totalSize)}) and appears to be ${category.toLowerCase()}-focused content.${keywordText}`.trim();
	}

	const baseName = path.parse(primaryFilename || "file").name || "file";
	return `This file appears to be ${category.toLowerCase()} content based on its filename and extracted text from ${baseName}.${keywordText}`.trim();
}

function normalizeSummary(value, fallbackSummary) {
	const cleaned = cleanPreviewText(String(value || ""), 520).replace(/\n+/g, " ").trim();
	if (!cleaned || cleaned.length < 24) {
		return fallbackSummary;
	}

	return cleaned;
}

function normalizeAiResult(parsed, context) {
	const fallbackSummary = buildFallbackSummary(context);
	const fallbackCategory = context.category;
	const fallbackName = sanitizeSuggestedName(path.parse(context.primaryFilename || "file").name || "file");

	const parsedCategory = typeof parsed?.category === "string" ? parsed.category.trim() : "";
	const category = ALLOWED_CATEGORIES.has(parsedCategory)
		? parsedCategory
		: fallbackCategory;

	const summary = normalizeSummary(parsed?.summary, fallbackSummary);
	const suggestedName = sanitizeSuggestedName(parsed?.suggestedName, fallbackName);

	let imageDescription = null;
	if (category === "Image" || context.primaryMime.startsWith("image/")) {
		const cleanedImageDescription = cleanPreviewText(parsed?.imageDescription || "", 220);
		imageDescription = cleanedImageDescription || null;
	}

	return {
		summary,
		suggestedName,
		category,
		imageDescription,
	};
}

async function buildPreviewFromFile(buffer, filename, mimeType) {
	const lowerMime = String(mimeType || "").toLowerCase();
	const ext = String(path.extname(filename || "")).toLowerCase();

	if (lowerMime.includes("pdf") || ext === ".pdf") {
		try {
			const parsed = await pdfParse(buffer);
			return cleanPreviewText(parsed.text || "");
		} catch (error) {
			return cleanPreviewText(`PDF file: ${filename}`);
		}
	}

	if (lowerMime.includes("wordprocessingml") || ext === ".docx") {
		try {
			const parsed = await mammoth.extractRawText({ buffer });
			return cleanPreviewText(parsed.value || "");
		} catch (error) {
			return cleanPreviewText(`DOCX file: ${filename}`);
		}
	}

	if (ext === ".csv" || ext === ".tsv") {
		const delimiter = ext === ".tsv" ? "\t" : ",";
		const lines = safeTextFromBuffer(buffer).split(/\r?\n/).slice(0, 15);
		const preview = lines
			.map((line) => line.split(delimiter).slice(0, 8).join(delimiter))
			.join("\n");
		return cleanPreviewText(preview || `Tabular file: ${filename}`);
	}

	if (lowerMime.startsWith("text/") || TEXT_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) {
		return cleanPreviewText(safeTextFromBuffer(buffer));
	}

	return cleanPreviewText(`File name: ${filename}\nMime type: ${mimeType}\nBinary/unsupported for direct preview.`);
}

function buildPrompt({ fileCount, totalSize, primaryFilename, primaryMime, manifest, preview, keywords }) {
	return [
		"You are SwiftShare Intelligence, an elite document analyst for instant file transfers.",
		"Return STRICT JSON only (no markdown, no explanation) with exactly these keys:",
		"summary, suggestedName, category, imageDescription",
		"",
		"Rules:",
		"1) summary: 2-4 concrete sentences. Explain what the file or bundle is about, why it matters, and what action the receiver should take next.",
		"2) suggestedName: short kebab-case, no extension, max 64 chars.",
		"3) category: one of Assignment, Notes, Invoice, Report, Image, Video, Audio, Code, Presentation, Spreadsheet, Other.",
		"4) imageDescription: only for image-centric inputs, otherwise null.",
		"5) Prefer factual details over generic wording.",
		"",
		`Transfer facts: fileCount=${fileCount}, totalSize=${formatSize(totalSize)}`,
		`Primary file: ${primaryFilename} (${primaryMime})`,
		`Keyword hints: ${keywords.length ? keywords.join(", ") : "none"}`,
		"",
		"File manifest:",
		manifest,
		"",
		"Extracted preview:",
		preview,
	].join("\n");
}

function pickDominantCategory(enrichedFiles) {
	const priorityOrder = [
		"Invoice",
		"Assignment",
		"Report",
		"Presentation",
		"Spreadsheet",
		"Code",
		"Image",
		"Video",
		"Audio",
		"Notes",
		"Other",
	];

	const priority = new Map(priorityOrder.map((name, idx) => [name, idx]));
	const scores = new Map();

	for (const file of enrichedFiles) {
		const category = file.categoryGuess || "Other";
		const countWeight = 10;
		const sizeWeight = Math.max(0, Number(file.size || 0)) / (1024 * 1024);
		const score = (scores.get(category) || 0) + countWeight + sizeWeight;
		scores.set(category, score);
	}

	return [...scores.entries()]
		.sort((a, b) => {
			if (b[1] !== a[1]) {
				return b[1] - a[1];
			}

			const pa = priority.has(a[0]) ? priority.get(a[0]) : Number.MAX_SAFE_INTEGER;
			const pb = priority.has(b[0]) ? priority.get(b[0]) : Number.MAX_SAFE_INTEGER;
			return pa - pb;
		})[0]?.[0] || "Other";
}

async function buildTransferContext(files) {
	const validFiles = Array.isArray(files) ? files.filter(Boolean) : [];
	if (!validFiles.length) {
		return null;
	}

	const totalSize = validFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
	const modelFiles = validFiles.slice(0, MAX_MODEL_FILES);

	const enriched = await Promise.all(modelFiles.map(async (file) => {
		const preview = await buildPreviewFromFile(
			file.buffer,
			file.originalname || file.filename || "file",
			file.mimetype || file.mimeType || "application/octet-stream",
		);

		const mime = file.mimetype || file.mimeType || "application/octet-stream";
		const name = file.originalname || file.filename || "file";
		const categoryGuess = detectCategoryWithoutAI(name, mime, preview);

		return {
			name,
			mime,
			size: Number(file.size || (file.buffer ? file.buffer.length : 0) || 0),
			preview,
			categoryGuess,
			buffer: file.buffer,
		};
	}));

	const primary = enriched[0];
	const aggregateText = enriched.map((item) => item.preview).join("\n\n");
	const keywords = keywordHintsFromText(aggregateText, 8);
	const manifest = enriched
		.map((file, idx) => `${idx + 1}. ${file.name} | ${file.mime} | ${formatSize(file.size)} | guessed=${file.categoryGuess}`)
		.join("\n");

	const topCategory = pickDominantCategory(enriched);

	return {
		fileCount: validFiles.length,
		totalSize,
		primaryFilename: primary.name,
		primaryMime: String(primary.mime || "").toLowerCase(),
		primaryBuffer: primary.buffer,
		manifest,
		preview: cleanPreviewText(aggregateText, MAX_PREVIEW_CHARS),
		keywords,
		category: topCategory,
	};
}

async function analyzeTransfer(files) {
	try {
		const context = await buildTransferContext(files);
		if (!context) {
			return null;
		}

		if (!canUseAI()) {
			logEvent("AI analysis skipped", "local rate safety limit reached");
			return normalizeAiResult(null, context);
		}

		const prompt = buildPrompt(context);
		const useImageInput = context.fileCount === 1 && context.primaryMime.startsWith("image/") && Boolean(context.primaryBuffer);

		const responseText = useImageInput
			? await generateAIResponse(prompt, context.primaryBuffer, context.primaryMime)
			: await generateAIResponse(prompt);

		if (!responseText) {
			return normalizeAiResult(null, context);
		}

		const parsed = parseAiJson(responseText);
		return normalizeAiResult(parsed, context);
	} catch (error) {
		logError("AI transfer analysis failed", error);

		try {
			const fallbackContext = await buildTransferContext(files);
			if (!fallbackContext) {
				return null;
			}

			return normalizeAiResult(null, fallbackContext);
		} catch (fallbackError) {
			logError("AI transfer fallback failed", fallbackError);
			return null;
		}
	}
}

async function analyzeFile(buffer, filename, mimeType) {
	if (!buffer) {
		return null;
	}

	return analyzeTransfer([
		{
			buffer,
			originalname: filename,
			mimetype: mimeType,
			size: Buffer.isBuffer(buffer) ? buffer.length : 0,
		},
	]);
}

module.exports = {
	analyzeFile,
	analyzeTransfer,
};

