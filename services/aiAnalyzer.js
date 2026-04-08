const path = require("path");
const mammoth = require("mammoth");
const AdmZip = require("adm-zip");

const { analyzeWithFallback } = require("./aiRouter");
const { generateAIResponse } = require("../config/gemini");
const { logEvent, logError } = require("../utils/logger");

function loadPdfParser() {
	try {
		return require("pdf-parse/lib/pdf-parse.js");
	} catch (error) {
		return require("pdf-parse");
	}
}

const pdfParserModule = loadPdfParser();

function isCtorInvocationError(error) {
	const message = String(error?.message || "").toLowerCase();
	return message.includes("cannot be invoked without 'new'")
		|| message.includes("cannot be invoked without \"new\"")
		|| message.includes("class constructor");
}

function toPdfTextResult(value) {
	if (value && typeof value === "object") {
		if (typeof value.text === "string") {
			return { text: value.text };
		}

		if (typeof value.value === "string") {
			return { text: value.value };
		}
	}

	if (typeof value === "string") {
		return { text: value };
	}

	return { text: "" };
}

async function parseWithParserClass(ParserClass, buffer) {
	const parser = new ParserClass({ data: buffer });
	try {
		if (typeof parser.getText === "function") {
			const result = await parser.getText();
			return toPdfTextResult(result);
		}

		if (typeof parser.parseBuffer === "function") {
			const result = await parser.parseBuffer(buffer);
			return toPdfTextResult(result);
		}

		throw new Error("Unsupported parser class API");
	} finally {
		if (typeof parser.destroy === "function") {
			await parser.destroy().catch(() => {});
		}
	}
}

async function parsePdfBuffer(buffer) {
	if (typeof pdfParserModule === "function") {
		try {
			const result = await pdfParserModule(buffer);
			return toPdfTextResult(result);
		} catch (error) {
			if (isCtorInvocationError(error)) {
				return parseWithParserClass(pdfParserModule, buffer);
			}

			throw error;
		}
	}

	if (pdfParserModule && typeof pdfParserModule.default === "function") {
		try {
			const result = await pdfParserModule.default(buffer);
			return toPdfTextResult(result);
		} catch (error) {
			if (isCtorInvocationError(error)) {
				return parseWithParserClass(pdfParserModule.default, buffer);
			}

			throw error;
		}
	}

	if (pdfParserModule && typeof pdfParserModule.PDFParse === "function") {
		return parseWithParserClass(pdfParserModule.PDFParse, buffer);
	}

	throw new Error("Unsupported pdf-parse API shape");
}

const HUMAN_REVIEW_PROMPT = `You are a human reviewing actual file contents.

Explain what each file contains based on its real meaning.

Write naturally like a developer explaining to another person.

Rules:
- 1 sentence per file
- no file-extension or MIME chatter
- no file extensions
- no 'this file contains'
- no repetition

If trusted details are available for media files (artist, title, album, release year, genres), include them in key_points.
Use only high-confidence details; if uncertain, omit.

Focus on purpose and meaning.`;

const REWRITE_PROMPT = "Rewrite this in a more natural, human way. Remove generic phrases.";
const OPENROUTER_VISION_MODEL = "openai/gpt-4o-mini";

const GENERIC_PHRASES = [
	"file named",
	"this file contains",
	"purpose inferred",
	"media sharing",
	"analyzed using",
	"contains image",
	"bundle of files",
	"bundle contains",
	"metadata",
	"mime type",
	"file extension",
	"visual context",
];

const METADATA_STYLE_RE = /\b(pdf|png|jpg|jpeg|gif|webp|mp4|mov|avi|mkv|mime|extension)\b/i;

const STOP_WORDS = new Set([
	"the", "and", "for", "that", "this", "with", "from", "into", "your", "their", "about", "after", "before",
	"have", "has", "are", "was", "were", "will", "been", "being", "into", "onto", "over", "under", "than",
	"using", "used", "they", "them", "its", "only", "also", "very", "just", "then", "when", "where", "what",
	"which", "while", "such", "there", "here", "most", "more", "less", "each", "every", "between", "within",
	"about", "like", "code", "file", "files",
]);

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".go", ".rb", ".php", ".c", ".cpp", ".cs", ".rs", ".swift", ".sh"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".aac", ".m4a", ".ogg", ".opus", ".flac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);
const MUSIC_LOOKUP_CACHE = new Map();
const MUSICBRAINZ_TIMEOUT_MS = 5000;
const ITUNES_TIMEOUT_MS = 5000;
const MUSICBRAINZ_USER_AGENT = "SwiftShare/1.0 (https://swiftshare.local)";

