#!/usr/bin/env node

const http = require("http");

const MAX_RETRIES = 30; // 30 seconds max wait (1s per retry)
const RETRY_INTERVAL = 1000; // 1 second between retries
const HEALTH_URL = "http://localhost:3001/api/health";

let attempts = 0;

function checkHealth() {
	attempts++;
	
	http.get(HEALTH_URL, (res) => {
		if (res.statusCode === 200) {
			console.log(`[✓] Backend is ready (${attempts}s)`);
			process.exit(0);
		} else {
			retry();
		}
	}).on("error", () => {
		retry();
	});
}

function retry() {
	if (attempts >= MAX_RETRIES) {
		console.error(`[✗] Backend failed to start within ${MAX_RETRIES}s`);
		process.exit(1);
	}
	setTimeout(checkHealth, RETRY_INTERVAL);
}

checkHealth();
