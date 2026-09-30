'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const AdminSession = require('../models/AdminSession');
const AdminAudit = require('../models/AdminAudit');
const { version: pkgVersion } = require('../package.json');
const Transfer = require('../models/Transfer');
const {
	isAdminEnabled,
	signAdminToken,
	requireAdmin,
	maskIp,
} = require('../utils/adminAuth');
const {
	rateLimitAdminLogin,
	recordAdminLoginFailure,
	clearAdminLoginFailures,
} = require('../middleware/rateLimiter');
const {
	getOverviewStats,
	getTimeseries,
	getTrafficPages,
	getTrafficSources,
	getTrafficCountries,
	getTrafficDevices,
	getTrafficHours,
	getTrafficCrawlers,
	getFunnel,
	getBreakdowns,
	listTransfers,
	getTransferDetails,
} = require('../services/adminAnalytics');
const { deleteFilesFromR2 } = require('../services/fileManager');
const { emitToRoom, clearTransferCountdown, getSocketConnectedCount, emitToAdminNamespace } = require('../config/socket');
const { getClientIp, getDeviceName } = require('../utils/helpers');
const { getMongoStatus } = require('../config/db');
const { isR2Configured } = require('../config/r2');
const { logEvent, logError } = require('../utils/logger');
const { getPerformanceSnapshot } = require('../utils/performance');
const PageView = require('../models/PageView');

const router = express.Router();

// Pre-computed dummy bcrypt hash to ensure constant-time response on wrong username
const DUMMY_BCRYPT_HASH = '$2b$12$eS/whaMJcypEep5pHS7lUeU5Xnql8QsJUGqMGocyFvtWMO5d6hWai';

function timingSafeStringEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const aHash = crypto.createHash('sha256').update(a).digest();
	const bHash = crypto.createHash('sha256').update(b).digest();
	return crypto.timingSafeEqual(aHash, bHash);
}

// ── Auth Endpoints ─────────────────────────────────────────────

/**
 * POST /api/admin/login
 */
router.post('/login', rateLimitAdminLogin, async (req, res) => {
	if (!isAdminEnabled()) {
		return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
	}

	res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
	res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

	const { username, password } = req.body || {};
	const ip = getClientIp(req) || 'unknown';
	const ipMasked = maskIp(ip);
	const ua = getDeviceName(req.get('user-agent') || '');

	if (!username || !password || typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 128) {
		recordAdminLoginFailure(ip);
		await AdminAudit.create({
			action: 'login_failed',
			username: String(username || '').slice(0, 32),
			ipMasked,
			ua,
			details: { reason: 'invalid_format' },
		}).catch(() => {});

		emitToAdminNamespace('admin-login-failed', { ipMasked, timestamp: new Date() });
		return res.status(401).json({ error: 'Invalid credentials' });
	}

	const configuredUsername = process.env.ADMIN_USERNAME || '';
	const configuredHash = process.env.ADMIN_PASSWORD_HASH || DUMMY_BCRYPT_HASH;

	const isUserValid = timingSafeStringEqual(username.trim(), configuredUsername.trim());
	// ALWAYS execute bcrypt compare even if username is invalid to prevent timing attacks
	const isPassValid = await bcrypt.compare(password, isUserValid ? configuredHash : DUMMY_BCRYPT_HASH);

	if (!isUserValid || !isPassValid) {
		const retryAfter = recordAdminLoginFailure(ip);
		await AdminAudit.create({
			action: 'login_failed',
			username: username.slice(0, 32),
			ipMasked,
			ua,
			details: { reason: 'credential_mismatch' },
		}).catch(() => {});

		emitToAdminNamespace('admin-login-failed', { ipMasked, timestamp: new Date() });

		if (retryAfter) {
			res.setHeader('Retry-After', String(retryAfter));
			return res.status(429).json({
				error: 'Too many failed login attempts. Account temporarily locked.',
				retryAfter,
			});
		}

		return res.status(401).json({ error: 'Invalid credentials' });
	}

	// Login Successful: Clear failure tracker
	clearAdminLoginFailures(ip);

	const ttlMinutes = parseInt(process.env.ADMIN_SESSION_TTL_MINUTES, 10) || 120;
	const nowMs = Date.now();
	const expSec = Math.floor((nowMs + ttlMinutes * 60 * 1000) / 1000);
	const jti = crypto.randomUUID();

	const token = signAdminToken({
		sub: 'admin',
		username: configuredUsername,
		jti,
		iat: Math.floor(nowMs / 1000),
		exp: expSec,
	});

	// Save session in DB
	await AdminSession.create({
		jti,
		username: configuredUsername,
		ipMasked,
		ua,
		createdAt: new Date(nowMs),
		expiresAt: new Date(expSec * 1000),
	});

	await AdminAudit.create({
		action: 'login_success',
		username: configuredUsername,
		ipMasked,
		ua,
	}).catch(() => {});

	logEvent('Admin login success', `USER: ${configuredUsername}`, `IP: ${ipMasked}`);

	return res.status(200).json({
		success: true,
		token,
		username: configuredUsername,
		expiresAt: new Date(expSec * 1000).toISOString(),
	});
});