function normalizeWhitespace(value) {
	return String(value || "")
		.replace(/\r/g, "\n")
		.replace(/\u0000/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function clipText(value, maxLength = 260) {
	const text = normalizeWhitespace(value);
	if (text.length <= maxLength) {
		return text;
	}

	let clipped = text.slice(0, Math.max(0, maxLength));
	const boundary = clipped.lastIndexOf(" ");
	if (boundary >= Math.floor(maxLength * 0.6)) {
		clipped = clipped.slice(0, boundary);
	}

	clipped = clipped.trim();
	if (!/[.!?]$/.test(clipped)) {
		clipped = `${clipped}.`;
	}

	return clipped;
}

function ensureSentence(value) {
	const sentences = toSentences(value);
	return sentences.length ? sentences[0] : "";
}

function toSentences(value) {
	const text = normalizeWhitespace(value);
	if (!text) {
		return [];
	}

	return text
		.split(/(?<=[.!?])\s+/)
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => {
			if (/[.!?]$/.test(item)) {
				return item;
			}
			return `${item}.`;
		});
}

function containsGenericPhrase(value) {
	const lower = String(value || "").toLowerCase();
	return GENERIC_PHRASES.some((phrase) => lower.includes(phrase));
}

function unwrapAiText(value) {
	const raw = normalizeWhitespace(value);
	if (!raw) {
		return "";
	}

	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "string") {
			return normalizeWhitespace(parsed);
		}
		if (parsed && typeof parsed === "object") {
			const preferred = parsed.explanation || parsed.summary || parsed.caption || parsed.description;
			if (typeof preferred === "string") {
				return normalizeWhitespace(preferred);
			}
		}
	} catch (error) {
		// Keep raw text when it's not JSON.
	}

	return raw;
}

function extractChatContent(messageContent) {
	if (typeof messageContent === "string") {
		return messageContent;
	}

	if (Array.isArray(messageContent)) {
		return messageContent
			.map((part) => {
				if (typeof part === "string") {
					return part;
				}
				if (part && typeof part.text === "string") {
					return part.text;
				}
				return "";
			})
			.join("\n");
	}

	return "";
}

function getFileName(file) {
	return String(file?.originalname || file?.filename || "file");
}

function getFileExt(name) {
	return path.extname(String(name || "")).toLowerCase();
}

function stripExtension(name) {
	return String(name || "").replace(/\.[^.]+$/, "");
}

function toReleaseYear(value) {
	const match = String(value || "").match(/\b(19|20)\d{2}\b/);
	return match ? match[0] : "";
}

function dedupeStrings(values = []) {
	const seen = new Set();
	const output = [];

	for (const raw of values) {
		const normalized = normalizeWhitespace(raw);
		if (!normalized) {
			continue;
		}

		const key = normalized.toLowerCase();
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		output.push(normalized);
	}

	return output;
}

function parseMediaNameHints(fileName) {
	const base = normalizeWhitespace(stripExtension(fileName));
	if (!base) {
		return { title: "", artist: "", year: "" };
	}

	const cleaned = base
		.replace(/[_]+/g, " ")
		.replace(/\[(official|lyrics?|audio|video|hd|hq|4k)[^\]]*\]/gi, "")
		.replace(/\((official|lyrics?|audio|video|hd|hq|4k)[^)]*\)/gi, "")
		.replace(/\s{2,}/g, " ")
		.trim();

	const year = toReleaseYear(cleaned);
	const parts = cleaned.split(/\s[-–—]\s/).map((item) => item.trim()).filter(Boolean);

	if (parts.length >= 2) {
		const artist = parts[0];
		const title = parts.slice(1).join(" - ");
		return {
			title: normalizeWhitespace(title),
			artist: normalizeWhitespace(artist),
			year,
		};
	}

	return {
		title: normalizeWhitespace(cleaned),
		artist: "",
		year,
	};
}

function pickBestRecording(recordings) {
	if (!Array.isArray(recordings) || recordings.length === 0) {
		return null;
	}

	return [...recordings].sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))[0] || null;
}

function mergeMusicMetadata(primary, secondary) {
	const first = primary || {};
	const second = secondary || {};

	return {
		title: normalizeWhitespace(first.title || second.title || ""),
		artist: normalizeWhitespace(first.artist || second.artist || ""),
		album: normalizeWhitespace(first.album || second.album || ""),
		releaseYear: normalizeWhitespace(first.releaseYear || second.releaseYear || ""),
		genres: dedupeStrings([
			...(Array.isArray(first.genres) ? first.genres : []),
			...(Array.isArray(second.genres) ? second.genres : []),
		]),
	};
}

