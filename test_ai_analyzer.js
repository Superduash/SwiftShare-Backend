const fs = require("fs");
const path = require("path");
const { analyzeTransfer } = require("./services/aiAnalyzer");

async function testAnalyzer() {
	console.log("🔥 Testing AI Analyzer with real files...\n");
	
	const testDir = "C:\\Users\\Superduash\\Downloads\\SwiftShare\\Testupload";
	const testFiles = [
		"modlist.py",
		"hk.png",
		"SwiftShare Content.pdf",
		"WhatsApp Video 2025-03-30 at 9.43.55 PM.mp4"
	];
	
	const files = [];
	for (const filename of testFiles) {
		const filepath = path.join(testDir, filename);
		if (fs.existsSync(filepath)) {
			const buffer = fs.readFileSync(filepath);
			files.push({
				buffer,
				originalname: filename,
				mimetype: getMimeType(filename),
				size: buffer.length
			});
			console.log(`✅ Loaded: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);
		} else {
			console.log(`❌ Not found: ${filename}`);
		}
	}
	
	if (files.length === 0) {
		console.log("\n❌ No files found to test!");
		return;
	}
	
	console.log(`\n🤖 Analyzing ${files.length} files...\n`);
	
	try {
		const result = await analyzeTransfer(files, "TEST123", false);
		
		console.log("═══════════════════════════════════════════════════════");
		console.log("📊 AI ANALYSIS RESULT");
		console.log("═══════════════════════════════════════════════════════\n");
		
		console.log("📝 OVERALL SUMMARY:");
		console.log(result.overall_summary || result.summary);
		console.log("");
		
		console.log("📁 SUGGESTED FILENAME:");
		console.log(result.suggested_filename);
		console.log("");
		
		console.log("🏷️  CATEGORY:");
		console.log(result.category);
		console.log("");
		
		console.log("🎯 DETECTED INTENT:");
		console.log(result.detected_intent);
		console.log("");
		
		console.log("📄 FILE SUMMARIES:");
		if (Array.isArray(result.files)) {
			result.files.forEach((file, i) => {
				console.log(`${i + 1}. ${file.name}`);
				console.log(`   ${file.summary}`);
				console.log("");
			});
		}
		
		console.log("═══════════════════════════════════════════════════════");
		console.log("✅ TEST COMPLETE");
		console.log("═══════════════════════════════════════════════════════");
		
		// Check for banned phrases
		const fullText = JSON.stringify(result).toLowerCase();
		const bannedFound = [];
		const banned = [
			"this file contains", "purpose inferred", "file type", "metadata",
			"bundle contains", "application logic", "focused on"
		];
		
		for (const phrase of banned) {
			if (fullText.includes(phrase)) {
				bannedFound.push(phrase);
			}
		}
		
		if (bannedFound.length > 0) {
			console.log("\n⚠️  WARNING: Found banned phrases:");
			bannedFound.forEach(p => console.log(`   - "${p}"`));
		} else {
			console.log("\n✅ No banned phrases detected - output is clean!");
		}
		
	} catch (error) {
		console.error("\n❌ ERROR:", error.message);
		console.error(error.stack);
	}
}

function getMimeType(filename) {
	const ext = path.extname(filename).toLowerCase();
	const mimeMap = {
		".py": "text/x-python",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".pdf": "application/pdf",
		".mp4": "video/mp4",
		".txt": "text/plain",
		".zip": "application/zip"
	};
	return mimeMap[ext] || "application/octet-stream";
}

// Run test
testAnalyzer().catch(console.error);