/**
 * GET /api/admin/session
 */
router.get('/session', requireAdmin, (req, res) => {
	res.status(200).json({
		ok: true,
		username: req.admin.username,
		expiresAt: new Date(req.admin.exp * 1000).toISOString(),
	});
});

/**
 * POST /api/admin/logout
 */
router.post('/logout', requireAdmin, async (req, res) => {
	try {
		await AdminSession.deleteOne({ jti: req.admin.jti });
		await AdminAudit.create({
			action: 'logout',
			username: req.admin.username,
			ipMasked: maskIp(getClientIp(req)),
			ua: getDeviceName(req.get('user-agent') || ''),
		}).catch(() => {});

		return res.status(200).json({ success: true });
	} catch (error) {
		logError('Admin logout error', error);
		return res.status(500).json({ error: 'Failed to logout session' });
	}
});

/**
 * POST /api/admin/logout-all
 */
router.post('/logout-all', requireAdmin, async (req, res) => {
	try {
		await AdminSession.deleteMany({});
		await AdminAudit.create({
			action: 'logout_all',
			username: req.admin.username,
			ipMasked: maskIp(getClientIp(req)),
			ua: getDeviceName(req.get('user-agent') || ''),
		}).catch(() => {});

		return res.status(200).json({ success: true, message: 'All admin sessions terminated' });
	} catch (error) {
		logError('Admin logout-all error', error);
		return res.status(500).json({ error: 'Failed to terminate all sessions' });
	}
});

// ── Analytics & KPI Endpoints (All requireAdmin) ────────────────

router.get('/overview', requireAdmin, async (req, res) => {
	try {
		const stats = await getOverviewStats(req.query.range || '7d');
		res.status(200).json(stats);
	} catch (error) {
		logError('Admin overview error', error);
		res.status(500).json({ error: 'Failed to compute overview stats' });
	}
});

router.get('/timeseries', requireAdmin, async (req, res) => {
	try {
		const metric = req.query.metric || 'pageviews';
		const range = req.query.range || '7d';
		const series = await getTimeseries(metric, range);
		res.status(200).json(series);
	} catch (error) {
		logError('Admin timeseries error', error);
		res.status(500).json({ error: 'Failed to compute timeseries data' });
	}
});

router.get('/traffic/pages', requireAdmin, async (req, res) => {
	try {
		const pages = await getTrafficPages(req.query.range || '7d');
		res.status(200).json(pages);
	} catch (error) {
		logError('Admin traffic pages error', error);
		res.status(500).json({ error: 'Failed to compute top pages' });
	}
});

