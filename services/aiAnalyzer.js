const path = require("path");
const pdfParseLib = require("pdf-parse");
const pdfParse = pdfParseLib.PDFParse || pdfParseLib;
const mammoth = require("mammoth");
const AdmZip = require("adm-zip");
const Tesseract = require("tesseract.js");
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
const ARCHIVE_EXTENSIONS = new Set([".zip"]);

const KEYWORD_STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it", "its",
	"of", "on", "or", "that", "the", "to", "was", "were", "with", "this", "these", "those", "your", "you",
	"will", "can", "not", "null", "true", "false", "let", "const", "var", "function", "class", "import", "export",
]);

const MAX_PREVIEW_CHARS = 8000;
const MAX_PROMPT_CHARS_PER_FILE = 1800;
const MAX_PROMPT_TEXT_CHARS = 16000;
const MAX_TEXT_CHARS = 120000;
const MAX_PDF_CHARS = 240000;
const MAX_CODE_CHARS = 180000;
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_NAME_SAMPLES = 28;
const MAX_OCR_TIMEOUT_MS = Number(process.env.AI_OCR_TIMEOUT_MS) > 0 ? Number(process.env.AI_OCR_TIMEOUT_MS) : 25000;
const MAX_OCR_BYTES = Number(process.env.AI_OCR_MAX_BYTES) > 0 ? Number(process.env.AI_OCR_MAX_BYTES) : 8 * 1024 * 1024;
const OCR_ENABLED = String(process.env.AI_OCR_ENABLED || "true").toLowerCase() !== "false";

const EXTENSION_LANGUAGE = {
	".js": "JavaScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".jsx": "JavaScript",
	".py": "Python",
	".java": "Java",
	".cpp": "C++",
	".c": "C",
	".h": "C/C++ Header",
	".hpp": "C++ Header",
	".go": "Go",
	".rs": "Rust",
	".php": "PHP",
	".rb": "Ruby",
	".swift": "Swift",
	".kt": "Kotlin",
	".sql": "SQL",
	".json": "JSON",
	".yaml": "YAML",
	".yml": "YAML",
	".xml": "XML",
	".html": "HTML",
	".css": "CSS",
};

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

