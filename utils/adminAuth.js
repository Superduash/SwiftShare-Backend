'use strict';

const crypto = require('crypto');
const AdminSession = require('../models/AdminSession');
const { logEvent, logError } = require('./logger');

function isAdminEnabled() {
	return String(process.env.ADMIN_ENABLED || '').toLowerCase() === 'true';
}

function getAdminJwtSecret() {
	const secret = process.env.ADMIN_JWT_SECRET;
	if (!secret || secret.length !== 64) {
		return null;
	}
	return Buffer.from(secret, 'hex');
}

/**
 * Sign an admin JWT using HMAC-SHA256 (zero external dependencies)
 */
function signAdminToken(payload) {
	const secretBuffer = getAdminJwtSecret();
	if (!secretBuffer) {
		throw new Error('ADMIN_JWT_SECRET is not configured properly');
	}

	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = crypto
		.createHmac('sha256', secretBuffer)
		.update(payloadB64)
		.digest('base64url');

	return `${payloadB64}.${signature}`;
}

/**
 * Verify and decode an admin token with constant-time signature comparison
 */
function verifyAdminToken(token) {
	try {
		if (!token || typeof token !== 'string' || token.length < 20) {
			return null;
		}

		const dotIndex = token.indexOf('.');
		if (dotIndex === -1) return null;

		const payloadB64 = token.substring(0, dotIndex);
		const signature = token.substring(dotIndex + 1);

		const secretBuffer = getAdminJwtSecret();
		if (!secretBuffer) return null;

		const expectedSignature = crypto
			.createHmac('sha256', secretBuffer)
			.update(payloadB64)
			.digest('base64url');

		if (signature.length !== expectedSignature.length) return null;

		if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
			return null;
		}

		const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
		const payload = JSON.parse(payloadStr);

		const nowSec = Math.floor(Date.now() / 1000);
		if (!payload.exp || payload.exp < nowSec) {
			return null;
		}

		if (payload.sub !== 'admin' || !payload.jti) {
			return null;
		}

		return payload;
	} catch (error) {
		return null;
	}
}

/**
 * Mask IP address for privacy compliance
 * IPv4: 192.168.1.100 -> 192.168.x.x
 * IPv6: 2001:0db8:85a3::8a2e -> 2001:db8::x
 */
function maskIp(ip) {
	if (!ip || typeof ip !== 'string') return '';
	const clean = ip.replace(/^::ffff:/, '').trim();

	// IPv4
	if (clean.includes('.')) {
		const parts = clean.split('.');
		if (parts.length === 4) {
			return `${parts[0]}.${parts[1]}.x.x`;
		}
	}

	// IPv6
	if (clean.includes(':')) {
		const parts = clean.split(':');
		if (parts.length >= 2) {
			return `${parts[0]}:${parts[1]}::x`;
		}
	}

	return 'x.x.x.x';
}

/**
 * Fast in-repo User-Agent parser (Device, OS, Browser, Bots)
 */
