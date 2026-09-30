'use strict';

const express = require('express');
const crypto = require('crypto');
const PageView = require('../models/PageView');
const { rateLimitPageView } = require('../middleware/rateLimiter');
const { getClientIp } = require('../utils/helpers');
const { parseUserAgent } = require('../utils/adminAuth');
const { emitToAdminNamespace } = require('../config/socket');
const { logError } = require('../utils/logger');

const router = express.Router();

// Allow raw text or json for sendBeacon
router.use(express.text({ type: ['text/plain', 'application/json'], limit: '2kb' }));

// Known route pattern whitelist
const ALLOWED_ROUTE_PATTERNS = [
	'/',
	'/join',
	'/g/:code',
	'/download/:code',
	'/sender/:code',
	'/expired',
	'/how-it-works',
	'/terms',
	'/privacy',
	'/about',
	'/faq',
	'/security',
	'/send-files-without-signup',
	'/share-files-with-qr-code',
	'/self-destructing-file-sharing',
	'/password-protected-file-transfer',
	'/share-text-and-code-snippets',
	'/airdrop-alternative',
	'/report-abuse',
];

// Session deduplication cache (sid + route within 30s)
const pvDedupMap = new Map();
const PV_DEDUP_WINDOW_MS = 30 * 1000;

setInterval(() => {
	const now = Date.now();
	for (const [key, timestamp] of pvDedupMap) {
		if (now - timestamp > PV_DEDUP_WINDOW_MS) {
			pvDedupMap.delete(key);
		}
	}
}, 60 * 1000).unref();

function normalizeRoutePattern(rawRoute) {
	if (!rawRoute || typeof rawRoute !== 'string') return '';
	const clean = rawRoute.split('?')[0].split('#')[0].trim();
	if (!clean || clean === '/') return '/';

	// Map transfer code routes to normalized parameterized forms
	if (/^\/g\/[A-Za-z0-9_-]+/i.test(clean)) return '/g/:code';
	if (/^\/download\/[A-Za-z0-9_-]+/i.test(clean)) return '/download/:code';
	if (/^\/sender\/[A-Za-z0-9_-]+/i.test(clean)) return '/sender/:code';

	const normalized = clean.replace(/\/+$/, '').toLowerCase();
	return ALLOWED_ROUTE_PATTERNS.includes(normalized) ? normalized : '';
}

function extractRefHostname(refUrl, currentHost) {
	if (!refUrl || typeof refUrl !== 'string') return '';
	try {
		const parsed = new URL(refUrl);
		const host = parsed.hostname.toLowerCase();
		if (currentHost && (host === currentHost || host.endsWith(`.${currentHost}`))) {
			return '';
		}
		return host.slice(0, 128);
	} catch {
		return '';
	}
}

function computeDailyHash(salt, ip, ua) {
	if (!salt) return '';
	const today = new Date().toISOString().slice(0, 10);
	return crypto
		.createHash('sha256')
		.update(`${salt}:${today}:${ip}:${ua}`)
		.digest('hex')
		.slice(0, 16);
}

// Throttle live admin visit emits (batch max 1 per second)
let pendingVisits = [];
let visitEmitTimer = null;

function queueVisitEmit(visitData) {
	pendingVisits.push(visitData);
	if (!visitEmitTimer) {
		visitEmitTimer = setTimeout(() => {
			if (pendingVisits.length > 0) {
				const batch = [...pendingVisits];
				pendingVisits = [];
				try {
					emitToAdminNamespace('visits-batch', { count: batch.length, latest: batch[batch.length - 1] });
				} catch (err) {}
			}
			visitEmitTimer = null;
		}, 1000);
		visitEmitTimer.unref?.();
	}
}

/**
 * POST /api/analytics/pv — Privacy-preserving PageView collection
 */
router.post('/pv', rateLimitPageView, async (req, res) => {
	// Always return 204 fast to keep client beacon/fetch unblocked
	res.status(204).end();

	try {
		let body = req.body;
		if (typeof body === 'string') {
			try {
				body = JSON.parse(body);
			} catch {
				return;
			}
		}

		if (!body || typeof body !== 'object') return;

		const normalizedRoute = normalizeRoutePattern(body.route);
		if (!normalizedRoute) return; // Drop unknown routes

		const sid = String(body.sid || '').slice(0, 64).trim();
		const dedupKey = `${sid}:${normalizedRoute}`;
		const now = Date.now();

		if (sid && pvDedupMap.has(dedupKey) && now - pvDedupMap.get(dedupKey) < PV_DEDUP_WINDOW_MS) {
			return; // Deduplicate repeat beacons within 30s
		}
		if (sid) pvDedupMap.set(dedupKey, now);

		const ip = getClientIp(req) || '';
		const uaString = req.get('user-agent') || '';
		const { device, browser, os, isBot, botName } = parseUserAgent(uaString);

		const refHost = extractRefHostname(body.ref, req.get('host'));
		const country = typeof body.country === 'string' && /^[A-Za-z]{2}$/.test(body.country.trim())
			? body.country.trim().toUpperCase()
			: '';

		const vid = typeof body.vid === 'string' && /^[0-9a-fA-F-]{36}$/.test(body.vid.trim())
			? body.vid.trim().toLowerCase()
			: '';

		const salt = process.env.ANALYTICS_HASH_SALT || '';
		const dayHash = computeDailyHash(salt, ip, uaString);

		const utmSource = String(body.utm_source || body.utm?.source || '').slice(0, 64).trim();
		const utmMedium = String(body.utm_medium || body.utm?.medium || '').slice(0, 64).trim();
		const utmCampaign = String(body.utm_campaign || body.utm?.campaign || '').slice(0, 64).trim();

		const doc = {
			ts: new Date(),
			route: normalizedRoute,
			refHost,
			utm: {
				source: utmSource,
				medium: utmMedium,
				campaign: utmCampaign,
			},
			device,
			browser,
			os,
			country,
			vid,
			dayHash,
			sid,
			isBot,
			botName,
		};

		// Fire-and-forget write to Mongo
		PageView.create(doc).catch((err) => {
			logError('Failed to record pageview', err);
		});

		// Queue live notification to admin socket
		if (!isBot) {
			queueVisitEmit({
				route: normalizedRoute,
				device,
				browser,
				country,
				refHost,
				timestamp: doc.ts,
			});
		}
	} catch (err) {
		logError('Analytics ingest error', err);
	}
});

module.exports = router;