router.get('/traffic/sources', requireAdmin, async (req, res) => {
	try {
		const sources = await getTrafficSources(req.query.range || '7d');
		res.status(200).json(sources);
	} catch (error) {
		logError('Admin traffic sources error', error);
		res.status(500).json({ error: 'Failed to compute traffic sources' });
	}
});

router.get('/traffic/countries', requireAdmin, async (req, res) => {
	try {
		const countries = await getTrafficCountries(req.query.range || '7d');
		res.status(200).json(countries);
	} catch (error) {
		logError('Admin traffic countries error', error);
		res.status(500).json({ error: 'Failed to compute country metrics' });
	}
});

router.get('/traffic/devices', requireAdmin, async (req, res) => {
	try {
		const devices = await getTrafficDevices(req.query.range || '7d');
		res.status(200).json(devices);
	} catch (error) {
		logError('Admin traffic devices error', error);
		res.status(500).json({ error: 'Failed to compute device metrics' });
	}
});

router.get('/traffic/hours', requireAdmin, async (req, res) => {
	try {
		const grid = await getTrafficHours(req.query.range || '7d');
		res.status(200).json({ grid });
	} catch (error) {
		logError('Admin traffic hours error', error);
		res.status(500).json({ error: 'Failed to compute heatmap' });
	}
});

router.get('/traffic/crawlers', requireAdmin, async (req, res) => {
	try {
		const crawlers = await getTrafficCrawlers(req.query.range || '7d');
		res.status(200).json(crawlers);
	} catch (error) {
		logError('Admin traffic crawlers error', error);
		res.status(500).json({ error: 'Failed to compute crawler stats' });
	}
});

router.get('/funnel', requireAdmin, async (req, res) => {
	try {
		const funnel = await getFunnel(req.query.range || '7d');
		res.status(200).json(funnel);
	} catch (error) {
		logError('Admin funnel error', error);
		res.status(500).json({ error: 'Failed to compute conversion funnel' });
	}
});

router.get('/breakdowns', requireAdmin, async (req, res) => {
	try {
		const breakdowns = await getBreakdowns(req.query.range || '7d');
		res.status(200).json(breakdowns);
	} catch (error) {
		logError('Admin breakdowns error', error);
		res.status(500).json({ error: 'Failed to compute breakdowns' });
	}
});

// ── Transfer Management ──────────────────────────────────────

router.get('/transfers', requireAdmin, async (req, res) => {
	try {
		const result = await listTransfers(req.query);
		res.status(200).json(result);
	} catch (error) {
		logError('Admin list transfers error', error);
		res.status(500).json({ error: 'Failed to retrieve transfers' });
	}
});

router.get('/transfers/:code', requireAdmin, async (req, res) => {
	try {
		const transfer = await getTransferDetails(req.params.code);
		if (!transfer) {
			return res.status(404).json({ error: 'Transfer not found' });
		}
		res.status(200).json(transfer);
	} catch (error) {
		logError('Admin transfer details error', error);
		res.status(500).json({ error: 'Failed to retrieve transfer details' });
	}
});

/**
 * POST /api/admin/transfers/:code/expire — Force expire / delete a transfer
 */