function pickBestItunesResult(results, hints) {
	if (!Array.isArray(results) || !results.length) return null;

	const titleHint = normalizeWhitespace(hints?.title).toLowerCase();
	const artistHint = normalizeWhitespace(hints?.artist).toLowerCase();

	function score(item) {
		const track = normalizeWhitespace(item?.trackName).toLowerCase();
		const artist = normalizeWhitespace(item?.artistName).toLowerCase();
		let points = 0;

		if (titleHint) {
			if (track === titleHint) points += 5;
			else if (track.includes(titleHint) || titleHint.includes(track)) points += 3;
		}

		if (artistHint) {
			if (artist === artistHint) points += 5;
			else if (artist.includes(artistHint) || artistHint.includes(artist)) points += 3;
		}

		if (String(item?.kind || "").toLowerCase() === "song") points += 1;
		return points;
	}

	return [...results].sort((a, b) => score(b) - score(a))[0] || null;
}

async function fetchItunesSongMetadata(hints) {
	const title = normalizeWhitespace(hints?.title);
	const artist = normalizeWhitespace(hints?.artist);
	if (!title) return null;

	const term = normalizeWhitespace(`${artist} ${title}`).trim();
	if (!term) return null;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), ITUNES_TIMEOUT_MS);

	try {
		const url = `https://itunes.apple.com/search?entity=song&limit=5&term=${encodeURIComponent(term)}`;
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			return null;
		}

		const json = await response.json();
		const best = pickBestItunesResult(json?.results, hints);
		if (!best) {
			return null;
		}

		return {
			title: normalizeWhitespace(best?.trackName || ""),
			artist: normalizeWhitespace(best?.artistName || ""),
			album: normalizeWhitespace(best?.collectionName || ""),
			releaseYear: toReleaseYear(best?.releaseDate || ""),
			genres: dedupeStrings([best?.primaryGenreName]).slice(0, 5),
		};
	} catch (error) {
		if (error?.name !== "AbortError") {
			logError("iTunes metadata lookup failed", error, `TERM: ${term}`);
		}
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function fetchMusicMetadataFromWeb(hints) {
	const title = normalizeWhitespace(hints?.title);
	const artist = normalizeWhitespace(hints?.artist);

	if (!title) {
		return null;
	}

	const cacheKey = `${artist.toLowerCase()}|${title.toLowerCase()}`;
	if (MUSIC_LOOKUP_CACHE.has(cacheKey)) {
		return MUSIC_LOOKUP_CACHE.get(cacheKey);
	}

	const queryParts = [];
	if (title) {
		queryParts.push(`recording:\"${title.replace(/\"/g, "")}\"`);
	}
	if (artist) {
		queryParts.push(`artist:\"${artist.replace(/\"/g, "")}\"`);
	}

	if (!queryParts.length) {
		MUSIC_LOOKUP_CACHE.set(cacheKey, null);
		return null;
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), MUSICBRAINZ_TIMEOUT_MS);

	try {
		const query = queryParts.join(" AND ");
		const url = `https://musicbrainz.org/ws/2/recording/?fmt=json&limit=3&query=${encodeURIComponent(query)}`;
		const response = await fetch(url, {
			headers: {
				"User-Agent": MUSICBRAINZ_USER_AGENT,
				"Accept": "application/json",
			},
			signal: controller.signal,
		});

		let musicbrainzMeta = null;
		if (response.ok) {
			const json = await response.json();
			const best = pickBestRecording(json?.recordings);
			if (best) {
				const artistName = (best["artist-credit"] || [])
					.map((entry) => normalizeWhitespace(entry?.name || entry?.artist?.name || ""))
					.filter(Boolean)
					.join(", ");

				musicbrainzMeta = {
					title: normalizeWhitespace(best?.title || ""),
					artist: artistName,
					album: normalizeWhitespace(best?.releases?.[0]?.title || ""),
					releaseYear: toReleaseYear(best?.["first-release-date"] || best?.releases?.[0]?.date || ""),
					genres: dedupeStrings((best?.tags || []).map((tag) => tag?.name)).slice(0, 5),
				};
			}
		}

		const itunesMeta = await fetchItunesSongMetadata(hints);
		const merged = mergeMusicMetadata(musicbrainzMeta, itunesMeta);

		if (!merged.title && !merged.artist) {
			MUSIC_LOOKUP_CACHE.set(cacheKey, null);
			return null;
		}

		MUSIC_LOOKUP_CACHE.set(cacheKey, merged);
		return merged;
	} catch (error) {
		if (error?.name !== "AbortError") {
			logError("Music metadata lookup failed", error, `TITLE: ${title}`);
		}
		const fallback = await fetchItunesSongMetadata(hints);
		if (fallback) {
			MUSIC_LOOKUP_CACHE.set(cacheKey, fallback);
			return fallback;
		}
		MUSIC_LOOKUP_CACHE.set(cacheKey, null);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

function buildMediaKeyPoints(hints, webMeta, type) {
	const points = [];

	const title = normalizeWhitespace(webMeta?.title || hints?.title || "");
	const artist = normalizeWhitespace(webMeta?.artist || hints?.artist || "");
	const album = normalizeWhitespace(webMeta?.album || "");
	const releaseYear = normalizeWhitespace(webMeta?.releaseYear || hints?.year || "");
	const genres = dedupeStrings(Array.isArray(webMeta?.genres) ? webMeta.genres : []);

	if (title) {
		points.push(`${type === "video" ? "Title" : "Track"}: ${title}`);
	}
	if (artist) {
		points.push(`Artist: ${artist}`);
	}
	if (album) {
		points.push(`Album: ${album}`);
	}
	if (releaseYear) {
		points.push(`Released: ${releaseYear}`);
	}
	if (genres.length) {
		points.push(`Genres: ${genres.join(", ")}`);
	}

	return dedupeStrings(points);
}

function buildAudioMeaning(hints, webMeta) {
	const title = normalizeWhitespace(webMeta?.title || hints?.title || "");
	const artist = normalizeWhitespace(webMeta?.artist || hints?.artist || "");
	const album = normalizeWhitespace(webMeta?.album || "");
	const releaseYear = normalizeWhitespace(webMeta?.releaseYear || hints?.year || "");

	if (title && artist) {
		const albumPart = album ? ` from ${album}` : "";
		const yearPart = releaseYear ? ` (${releaseYear})` : "";
		return `Song \"${title}\" by ${artist}${albumPart}${yearPart}.`;
	}
	if (title) {
		return `Song \"${title}\" is included in this transfer.`;
	}

	return "Audio clip shared as part of a conversation or media drop.";
}

function buildVideoMeaning(hints, webMeta) {
	const title = normalizeWhitespace(webMeta?.title || hints?.title || "");
	const artist = normalizeWhitespace(webMeta?.artist || hints?.artist || "");

	if (title && artist) {
		return `Video associated with the song \"${title}\" by ${artist}.`;
	}
	if (title) {
		return `Video associated with \"${title}\".`;
	}

	return "Short video clip shared in this transfer.";
}

function getMeaningfulParagraphs(rawText, minLength = 80, maxParagraphs = 5) {
	const paragraphs = String(rawText || "")
		.replace(/\r/g, "\n")
		.split(/\n\s*\n/)
		.map((item) => normalizeWhitespace(item))
		.filter((item) => item.length >= minLength && /[a-zA-Z]/.test(item));

	if (paragraphs.length >= 2) {
		return paragraphs.slice(0, maxParagraphs);
	}

	const sentenceChunks = toSentences(rawText)
		.filter((item) => item.length > 30)
		.reduce((acc, sentence) => {
			const previous = acc[acc.length - 1] || "";
			if (!previous || previous.length > 220) {
				acc.push(sentence);
			} else {
				acc[acc.length - 1] = `${previous} ${sentence}`;
			}
			return acc;
		}, [])
		.filter((item) => item.length >= minLength);

	return sentenceChunks.slice(0, Math.max(2, maxParagraphs));
}

function detectLikelyHeadings(rawText) {
	const lines = String(rawText || "")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const headings = [];
	for (const line of lines.slice(0, 120)) {
		const isShortLine = line.length >= 4 && line.length <= 70;
		const isLikelyHeading = /^[A-Z][A-Za-z0-9\s:&/-]{3,}$/.test(line)
			|| /^[A-Z0-9\s:&/-]{4,}$/.test(line)
			|| /:$/.test(line);
		if (isShortLine && isLikelyHeading) {
			headings.push(line.replace(/:$/, ""));
		}
		if (headings.length >= 5) {
			break;
		}
	}

	return Array.from(new Set(headings));
}

function extractTopKeywords(value, limit = 6) {
	const words = normalizeWhitespace(value)
		.toLowerCase()
		.match(/\b[a-z][a-z0-9-]{2,}\b/g) || [];

	const counts = new Map();
	for (const word of words) {
		if (STOP_WORDS.has(word)) {
			continue;
		}
		counts.set(word, (counts.get(word) || 0) + 1);
	}

	return Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([word]) => word);
}

function inferDocumentMeaning(text, headings = []) {
	const normalized = normalizeWhitespace(text);
	const lower = normalized.toLowerCase();

	if (!normalized) {
		return "";
	}

	if (lower.includes("swiftshare")) {
		return "A document outlining the features and architecture of the SwiftShare platform.";
	}
	if (/\b(invoice|payment|billing|amount due)\b/.test(lower)) {
		return "A document focused on billing details and payment information.";
	}
	if (/\b(report|analysis|summary|findings|conclusion)\b/.test(lower)) {
		return "A document presenting findings, analysis, and conclusions on a topic.";
	}
	if (/\bguide|manual|instructions|steps\b/.test(lower)) {
		return "A document that explains a process through step-by-step guidance.";
	}

	const firstSentence = ensureSentence(normalized);
	if (firstSentence && firstSentence.length >= 30) {
		return clipText(firstSentence, 220);
	}

	const keywords = extractTopKeywords(`${headings.join(" ")} ${normalized}`, 4);
	if (keywords.length >= 2) {
		return `A document discussing ${keywords.join(", ")}.`;
	}

	return "";
}

async function extractPdfMeaning(buffer) {
	try {
		const parsed = await parsePdfBuffer(buffer);
		const rawText = String(parsed?.text || "");
		if (!normalizeWhitespace(rawText)) {
			return "";
		}

		const paragraphs = getMeaningfulParagraphs(rawText, 80, 5).slice(0, 5);
		const headings = detectLikelyHeadings(rawText).slice(0, 5);
		const paragraphText = paragraphs.join(" ");
		const inferred = inferDocumentMeaning(paragraphText || rawText, headings);

		if (inferred) {
			return inferred;
		}

		if (paragraphs.length >= 2) {
			return clipText(paragraphs.slice(0, 2).join(" "), 220);
		}

		return "";
	} catch (error) {
		logError("PDF extraction failed", error);
		return "";
	}
}

async function extractDocxMeaning(buffer) {
	try {
		const parsed = await mammoth.extractRawText({ buffer });
		const rawText = String(parsed?.value || "");
		const paragraphs = getMeaningfulParagraphs(rawText, 60, 5).slice(0, 5);
		return inferDocumentMeaning(paragraphs.join(" ") || rawText);
	} catch (error) {
		logError("DOCX extraction failed", error);
		return "";
	}
}

function extractTextMeaning(buffer) {
	const text = normalizeWhitespace(buffer?.toString("utf8") || "");
	if (!text) {
		return "";
	}

	const paragraphs = getMeaningfulParagraphs(text, 50, 5).slice(0, 5);
	const inferred = inferDocumentMeaning(paragraphs.join(" ") || text);
	if (inferred) {
		return inferred;
	}

	return ensureSentence(text);
}

function extractFunctionNames(codeText) {
	const patterns = [
		/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
		/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
		/def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
		/class\s+([A-Za-z_][A-Za-z0-9_]*)\b/g,
	];

	const names = new Set();
	for (const regex of patterns) {
		let match = regex.exec(codeText);
		while (match) {
			if (match[1]) {
				names.add(match[1]);
			}
			match = regex.exec(codeText);
		}
	}

	return Array.from(names).slice(0, 8);
}

function extractCommentSnippets(codeText) {
	const comments = [];
	const lines = String(codeText || "").split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
			comments.push(trimmed.replace(/^(\/\/|#)\s*/, ""));
		}
		if (comments.length >= 4) {
			break;
		}
	}

	const blockCommentMatches = String(codeText || "").match(/\/\*[\s\S]*?\*\//g) || [];
	for (const block of blockCommentMatches) {
		if (comments.length >= 4) {
			break;
		}
		const cleaned = normalizeWhitespace(block.replace(/^\/\*|\*\/$/g, "").replace(/\*/g, " "));
		if (cleaned.length > 8) {
			comments.push(cleaned);
		}
	}

	return comments;
}

function inferCodeAction(codeText, functionNames, commentSnippets) {
	const lowerCode = String(codeText || "").toLowerCase();
	const lowerComments = commentSnippets.join(" ").toLowerCase();
	const combined = `${lowerCode} ${lowerComments}`;

	const hasScan = /\b(scan|scans|scanner|list|walk|iterate)\b/.test(combined);
	const hasExport = /\b(export|save|write|output|csv|json|txt)\b/.test(combined);
	const hasMods = /\bmods?|minecraft|\.jar\b/.test(combined);
	const hasFetch = /\b(fetch|axios|request|http|api|client)\b/.test(combined);
	const hasReadWrite = /\b(read|write|fs\.|open\(|load|dump)\b/.test(combined);
	const hasSocket = /\b(socket|websocket|io\.|emit|on\()\b/.test(combined);
	const hasDb = /\b(sql|query|mongoose|mongodb|sequelize|insert|update|delete)\b/.test(combined);

	if (hasScan && hasExport && hasMods) {
		return "scans a mods folder and exports a list of installed Minecraft mods";
	}
	if (hasScan && hasExport) {
		return "scans folders and exports a structured list of discovered items";
	}
	if (hasFetch) {
		return "fetches data from APIs and transforms the response into usable output";
	}
	if (hasReadWrite) {
		return "reads source data and writes processed results";
	}
	if (hasSocket) {
		return "handles realtime socket communication and transfer events";
	}
	if (hasDb) {
		return "queries and updates database records for an application workflow";
	}
	if (functionNames.length) {
		return "organizes project logic into reusable functions";
	}

	return "implements project logic for an application workflow";
}

function extractCodeMeaning(buffer) {
	try {
		const codeText = String(buffer?.toString("utf8") || "").slice(0, 15000);
		const functionNames = extractFunctionNames(codeText);
		const commentSnippets = extractCommentSnippets(codeText);
		const action = inferCodeAction(codeText, functionNames, commentSnippets);

		if (functionNames.length) {
			const fnPreview = functionNames.slice(0, 3).join(", ");
			return `Script that ${action}, with core functions like ${fnPreview}.`;
		}

		return `Script that ${action}.`;
	} catch (error) {
		logError("Code extraction failed", error);
		return "";
	}
}

function summarizeZipMeaning(buffer) {
	try {
		const zip = new AdmZip(buffer);
		const entries = zip
			.getEntries()
			.filter((entry) => !entry.isDirectory);

		if (!entries.length) {
			return "Archive containing an empty folder structure.";
		}

		const typeCounts = new Map();
		for (const entry of entries) {
			const ext = path.extname(entry.entryName).toLowerCase() || "(no-ext)";
			typeCounts.set(ext, (typeCounts.get(ext) || 0) + 1);
		}

		const topTypes = Array.from(typeCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([ext, count]) => `${count} ${ext}`)
			.join(", ");

		const allNames = entries.map((entry) => entry.entryName.toLowerCase());
		const mediaCount = entries.filter((entry) => /\.(png|jpg|jpeg|gif|webp|mp4|mov|mp3|wav)$/i.test(entry.entryName)).length;
		const hasProjectSignals = allNames.some((name) => name.includes("package.json") || name.includes("src/") || name.includes("README".toLowerCase()));
		const hasBackupSignals = allNames.some((name) => name.includes("backup") || name.includes("archive") || name.includes("old"));

		let likelyPurpose = "a grouped file package";
		if (hasProjectSignals) {
			likelyPurpose = "a project source bundle";
		} else if (mediaCount >= Math.ceil(entries.length * 0.6)) {
			likelyPurpose = "a media or design asset pack";
		} else if (hasBackupSignals) {
			likelyPurpose = "a backup archive";
		}

		return `Archive containing ${entries.length} files (${topTypes}), likely ${likelyPurpose}.`;
	} catch (error) {
		logError("ZIP extraction failed", error);
		return "Archive shared for transfer.";
	}
}

async function extractImageMeaning(buffer, mimeType) {
	const prompt = "Explain what this image shows and what it represents in real-world context in ONE sentence.";

	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			const responseText = await generateAIResponse(prompt, buffer, mimeType || "image/png");
			const cleaned = ensureSentence(unwrapAiText(responseText));
			if (cleaned) {
				return cleaned;
			}
		} catch (error) {
			logError("Image vision analysis failed", error, `ATTEMPT: ${attempt}`);
		}
	}

	try {
		const openRouterApiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
		if (!openRouterApiKey) {
			return "";
		}

		const dataUrl = `data:${mimeType || "image/png"};base64,${Buffer.from(buffer).toString("base64")}`;
		const payload = {
			model: OPENROUTER_VISION_MODEL,
			temperature: 0.1,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: dataUrl } },
					],
				},
			],
		};

		const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${openRouterApiKey}`,
				"HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://swiftshare.local",
				"X-Title": process.env.OPENROUTER_APP_NAME || "SwiftShare Backend",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			return "";
		}

		const json = await response.json();
		const rawContent = extractChatContent(json?.choices?.[0]?.message?.content);
		return ensureSentence(unwrapAiText(rawContent));
	} catch (error) {
		logError("Image vision fallback failed", error);
	}

	return "";
}

function inferCategoryFromContext(context) {
	const types = context.map((item) => item.type);
	const codeCount = types.filter((type) => type === "code").length;
	const mediaCount = types.filter((type) => type === "image" || type === "video" || type === "audio").length;
	const docCount = types.filter((type) => type === "pdf" || type === "docx" || type === "text").length;

	if (codeCount > types.length / 2) {
		return "Codebase";
	}
	if (mediaCount > types.length / 2) {
		return "Media";
	}
	if (docCount > types.length / 2) {
		return "Documents";
	}
	if (types.length > 1) {
		return "Mixed";
	}
	return "Other";
}

function inferIntentFromContext(context) {
	const types = context.map((item) => item.type);
	if (types.includes("code")) {
		return "Development";
	}
	if (types.includes("pdf") || types.includes("docx") || types.includes("text")) {
		return "Documentation";
	}
	if (types.includes("image") || types.includes("video") || types.includes("audio")) {
		return "Media";
	}
	if (types.includes("zip")) {
		return "Archive";
	}
	return "File sharing";
}

function buildAnalysisPrompt(context) {
	const contextText = context
		.map((item) => {
			const details = Array.isArray(item?.key_points) && item.key_points.length
				? `\nKnown details:\n${item.key_points.map((point) => `- ${point}`).join("\n")}`
				: "";

			return `File: ${item.name}\nMeaning: ${item.meaning}${details}`;
		})
		.join("\n\n");

	return `${HUMAN_REVIEW_PROMPT}\n\n${contextText}\n\nReturn JSON only in this format:\n{\n  "overall_summary": "2 sentences explaining what this bundle actually is",\n  "files": [\n    { "name": "exact filename", "summary": "one sentence", "key_points": ["optional detail"] }\n  ]\n}`;
}

function buildRewritePrompt(context, previousOutput) {
	return `${buildAnalysisPrompt(context)}\n\n${REWRITE_PROMPT}\n\nPrevious output:\n${JSON.stringify(previousOutput, null, 2)}`;
}

function mapFilesToContext(context, aiFiles) {
	const remaining = Array.isArray(aiFiles) ? [...aiFiles] : [];

	return context.map((item, index) => {
		const matchIndex = remaining.findIndex((candidate) => {
			const candidateName = String(candidate?.name || "").toLowerCase();
			return candidateName === item.name.toLowerCase();
		});

		let picked;
		if (matchIndex >= 0) {
			picked = remaining.splice(matchIndex, 1)[0];
		} else {
			picked = remaining.shift() || aiFiles?.[index] || {};
		}

		return {
			name: item.name,
			summary: (() => {
				const aiSummary = ensureSentence(picked?.summary || "");
				const fallbackSummary = ensureSentence(item.meaning || "");

				if (item.type === "audio" || item.type === "video") {
					if (fallbackSummary) {
						return fallbackSummary;
					}
				}

				return aiSummary || fallbackSummary;
			})(),
			key_points: dedupeStrings([
				...(Array.isArray(item?.key_points) ? item.key_points : []),
				...(Array.isArray(picked?.key_points) ? picked.key_points : []),
			]),
		};
	});
}

function normalizeAiOutput(output, context) {
	const overallSummary = normalizeWhitespace(String(output?.overall_summary || output?.summary || ""));
	const files = mapFilesToContext(context, output?.files);

	return {
		overall_summary: overallSummary,
		files,
	};
}

function hasHeavyRepetition(value) {
	const words = String(value || "").toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
	const counts = new Map();
	for (const word of words) {
		if (STOP_WORDS.has(word)) {
			continue;
		}
		counts.set(word, (counts.get(word) || 0) + 1);
	}

	for (const count of counts.values()) {
		if (count >= 4) {
			return true;
		}
	}

	return false;
}

function validateHumanQuality(output, context) {
	const issues = [];
	const overall = String(output?.overall_summary || "");
	const overallSentenceCount = toSentences(overall).length;

	if (!overall) {
		issues.push("Missing overall summary");
	} else {
		if (overallSentenceCount < 1 || overallSentenceCount > 3) {
			issues.push("Overall summary must be 1–3 sentences");
		}
		if (containsGenericPhrase(overall)) {
			issues.push("Overall summary contains generic phrasing");
		}
		if (hasHeavyRepetition(overall)) {
			issues.push("Overall summary has heavy repetition");
		}
	}

	if (!Array.isArray(output?.files) || output.files.length !== context.length) {
		issues.push("File summaries count does not match context");
	} else {
		for (const file of output.files) {
			const summary = String(file?.summary || "").trim();
			if (!summary) {
				issues.push(`Missing summary for ${file?.name || "file"}`);
				continue;
			}
			if (toSentences(summary).length < 1 || toSentences(summary).length > 2) {
				issues.push(`File summary must be 1–2 sentences for ${file.name}`);
			}
			if (/^this\b/i.test(summary)) {
				issues.push(`File summary is too generic for ${file.name}`);
			}
			if (/^image\b/i.test(summary)) {
				issues.push(`File summary is too generic for ${file.name}`);
			}
			if (METADATA_STYLE_RE.test(summary)) {
				issues.push(`Metadata-heavy wording detected for ${file.name}`);
			}
			if (containsGenericPhrase(summary)) {
				issues.push(`Generic phrasing detected for ${file.name}`);
			}
			if (hasHeavyRepetition(summary)) {
				issues.push(`Repetition detected for ${file.name}`);
			}
		}
	}

	return {
		ok: issues.length === 0,
		issues,
	};
}

function isCodeFile(ext) {
	return CODE_EXTENSIONS.has(ext);
}

async function buildAIContext(files) {
	const context = [];

	for (const file of files || []) {
		const name = getFileName(file);
		const ext = getFileExt(name);
		const mime = String(file?.mimetype || "").toLowerCase();
		const buffer = file?.buffer;

		let meaning = "";
		let type = "file";
		let keyPoints = [];

		if (!buffer || !Buffer.isBuffer(buffer)) {
			context.push({ name, meaning: "Shared file with limited readable content.", type, key_points: [] });
			continue;
		}

		if (ext === ".pdf" || mime.includes("pdf")) {
			type = "pdf";
			meaning = await extractPdfMeaning(buffer);
			if (!meaning) {
				meaning = "Document shared for review.";
			}
		} else if (mime.startsWith("image/")) {
			type = "image";
			meaning = await extractImageMeaning(buffer, mime);
			if (!meaning) {
				meaning = "Image shared for visual context.";
			}
		} else if (isCodeFile(ext)) {
			type = "code";
			meaning = extractCodeMeaning(buffer);
			if (!meaning) {
				meaning = "Script that handles project logic.";
			}
		} else if (ext === ".zip" || mime.includes("zip")) {
			type = "zip";
			meaning = summarizeZipMeaning(buffer);
		} else if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) {
			type = "video";
			const hints = parseMediaNameHints(name);
			const webMeta = await fetchMusicMetadataFromWeb(hints);
			meaning = buildVideoMeaning(hints, webMeta);
			keyPoints = buildMediaKeyPoints(hints, webMeta, "video");
		} else if (mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) {
			type = "audio";
			const hints = parseMediaNameHints(name);
			const webMeta = await fetchMusicMetadataFromWeb(hints);
			meaning = buildAudioMeaning(hints, webMeta);
			keyPoints = buildMediaKeyPoints(hints, webMeta, "audio");
		} else if (ext === ".docx" || mime.includes("wordprocessingml")) {
			type = "docx";
			meaning = await extractDocxMeaning(buffer);
			if (!meaning) {
				meaning = "Document shared for review.";
			}
		} else if (ext === ".txt" || ext === ".md" || mime.startsWith("text/")) {
			type = "text";
			meaning = extractTextMeaning(buffer);
			if (!meaning) {
				meaning = "Text note shared in the transfer.";
			}
		} else {
			type = "file";
			meaning = "Shared file with limited readable content.";
		}

		context.push({
			name,
			meaning: clipText(meaning, 560),
			type,
			key_points: keyPoints,
		});
	}

	return context;
}

async function runAnalysisWithValidation(context, transferCode, forceFallback) {
	let output = await analyzeWithFallback(buildAnalysisPrompt(context), transferCode, forceFallback);
	let normalized = normalizeAiOutput(output, context);
	let quality = validateHumanQuality(normalized, context);
	let retries = 0;

	while (!quality.ok && retries < 2) {
		retries += 1;
		output = await analyzeWithFallback(buildRewritePrompt(context, normalized), transferCode, true);
		normalized = normalizeAiOutput(output, context);
		quality = validateHumanQuality(normalized, context);
	}

	if (!quality.ok) {
		logEvent("AI output quality suboptimal, using best available", quality.issues.join("; "));
	}

	return normalized;
}

async function analyzeTransfer(files, transferCode, forceFallback = false) {
	try {
		if (!Array.isArray(files) || files.length === 0) {
			return {
				success: false,
				warning: "AI analysis unavailable",
			};
		}

		logEvent("AI analysis started", `CODE: ${transferCode}`, `FILES: ${files.length}`);

		const context = await buildAIContext(files);
		console.log("AI CONTEXT:", context);

		if (!context.length) {
			throw new Error("No file context could be built for analysis");
		}

		const normalized = await runAnalysisWithValidation(context, transferCode, forceFallback);
		const overallSummary = normalized.overall_summary;
		const category = inferCategoryFromContext(context);
		const detectedIntent = inferIntentFromContext(context);

		const result = {
			success: true,
			overall_summary: overallSummary,
			summary: overallSummary,
			files: normalized.files,
			category,
			detected_intent: detectedIntent,
			detectedIntent,
		};

		console.log("AI OUTPUT:", result);
		logEvent("AI analysis completed", `CODE: ${transferCode}`, `FILES: ${normalized.files.length}`);
		return result;
	} catch (error) {
		logError("AI analysis failed", error, `CODE: ${transferCode}`);
		return {
			success: false,
			warning: "AI analysis unavailable",
		};
	}
}

async function analyzeFile(buffer, filename, mimeType) {
	return analyzeTransfer([
		{
			buffer,
			originalname: filename,
			mimetype: mimeType,
			size: buffer?.length || 0,
		},
	], "SINGLE_FILE", false);
}

module.exports = {
	analyzeFile,
	analyzeTransfer,
	buildAIContext,
};