function parseUserAgent(uaString = '') {
	const ua = String(uaString || '').trim();
	if (!ua) {
		return {
			device: 'unknown',
			browser: 'Unknown',
			os: 'Unknown',
			isBot: false,
			botName: '',
		};
	}

	const lower = ua.toLowerCase();

	// Bot Detection
	const bots = [
		{ name: 'Googlebot', match: /googlebot/i },
		{ name: 'Bingbot', match: /bingbot/i },
		{ name: 'DuckDuckBot', match: /duckduckbot/i },
		{ name: 'Baiduspider', match: /baiduspider/i },
		{ name: 'YandexBot', match: /yandexbot/i },
		{ name: 'Sogou', match: /sogou/i },
		{ name: 'Exabot', match: /exabot/i },
		{ name: 'facebookexternalhit', match: /facebookexternalhit/i },
		{ name: 'Twitterbot', match: /twitterbot/i },
		{ name: 'TelegramBot', match: /telegrambot/i },
		{ name: 'WhatsApp', match: /whatsapp/i },
		{ name: 'AhrefsBot', match: /ahrefsbot/i },
		{ name: 'SemrushBot', match: /semrushbot/i },
		{ name: 'UptimeRobot', match: /uptimerobot/i },
		{ name: 'HeadlessChrome', match: /headlesschrome/i },
		{ name: 'Python-Requests', match: /python-requests/i },
		{ name: 'Curl', match: /^curl\//i },
		{ name: 'Wget', match: /^wget\//i },
	];

	for (const bot of bots) {
		if (bot.match.test(ua)) {
			return {
				device: 'desktop',
				browser: 'Bot',
				os: 'Bot',
				isBot: true,
				botName: bot.name,
			};
		}
	}

	if (/(bot|crawler|spider|scraper|archiver|headless)/i.test(lower)) {
		return {
			device: 'desktop',
			browser: 'Bot',
			os: 'Bot',
			isBot: true,
			botName: 'Generic Bot',
		};
	}

	// Device
	let device = 'desktop';
	if (/(ipad|tablet|(android(?!.*mobile))|(windows(?!.*phone)(.*touch))|kindle|playbook|silk)/i.test(lower)) {
		device = 'tablet';
	} else if (/(mobi|ipod|phone|iphone|blackberry|opera mini|iemobile|fennec|hiptop|avantgo|plucker|xiino|blazer|elaine)/i.test(lower)) {
		device = 'mobile';
	}

	// OS
	let os = 'Unknown';
	if (/windows nt 10/i.test(lower)) os = 'Windows 10/11';
	else if (/windows nt/i.test(lower)) os = 'Windows';
	else if (/android/i.test(lower)) os = 'Android';
	else if (/(iphone|ipad|ipod)/i.test(lower)) os = 'iOS';
	else if (/mac os x|macintosh/i.test(lower)) os = 'macOS';
	else if (/linux/i.test(lower)) os = 'Linux';
	else if (/cros/i.test(lower)) os = 'Chrome OS';

	// Browser
	let browser = 'Unknown';
	if (/edg\//i.test(lower)) browser = 'Edge';
	else if (/opr\/|opera/i.test(lower)) browser = 'Opera';
	else if (/samsungbrowser/i.test(lower)) browser = 'Samsung Internet';
	else if (/chrome|crios/i.test(lower)) browser = 'Chrome';
	else if (/firefox|fxios/i.test(lower)) browser = 'Firefox';
	else if (/safari/i.test(lower) && !/chrome|crios/i.test(lower)) browser = 'Safari';

	return {
		device,
		browser,
		os,
		isBot: false,
		botName: '',
	};
}

/**
 * requireAdmin Express Middleware
 */
async function requireAdmin(req, res, next) {
	// If admin panel is not enabled, return 404 to avoid disclosing endpoint existence
	if (!isAdminEnabled()) {
		return res.status(404).json({
			error: { code: 'NOT_FOUND', message: 'Route not found' },
		});
	}

	// Set privacy and caching headers on all admin responses
	res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
	res.setHeader('Pragma', 'no-cache');
	res.setHeader('Expires', '0');
	res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

	const authHeader = req.get('Authorization') || '';
	if (!authHeader.startsWith('Bearer ')) {
		return res.status(401).json({ error: 'Unauthorized: Admin authentication required' });
	}

	const token = authHeader.substring(7).trim();
	const payload = verifyAdminToken(token);

	if (!payload) {
		return res.status(401).json({ error: 'Unauthorized: Invalid or expired session token' });
	}

	// Verify session exists in database (supports revocation / logout-all)
	try {
		const session = await AdminSession.findOne({ jti: payload.jti }).lean();
		if (!session) {
			return res.status(401).json({ error: 'Unauthorized: Session revoked' });
		}

		req.admin = {
			username: payload.username,
			jti: payload.jti,
			exp: payload.exp,
		};
		next();
	} catch (error) {
		logError('Admin session verification error', error);
		return res.status(500).json({ error: 'Authentication service temporarily unavailable' });
	}
}

module.exports = {
	isAdminEnabled,
	signAdminToken,
	verifyAdminToken,
	maskIp,
	parseUserAgent,
	requireAdmin,
};