router.post('/transfers/:code/expire', requireAdmin, async (req, res) => {
	try {
		const { confirm } = req.body || {};
		if (confirm !== 'EXPIRE') {
			return res.status(400).json({ error: 'Confirmation required: body must include { confirm: "EXPIRE" }' });
		}

		const code = String(req.params.code || '').toUpperCase().trim();
		const transfer = await Transfer.findOne({ code }).lean();

		if (!transfer) {
			return res.status(404).json({ error: 'Transfer not found' });
		}

		if (transfer.isDeleted) {
			return res.status(200).json({ success: true, message: 'Transfer already deleted/expired' });
		}

		// Delete R2 objects
		try {
			await deleteFilesFromR2(transfer.files);
		} catch (r2Err) {
			logError('Force expire R2 delete error', r2Err, `CODE: ${code}`);
		}

		const expiredAt = new Date();
		await Transfer.updateOne(
			{ _id: transfer._id },
			{
				$set: { isDeleted: true },
				$unset: {
					qrDataUri: '',
					passwordHash: '',
					ownershipToken: '',
					'files.$[].inlineContent': '',
				},
				$push: {
					activity: {
						event: 'expired',
						device: `Admin (${req.admin.username})`,
						ip: maskIp(getClientIp(req)),
						timestamp: expiredAt,
					},
				},
			}
		);

		clearTransferCountdown(code);
		emitToRoom(code, 'transfer-deleted', { code, status: 'DELETED', reason: 'admin_expired' });
		emitToAdminNamespace('transfer-expired', { code, by: req.admin.username, timestamp: expiredAt });

		await AdminAudit.create({
			action: 'expire_transfer',
			username: req.admin.username,
			ipMasked: maskIp(getClientIp(req)),
			ua: getDeviceName(req.get('user-agent') || ''),
			details: { code, totalSize: transfer.totalSize, fileCount: transfer.fileCount },
		}).catch(() => {});

		logEvent('Admin force-expired transfer', `CODE: ${code}`, `ADMIN: ${req.admin.username}`);

		return res.status(200).json({ success: true, code, status: 'DELETED' });
	} catch (error) {
		logError('Admin expire transfer error', error);
		return res.status(500).json({ error: 'Failed to expire transfer' });
	}
});

// ── System Health & Audit ────────────────────────────────────

router.get('/system', requireAdmin, async (req, res) => {
	try {
		const perf = typeof getPerformanceSnapshot === 'function' ? getPerformanceSnapshot() : {};
		const memoryUsage = process.memoryUsage();

		res.status(200).json({
			status: 'ok',
			version: pkgVersion || process.env.npm_package_version || '0.8.1',
			uptime: process.uptime(),
			timestamp: new Date().toISOString(),
			services: {
				mongodb: { status: getMongoStatus() === 'connected' ? 'healthy' : 'degraded' },
				r2: { status: isR2Configured ? 'healthy' : 'disconnected' },
				redis: { status: process.env.UPSTASH_REDIS_REST_URL ? 'healthy' : 'fallback_memory' },
			},
			memory: {
				heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
				heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
				rssMB: Math.round(memoryUsage.rss / 1024 / 1024),
			},
			sockets: {
				connectedCount: getSocketConnectedCount(),
			},
			performance: perf,
		});
	} catch (error) {
		logError('Admin system health error', error);
		res.status(500).json({ error: 'Failed to retrieve system status' });
	}
});

router.get('/audit', requireAdmin, async (req, res) => {
	try {
		const audits = await AdminAudit.find({}, {
			ts: 1,
			action: 1,
			username: 1,
			ipMasked: 1,
			ua: 1,
			details: 1,
		})
			.sort({ ts: -1 })
			.limit(100)
			.lean()
			.maxTimeMS(4000);

		res.status(200).json(audits);
	} catch (error) {
		logError('Admin audit query error', error);
		res.status(500).json({ error: 'Failed to retrieve audit log' });
	}
});

// ── CSV Export ───────────────────────────────────────────────