function safeTextFromBuffer(buffer, maxChars = MAX_TEXT_CHARS) {
	if (!buffer) {
		return "";
	}

	try {
		return cleanPreviewText(Buffer.from(buffer).toString("utf8"), maxChars);
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

function formatSizeMB(bytes) {
	const value = Number(bytes || 0);
	if (!Number.isFinite(value) || value <= 0) {
		return "0 MB";
	}

	return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 1 : 2)} MB`;
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

function chunkText(text, chunkChars = 3500, maxChunks = 20) {
	const raw = cleanPreviewText(text || "", MAX_PDF_CHARS);
	if (!raw) {
		return [];
	}

	const chunks = [];
	let cursor = 0;
	while (cursor < raw.length && chunks.length < maxChunks) {
		let end = Math.min(cursor + chunkChars, raw.length);
		if (end < raw.length) {
			const boundary = raw.lastIndexOf(" ", end);
			if (boundary > cursor + Math.floor(chunkChars * 0.5)) {
				end = boundary;
			}
		}

		chunks.push(raw.slice(cursor, end).trim());
		cursor = end;
	}

	return chunks.filter(Boolean);
}

function normalizeSummary(value, fallbackSummary) {
	const cleaned = cleanPreviewText(String(value || ""), 700).replace(/\n+/g, " ").trim();
	if (!cleaned || cleaned.length < 24) {
		return fallbackSummary;
	}

	return cleaned;
}

function normalizeKeyPoints(input, fallback = []) {
	const normalized = Array.isArray(input)
		? input.map((item) => cleanPreviewText(String(item || ""), 140)).filter(Boolean)
		: [];

	if (normalized.length > 0) {
		return normalized.slice(0, 5);
	}

	return Array.isArray(fallback)
		? fallback.map((item) => cleanPreviewText(String(item || ""), 140)).filter(Boolean).slice(0, 5)
		: [];
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

	if (SPREADSHEET_EXTENSIONS.has(ext) || lowerMime.includes("spreadsheet") || lowerMime.includes("csv") || lowerMime.includes("excel")) {
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

	if (ARCHIVE_EXTENSIONS.has(ext) || lowerMime.includes("zip")) {
		return "Other";
	}

	return "Other";
}

function detectCodeLanguage(filename, mimeType) {
	const ext = String(path.extname(filename || "")).toLowerCase();
	if (EXTENSION_LANGUAGE[ext]) {
		return EXTENSION_LANGUAGE[ext];
	}

	const lowerMime = String(mimeType || "").toLowerCase();
	if (lowerMime.includes("javascript")) return "JavaScript";
	if (lowerMime.includes("typescript")) return "TypeScript";
	if (lowerMime.includes("python")) return "Python";
	if (lowerMime.includes("java")) return "Java";
	if (lowerMime.includes("json")) return "JSON";
	if (lowerMime.includes("xml")) return "XML";
	if (lowerMime.includes("yaml")) return "YAML";
	return "Code";
}

function extractCodeSymbols(text, limit = 12) {
	const source = String(text || "");
	if (!source) {
		return [];
	}

	const patterns = [
		/function\s+([A-Za-z_$][\w$]*)\s*\(/g,
		/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
		/def\s+([A-Za-z_][\w]*)\s*\(/g,
		/class\s+([A-Za-z_$][\w$]*)/g,
		/(?:public|private|protected|static|async|final|virtual|inline|\s)+[A-Za-z_$][\w$<>\[\]]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/g,
	];

	const seen = new Set();
	for (const pattern of patterns) {
		let match = pattern.exec(source);
		while (match) {
			const symbol = String(match[1] || "").trim();
			if (symbol && symbol.length <= 80) {
				seen.add(symbol);
				if (seen.size >= limit) {
					return [...seen];
				}
			}
			match = pattern.exec(source);
		}
	}

	return [...seen];
}

function extractCodeDependencies(text, limit = 8) {
	const source = String(text || "");
	const deps = new Set();

	const importRegex = /import\s+[^\n]*?from\s+["']([^"']+)["']/g;
	let importMatch = importRegex.exec(source);
	while (importMatch) {
		deps.add(importMatch[1]);
		if (deps.size >= limit) return [...deps];
		importMatch = importRegex.exec(source);
	}

	const requireRegex = /require\(\s*["']([^"']+)["']\s*\)/g;
	let requireMatch = requireRegex.exec(source);
	while (requireMatch) {
		deps.add(requireMatch[1]);
		if (deps.size >= limit) return [...deps];
		requireMatch = requireRegex.exec(source);
	}

	return [...deps];
}

function inferCodePurpose(text) {
	const lower = String(text || "").toLowerCase();
	if (!lower) {
		return "application logic";
	}

	if (/(express|router\.|app\.get\(|app\.post\(|middleware)/.test(lower)) {
		return "http api and server routing";
	}
	if (/(socket\.io|websocket|emit\(|on\()/.test(lower)) {
		return "real-time communication";
	}
	if (/(react|useeffect|usestate|jsx|tsx)/.test(lower)) {
		return "frontend component behavior";
	}
	if (/(select\s+.+\s+from|insert\s+into|update\s+.+\s+set|mongoose|sequelize|typeorm)/.test(lower)) {
		return "database access and data modeling";
	}
	if (/(describe\(|it\(|expect\(|assert\.)/.test(lower)) {
		return "automated testing";
	}
	return "application logic";
}

function buildMetadataSummary({ name, mime, size }) {
	const extension = path.extname(name || "").toLowerCase() || "[no extension]";
	return `${name} is a ${mime || "file"} asset (${formatSize(size)}) with extension ${extension}.`;
}

async function preprocessPdfFile({ buffer, name, size }) {
	try {
		const parsed = await pdfParse(buffer);
		const fullText = cleanPreviewText(parsed.text || "", MAX_PDF_CHARS);
		const chunks = chunkText(fullText, 3500, 24);
		const keywords = keywordHintsFromText(fullText, 8);
		const pageCount = Number(parsed.numpages || 0);

		const summary = fullText
			? `PDF document with ${pageCount || "multiple"} pages covering ${keywords.length ? keywords.slice(0, 4).join(", ") : "structured written material"}.`
			: `PDF document ${name} with ${pageCount || "multiple"} pages and limited extractable text.`;

		const keyPoints = [
			pageCount > 0 ? `Pages: ${pageCount}` : null,
			keywords.length ? `Topics: ${keywords.slice(0, 5).join(", ")}` : null,
			`Size: ${formatSize(size)}`,
		].filter(Boolean);

		return {
			typeLabel: "pdf",
			preview: cleanPreviewText(chunks.slice(0, 3).join("\n\n") || fullText || summary),
			promptText: cleanPreviewText(chunks.join("\n\n") || fullText || summary, MAX_PROMPT_TEXT_CHARS),
			localSummary: summary,
			keyPoints,
			imageDescription: null,
			riskFlags: [],
		};
	} catch (error) {
		logError("PDF preprocessing failed", error, `FILE: ${name}`);
		return {
			typeLabel: "pdf",
			preview: cleanPreviewText(buildMetadataSummary({ name, mime: "application/pdf", size })),
			promptText: cleanPreviewText(buildMetadataSummary({ name, mime: "application/pdf", size }), MAX_PROMPT_TEXT_CHARS),
			localSummary: `PDF document ${name} (${formatSize(size)}) where text extraction failed, so metadata-based analysis is used.`,
			keyPoints: ["PDF format", `Size: ${formatSize(size)}`, "Text extraction fallback used"],
			imageDescription: null,
			riskFlags: ["pdf_text_extraction_failed"],
		};
	}
}

async function preprocessDocxFile({ buffer, name, size }) {
	try {
		const parsed = await mammoth.extractRawText({ buffer });
		const fullText = cleanPreviewText(parsed.value || "", MAX_TEXT_CHARS);
		const keywords = keywordHintsFromText(fullText, 8);

		return {
			typeLabel: "docx",
			preview: cleanPreviewText(fullText),
			promptText: cleanPreviewText(fullText, MAX_PROMPT_TEXT_CHARS),
			localSummary: fullText
				? `DOCX document discussing ${keywords.length ? keywords.slice(0, 4).join(", ") : "written content"}.`
				: `DOCX document ${name} with very limited extractable text.`,
			keyPoints: [
				keywords.length ? `Topics: ${keywords.slice(0, 5).join(", ")}` : "Document text available",
				`Size: ${formatSize(size)}`,
			],
			imageDescription: null,
			riskFlags: [],
		};
	} catch (error) {
		logError("DOCX preprocessing failed", error, `FILE: ${name}`);
		return {
			typeLabel: "docx",
			preview: cleanPreviewText(buildMetadataSummary({ name, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size })),
			promptText: cleanPreviewText(buildMetadataSummary({ name, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size }), MAX_PROMPT_TEXT_CHARS),
			localSummary: `DOCX file ${name} (${formatSize(size)}) analyzed using metadata because text extraction failed.`,
			keyPoints: ["DOCX format", `Size: ${formatSize(size)}`, "Text extraction fallback used"],
			imageDescription: null,
			riskFlags: ["docx_text_extraction_failed"],
		};
	}
}

async function extractImageTextWithOcr(buffer, name) {
	if (!OCR_ENABLED) {
		return { text: "", skippedReason: "ocr_disabled" };
	}

	if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
		return { text: "", skippedReason: "empty_image_buffer" };
	}

	if (buffer.length > MAX_OCR_BYTES) {
		return { text: "", skippedReason: "ocr_size_limit" };
	}

	const timeoutPromise = new Promise((_, reject) => {
		setTimeout(() => reject(new Error("OCR timeout")), MAX_OCR_TIMEOUT_MS);
	});

	try {
		const result = await Promise.race([
			Tesseract.recognize(buffer, "eng", { logger: () => {} }),
			timeoutPromise,
		]);

		const text = cleanPreviewText(result?.data?.text || "", MAX_TEXT_CHARS);
		if (!text) {
			return { text: "", skippedReason: "ocr_no_text_detected" };
		}

		return { text, skippedReason: "" };
	} catch (error) {
		logError("Image OCR failed", error, `FILE: ${name}`);
		return { text: "", skippedReason: "ocr_failed" };
	}
}

async function preprocessImageFile({ buffer, name, mime, size }) {
	const ocr = await extractImageTextWithOcr(buffer, name);
	const text = ocr.text;
	const keywords = keywordHintsFromText(text, 6);
	const riskFlags = ocr.skippedReason ? [ocr.skippedReason] : [];

	if (text) {
		const summary = `Image containing readable text focused on ${keywords.length ? keywords.slice(0, 4).join(", ") : "documented visual content"}.`;
		const firstLine = text.split(/\n+/).find((line) => line.trim().length > 0) || "";

		return {
			typeLabel: "image",
			preview: cleanPreviewText(text),
			promptText: cleanPreviewText(text, MAX_PROMPT_TEXT_CHARS),
			localSummary: summary,
			keyPoints: [
				keywords.length ? `Topics: ${keywords.slice(0, 5).join(", ")}` : "OCR text extracted",
				firstLine ? `Leading text: ${cleanPreviewText(firstLine, 120)}` : null,
				`Size: ${formatSize(size)}`,
			].filter(Boolean),
			imageDescription: `Image with extracted text: ${cleanPreviewText(firstLine || text, 180)}`,
			riskFlags,
		};
	}

	return {
		typeLabel: "image",
		preview: cleanPreviewText(`${name}\nType: ${mime || "image"}\nSize: ${formatSize(size)}`),
		promptText: cleanPreviewText(`Image asset metadata\nName: ${name}\nType: ${mime || "image"}\nSize: ${formatSize(size)}`, MAX_PROMPT_TEXT_CHARS),
		localSummary: `Image asset (${mime || "image"}) shared as visual content${riskFlags.length ? " with limited OCR text detected" : ""}.`,
		keyPoints: [
			`Image format: ${mime || path.extname(name || "").toLowerCase().replace(".", "") || "image"}`,
			`Size: ${formatSize(size)}`,
			"Visual asset suitable for image preview",
		],
		imageDescription: `Visual image asset (${mime || "image"}) named ${name}.`,
		riskFlags,
	};
}

function preprocessZipFile({ buffer, name, size }) {
	try {
		const zip = new AdmZip(buffer);
		const allEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
		const entries = allEntries.slice(0, MAX_ZIP_ENTRIES);
		const typeCounts = new Map();
		const sampledNames = entries.slice(0, MAX_ZIP_NAME_SAMPLES).map((entry) => entry.entryName);

		for (const entry of entries) {
			const ext = path.extname(entry.entryName || "").toLowerCase() || "[no-ext]";
			typeCounts.set(ext, (typeCounts.get(ext) || 0) + 1);
		}

		const sortedTypes = [...typeCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 6)
			.map(([ext, count]) => `${ext} (${count})`);

		const summary = `ZIP archive containing ${allEntries.length} files${sortedTypes.length ? ` with main file types ${sortedTypes.join(", ")}` : ""}.`;
		const preview = [
			summary,
			"Sample entries:",
			...sampledNames,
		].join("\n");

		const riskFlags = [];
		if (allEntries.length > MAX_ZIP_ENTRIES) {
			riskFlags.push("large_archive_entry_count");
		}

		return {
			typeLabel: "zip archive",
			preview: cleanPreviewText(preview),
			promptText: cleanPreviewText(preview, MAX_PROMPT_TEXT_CHARS),
			localSummary: summary,
			keyPoints: [
				`Files in archive: ${allEntries.length}`,
				sortedTypes.length ? `Top types: ${sortedTypes.slice(0, 4).join(", ")}` : "Mixed file types",
				sampledNames.length ? `Representative paths: ${sampledNames.slice(0, 5).join(", ")}` : "No file entries",
				`Archive size: ${formatSize(size)}`,
			],
			imageDescription: null,
			riskFlags,
		};
	} catch (error) {
		logError("ZIP preprocessing failed", error, `FILE: ${name}`);
		return {
			typeLabel: "zip archive",
			preview: cleanPreviewText(buildMetadataSummary({ name, mime: "application/zip", size })),
			promptText: cleanPreviewText(buildMetadataSummary({ name, mime: "application/zip", size }), MAX_PROMPT_TEXT_CHARS),
			localSummary: `ZIP archive ${name} (${formatSize(size)}) where entry parsing failed, so metadata-based analysis is used.`,
			keyPoints: ["ZIP archive", `Size: ${formatSize(size)}`, "Entry parsing fallback used"],
			imageDescription: null,
			riskFlags: ["zip_entry_parse_failed"],
		};
	}
}

function preprocessTabularFile({ buffer, name, ext, size }) {
	const delimiter = ext === ".tsv" ? "\t" : ",";
	const text = safeTextFromBuffer(buffer, MAX_TEXT_CHARS);
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const header = lines[0] || "";
	const headerCells = header ? header.split(delimiter).map((cell) => cell.trim()).filter(Boolean) : [];
	const rowCount = Math.max(0, lines.length - (header ? 1 : 0));

	const summary = `Tabular dataset with ${rowCount} row${rowCount === 1 ? "" : "s"}${headerCells.length ? ` and columns ${headerCells.slice(0, 6).join(", ")}` : ""}.`;

	return {
		typeLabel: ext === ".tsv" ? "tsv" : "csv",
		preview: cleanPreviewText(lines.slice(0, 24).join("\n") || summary),
		promptText: cleanPreviewText(text || summary, MAX_PROMPT_TEXT_CHARS),
		localSummary: summary,
		keyPoints: [
			`Rows: ${rowCount}`,
			headerCells.length ? `Columns: ${headerCells.slice(0, 8).join(", ")}` : "Column headers unavailable",
			`Size: ${formatSize(size)}`,
		],
		imageDescription: null,
		riskFlags: [],
	};
}

function preprocessCodeFile({ buffer, name, mime, size }) {
	const source = safeTextFromBuffer(buffer, MAX_CODE_CHARS);
	const language = detectCodeLanguage(name, mime);
	const symbols = extractCodeSymbols(source, 12);
	const deps = extractCodeDependencies(source, 8);
	const purpose = inferCodePurpose(source);
	const keywords = keywordHintsFromText(source, 8);

	const summary = `Source code in ${language} focused on ${purpose}${keywords.length ? ` with notable terms ${keywords.slice(0, 4).join(", ")}` : ""}.`;

	return {
		typeLabel: `${language.toLowerCase()} code`,
		preview: cleanPreviewText(source),
		promptText: cleanPreviewText(source, MAX_PROMPT_TEXT_CHARS),
		localSummary: summary,
		keyPoints: [
			`Language: ${language}`,
			`Purpose: ${purpose}`,
			symbols.length ? `Functions/classes: ${symbols.slice(0, 7).join(", ")}` : "No explicit symbols extracted",
			deps.length ? `Dependencies: ${deps.slice(0, 6).join(", ")}` : "No external dependencies extracted",
			`Size: ${formatSize(size)}`,
		],
		imageDescription: null,
		riskFlags: [],
	};
}

function preprocessTextFile({ buffer, name, mime, size }) {
	const text = safeTextFromBuffer(buffer, MAX_TEXT_CHARS);
	const keywords = keywordHintsFromText(text, 8);

	return {
		typeLabel: mime?.includes("markdown") ? "markdown" : "text",
		preview: cleanPreviewText(text),
		promptText: cleanPreviewText(text, MAX_PROMPT_TEXT_CHARS),
		localSummary: text
			? `Text document discussing ${keywords.length ? keywords.slice(0, 5).join(", ") : "general written content"}.`
			: `${name} is a text document with very limited readable characters.`,
		keyPoints: [
			keywords.length ? `Topics: ${keywords.slice(0, 6).join(", ")}` : "Readable text available",
			`Size: ${formatSize(size)}`,
		],
		imageDescription: null,
		riskFlags: [],
	};
}

function preprocessMetadataOnlyFile({ name, mime, size }) {
	const summary = buildMetadataSummary({ name, mime, size });

	return {
		typeLabel: mime || path.extname(name || "").replace(".", "") || "file",
		preview: cleanPreviewText(summary),
		promptText: cleanPreviewText(summary, MAX_PROMPT_TEXT_CHARS),
		localSummary: `${summary} File is analyzed using metadata, naming, and transfer context.`,
		keyPoints: [
			`MIME: ${mime || "application/octet-stream"}`,
			`Size: ${formatSize(size)}`,
			`Filename: ${name}`,
		],
		imageDescription: null,
		riskFlags: [],
	};
}

async function preprocessFileContent(file) {
	const name = file.originalname || file.filename || "file";
	const mime = String(file.mimetype || file.mimeType || "application/octet-stream").toLowerCase();
	const size = Number(file.size || (file.buffer ? file.buffer.length : 0) || 0);
	const ext = String(path.extname(name || "")).toLowerCase();

	if (mime.includes("pdf") || ext === ".pdf") {
		return preprocessPdfFile({ buffer: file.buffer, name, size });
	}

	if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith("image/")) {
		return preprocessImageFile({ buffer: file.buffer, name, mime, size });
	}

	if (ARCHIVE_EXTENSIONS.has(ext) || mime.includes("zip")) {
		return preprocessZipFile({ buffer: file.buffer, name, size });
	}

	if (mime.includes("wordprocessingml") || ext === ".docx") {
		return preprocessDocxFile({ buffer: file.buffer, name, size });
	}

	if (ext === ".csv" || ext === ".tsv" || mime.includes("csv") || mime.includes("tsv")) {
		return preprocessTabularFile({ buffer: file.buffer, name, ext: ext === ".tsv" ? ".tsv" : ".csv", size });
	}

	if (CODE_EXTENSIONS.has(ext)) {
		return preprocessCodeFile({ buffer: file.buffer, name, mime, size });
	}

	if (mime.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
		return preprocessTextFile({ buffer: file.buffer, name, mime, size });
	}

	return preprocessMetadataOnlyFile({ name, mime, size });
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

function inferDetectedIntent(category, fileCount) {
	if (category === "Assignment") return "sharing coursework";
	if (category === "Invoice") return "sending invoice";
	if (category === "Code") return "sharing source code";
	if (category === "Presentation") return "sharing presentation";
	if (category === "Spreadsheet") return "sharing spreadsheet";
	if (category === "Image") return fileCount > 1 ? "sharing photos" : "sharing image";
	if (category === "Report") return "sharing report";
	if (category === "Notes") return "sharing notes";
	return "sharing files";
}

function buildFallbackSummary({ fileCount, totalSize, category, keywords, detectedIntent }) {
	const keywordText = Array.isArray(keywords) && keywords.length
		? ` Key topics detected: ${keywords.slice(0, 5).join(", ")}.`
		: "";

	if (fileCount > 1) {
		return `${fileCount} files (${formatSize(totalSize)}) centered on ${category.toLowerCase()} material, likely shared for ${detectedIntent}.${keywordText}`.trim();
	}

	return `Single ${category.toLowerCase()} file (${formatSize(totalSize)}) likely shared for ${detectedIntent}.${keywordText}`.trim();
}

function buildPrompt({ fileCount, totalSize, primaryFilename, primaryMime, manifest, preview, keywords }) {
	return [
		"System: You are SwiftShare AI, an elite, hyper-intelligent data analyst. Your job is to analyze file transfers and provide deeply insightful, concise, and structured metadata.",
		"CRITICAL: Output valid JSON ONLY. No markdown formatting, no preamble, no trailing text.",
		"",
		"--- JSON SCHEMA ---",
		"{",
		"  \"overall_summary\": \"String. 2-3 punchy, insightful sentences. What is this bundle? Why is it being sent? What is the core value? Avoid generic phrases like 'This transfer contains'.\",",
		"  \"suggested_filename\": \"String. Short, descriptive, kebab-case (e.g., 'q1-financial-reports'). Max 50 chars.\",",
		"  \"category\": \"String. Choose ONE: Assignment, Notes, Invoice, Report, Asset-Bundle, Codebase, Presentation, Spreadsheet, Backup, Mixed-Media, Other.\",",
		"  \"imageDescription\": \"String or null. If an image has visual descriptions, summarize them. Else null.\",",
		"  \"detected_intent\": \"String. 2-4 words maximum (e.g., 'Project handoff', 'Sharing vacation photos', 'Code review').\",",
		"  \"risk_flags\": \"Array of Strings. Identify risks based on content (e.g., ['Contains PII', 'Large executable', 'Financial data']). Empty array [] if completely safe.\",",
		"  \"files\": [",
		"    {",
		"      \"name\": \"String. Exact filename.\",",
		"      \"type\": \"String. File extension/type.\",",
		"      \"summary\": \"String. 1 sentence. What EXACTLY is in this file based on the extracted text? NEVER say 'cannot be previewed' or 'binary'. If text is sparse, infer purpose from name/type.\",",
		"      \"key_points\": [\"String\", \"String\"] // 2 bullet points of specific data, metrics, or features found inside. Max 8 words each.",
		"    }",
		"  ]",
		"}",
		"--- END SCHEMA ---",
		"",
		"RULES FOR GEMINI 2.5 FLASH:",
		"1. BE SPECIFIC: Use the 'DETAILED FILE CONTENT'. Quote actual metrics, names, or code functions you see.",
		"2. NO EXCUSES: NEVER write 'cannot be directly previewed', 'binary nature', or 'requires extraction'. If a file is an image or zip without deep text, deduce its purpose intelligently from its filename and context.",
		"3. CONCISE & PUNCHY: Do not waste tokens on filler words. Get straight to the insights to avoid truncation.",
		"4. COMPLETE ANALYSIS: You MUST generate a complete JSON object covering EVERY file in the manifest.",
		"",
		"[TRANSFER METADATA]",
		`Total Files: ${fileCount}`,
		`Total Size: ${formatSizeMB(totalSize)}`,
		`Primary File: ${primaryFilename} (${primaryMime})`,
		`Keywords: ${keywords.length ? keywords.join(", ") : "None"}`,
		"",
		"[FILE MANIFEST]",
		manifest,
		"",
		"[DETAILED FILE CONTENT TO ANALYZE]",
		preview,
	].join("\n");
}

async function buildTransferContext(files) {
	const validFiles = Array.isArray(files) ? files.filter(Boolean) : [];
	if (!validFiles.length) {
		return null;
	}

	const enrichedFiles = [];
	for (let idx = 0; idx < validFiles.length; idx += 1) {
		const file = validFiles[idx];
		const name = file.originalname || file.filename || "file";
		const mime = String(file.mimetype || file.mimeType || "application/octet-stream").toLowerCase();
		const size = Number(file.size || (file.buffer ? file.buffer.length : 0) || 0);
		const processed = await preprocessFileContent(file);

		const combinedText = `${processed.preview || ""}\n${processed.localSummary || ""}`;
		const categoryGuess = detectCategoryWithoutAI(name, mime, combinedText);

		enrichedFiles.push({
			name,
			mime,
			size,
			buffer: file.buffer,
			categoryGuess,
			typeLabel: cleanPreviewText(processed.typeLabel || mime || "file", 64),
			preview: cleanPreviewText(processed.preview || processed.localSummary || ""),
			promptText: cleanPreviewText(processed.promptText || processed.preview || processed.localSummary || "", MAX_PROMPT_TEXT_CHARS),
			localSummary: normalizeSummary(processed.localSummary, buildMetadataSummary({ name, mime, size })),
			localKeyPoints: normalizeKeyPoints(processed.keyPoints, [`Size: ${formatSize(size)}`]),
			imageDescription: processed.imageDescription ? cleanPreviewText(processed.imageDescription, 220) : null,
			riskFlags: Array.isArray(processed.riskFlags)
				? processed.riskFlags.map((flag) => cleanPreviewText(String(flag || ""), 80)).filter(Boolean)
				: [],
		});

		if (idx % 2 === 1) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	const totalSize = enrichedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
	const primary = enrichedFiles[0];
	const aggregateText = cleanPreviewText(enrichedFiles.map((file) => file.promptText || file.preview || file.localSummary).join("\n\n"), MAX_PDF_CHARS);
	const keywords = keywordHintsFromText(aggregateText, 10);
	const manifest = enrichedFiles
		.map((file, idx) => `${idx + 1}. ${file.name} | ${file.mime} | ${formatSize(file.size)} | guessed=${file.categoryGuess}`)
		.join("\n");

	const topCategory = pickDominantCategory(enrichedFiles);
	const detectedIntent = inferDetectedIntent(topCategory, enrichedFiles.length);
	const riskFlags = [...new Set(enrichedFiles.flatMap((file) => file.riskFlags))].slice(0, 8);

	return {
		fileCount: enrichedFiles.length,
		totalSize,
		primaryFilename: primary.name,
		primaryMime: String(primary.mime || "").toLowerCase(),
		primaryBuffer: primary.buffer,
		manifest,
		preview: cleanPreviewText(
			enrichedFiles
				.map((file, idx) => {
					const snippet = cleanPreviewText(file.promptText || file.preview || file.localSummary, MAX_PROMPT_CHARS_PER_FILE);
					return [
						`--- FILE ${idx + 1}: ${file.name} ---`,
						`Type: ${file.typeLabel}`,
						`MIME: ${file.mime}`,
						`Size: ${formatSize(file.size)}`,
						`Guessed category: ${file.categoryGuess}`,
						`Local analysis: ${file.localSummary}`,
						`Local key points: ${file.localKeyPoints.join(" | ")}`,
						"Extracted content snippet:",
						snippet,
					].join("\n");
				})
				.join("\n\n"),
			MAX_PROMPT_TEXT_CHARS,
		),
		keywords,
		category: topCategory,
		detectedIntent,
		localOverallSummary: buildFallbackSummary({
			fileCount: enrichedFiles.length,
			totalSize,
			category: topCategory,
			keywords,
			detectedIntent,
		}),
		riskFlags,
		enrichedFiles,
	};
}

function normalizeAiResult(parsed, context) {
	const fallbackSummary = context.localOverallSummary;
	const fallbackCategory = context.category;
	const fallbackName = sanitizeSuggestedName(path.parse(context.primaryFilename || "file").name || "file");

	const parsedCategory = typeof parsed?.category === "string" ? parsed.category.trim() : "";
	const category = ALLOWED_CATEGORIES.has(parsedCategory)
		? parsedCategory
		: fallbackCategory;

	const rawSummary = parsed?.overall_summary || parsed?.summary;
	const summary = normalizeSummary(rawSummary, fallbackSummary);
	const rawSuggestedName = parsed?.suggested_filename || parsed?.suggestedName;
	const suggestedName = sanitizeSuggestedName(rawSuggestedName, fallbackName);

	const aiFiles = Array.isArray(parsed?.files) ? parsed.files : [];
	const findAiFile = (targetName, index) => {
		const normalizedTarget = String(targetName || "").trim().toLowerCase();
		const byName = aiFiles.find((item) => String(item?.name || "").trim().toLowerCase() === normalizedTarget);
		if (byName) {
			return byName;
		}
		return aiFiles[index] || null;
	};

	const files = context.enrichedFiles.map((file, index) => {
		const candidate = findAiFile(file.name, index);
		return {
			name: String(file.name || "").slice(0, 128),
			type: cleanPreviewText(String(candidate?.type || file.typeLabel || file.mime || "file"), 64),
			summary: normalizeSummary(candidate?.summary, file.localSummary),
			key_points: normalizeKeyPoints(candidate?.key_points, file.localKeyPoints),
		};
	});

	const detectedIntent = typeof parsed?.detected_intent === "string"
		? cleanPreviewText(parsed.detected_intent, 120)
		: context.detectedIntent;

	const aiRiskFlags = Array.isArray(parsed?.risk_flags)
		? parsed.risk_flags.map((flag) => cleanPreviewText(String(flag || ""), 80)).filter(Boolean)
		: [];
	const riskFlags = [...new Set([...(context.riskFlags || []), ...aiRiskFlags])].slice(0, 8);

	let imageDescription = null;
	if (category === "Image" || context.primaryMime.startsWith("image/")) {
		const aiImageDescription = cleanPreviewText(parsed?.imageDescription || "", 220);
		const fallbackImageDescription = context.enrichedFiles.find((file) => file.imageDescription)?.imageDescription || null;
		imageDescription = aiImageDescription || fallbackImageDescription;
	}

	return {
		// Backward compat
		summary,
		suggestedName,
		category,
		imageDescription,
		// New structured fields
		files,
		detectedIntent,
		riskFlags,
	};
}

async function analyzeTransfer(files) {
	let context = null;

	try {
		context = await buildTransferContext(files);
		if (!context) {
			return null;
		}

		if (!canUseAI()) {
			logEvent("AI analysis skipped", "local rate safety limit reached");
			return normalizeAiResult(null, context);
		}

		const prompt = buildPrompt({
			fileCount: context.fileCount,
			totalSize: context.totalSize,
			primaryFilename: context.primaryFilename,
			primaryMime: context.primaryMime,
			manifest: context.manifest,
			preview: context.preview,
			keywords: context.keywords,
		});
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
			if (!context) {
				context = await buildTransferContext(files);
			}

			if (!context) {
				return null;
			}

			return normalizeAiResult(null, context);
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