router.get('/export', requireAdmin, async (req, res) => {
	try {
		const type = String(req.query.type || 'summary').toLowerCase();
		const range = String(req.query.range || '7d');

		if (type === 'transfers') {
			res.setHeader('Content-Type', 'text/csv; charset=utf-8');
			res.setHeader('Content-Disposition', `attachment; filename="swiftshare-transfers-${range}-${Date.now()}.csv"`);

			res.write('Code,Status,Kind,Files,Size (Bytes),Downloads,Views,Burn,Password,Created At,Expires At,Device\n');

			const cursor = Transfer.find({}, {
				code: 1,
				isDeleted: 1,
				cancelledAt: 1,
				burnAfterDownload: 1,
				claimantToken: 1,
				expiresAt: 1,
				kind: 1,
				fileCount: 1,
				totalSize: 1,
				downloadCount: 1,
				viewCount: 1,
				passwordProtected: 1,
				createdAt: 1,
				senderDeviceName: 1,
			}).sort({ createdAt: -1 }).limit(5000).cursor();

			for await (const t of cursor) {
				let status = 'ACTIVE';
				if (t.isDeleted && t.cancelledAt) status = 'CANCELLED';
				else if (t.isDeleted) status = 'DELETED';
				else if (t.burnAfterDownload && t.claimantToken) status = 'CLAIMED';
				else if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) status = 'EXPIRED';

				const row = [
					t.code,
					status,
					t.kind || 'file',
					t.fileCount,
					t.totalSize,
					t.downloadCount,
					t.viewCount,
					t.burnAfterDownload ? 'true' : 'false',
					t.passwordProtected ? 'true' : 'false',
					t.createdAt ? t.createdAt.toISOString() : '',
					t.expiresAt ? t.expiresAt.toISOString() : '',
					`"${(t.senderDeviceName || 'Unknown').replace(/"/g, '""')}"`,
				].join(',');

				res.write(`${row}\n`);
			}
			res.end();
			return;
		}

		if (type === 'traffic') {
			res.setHeader('Content-Type', 'text/csv; charset=utf-8');
			res.setHeader('Content-Disposition', `attachment; filename="swiftshare-traffic-${range}-${Date.now()}.csv"`);

			res.write('Timestamp,Route,Device,Browser,OS,Country,Referrer Host,UTM Source,Is Bot\n');

			const cursor = PageView.find({}).sort({ ts: -1 }).limit(5000).cursor();
			for await (const pv of cursor) {
				const row = [
					pv.ts ? pv.ts.toISOString() : '',
					pv.route,
					pv.device,
					pv.browser,
					pv.os,
					pv.country || '',
					pv.refHost || '',
					pv.utm?.source || '',
					pv.isBot ? 'true' : 'false',
				].join(',');
				res.write(`${row}\n`);
			}
			res.end();
			return;
		}

		// Summary Export (JSON format)
		const summary = await getOverviewStats(range);
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Disposition', `attachment; filename="swiftshare-summary-${range}-${Date.now()}.json"`);
		res.send(JSON.stringify(summary, null, 2));
	} catch (error) {
		logError('Admin export error', error);
		res.status(500).json({ error: 'Failed to generate export' });
	}
});

// ── Report Abuse ──────────────────────────────────────────────

router.post('/report-abuse', async (req, res) => {
	// Public endpoint — no auth required so users can report harmful content
	res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

	const { code, reason } = req.body || {};

	if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
		return res.status(400).json({ error: 'A description of the abuse is required (min 5 characters).' });
	}

	const safeCode = typeof code === 'string' ? code.trim().toUpperCase().slice(0, 12) : '';
	const safeReason = reason.trim().slice(0, 2000);
	const ip = getClientIp(req) || 'unknown';
	const ipMasked = maskIp(ip);
	const ua = getDeviceName(req.get('user-agent') || '');

	try {
		await AdminAudit.create({
			action: 'abuse_report',
			username: 'anonymous',
			ipMasked,
			ua,
			details: { code: safeCode || null, reason: safeReason },
		});

		// Notify admin socket in real-time
		emitToAdminNamespace('abuse-report', {
			code: safeCode || null,
			reason: safeReason.slice(0, 200),
			ipMasked,
			timestamp: new Date(),
		});

		logEvent('Abuse report received', `CODE: ${safeCode || 'none'}`, `IP: ${ipMasked}`);

		return res.status(200).json({ success: true, message: 'Report received for review.' });
	} catch (error) {
		logError('Abuse report error', error);
		return res.status(500).json({ error: 'Failed to submit report. Please try again.' });
	}
});

module.exports = router;
