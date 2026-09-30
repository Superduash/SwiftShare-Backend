'use strict';

const mongoose = require('mongoose');
const Transfer = require('../models/Transfer');
const PageView = require('../models/PageView');
const { getSocketConnectedCount } = require('../config/socket');
const { maskIp } = require('../utils/adminAuth');
const { logError } = require('../utils/logger');

const ADMIN_TIMEZONE = process.env.ADMIN_TIMEZONE || 'Asia/Kolkata';

// In-memory caching for admin queries (30-60s TTL + in-flight deduplication)
const adminCache = new Map();
const inFlightQueries = new Map();

function getCacheKey(name, params = {}) {
	return `${name}:${JSON.stringify(params)}`;
}

async function withAdminCache(key, ttlMs, computeFn) {
	const now = Date.now();
	const cached = adminCache.get(key);
	if (cached && cached.expiresAt > now) {
		return cached.data;
	}

	if (inFlightQueries.has(key)) {
		return inFlightQueries.get(key);
	}

	const promise = (async () => {
		try {
			const data = await computeFn();
			adminCache.set(key, { data, expiresAt: now + ttlMs });
			return data;
		} finally {
			inFlightQueries.delete(key);
		}
	})();

	inFlightQueries.set(key, promise);
	return promise;
}

function parseTimeRange(rangeStr = '7d') {
	const now = new Date();
	let currentStart = null;
	let periodDurationMs = 0;
	let bucket = 'day';

	switch (rangeStr.toLowerCase()) {
		case '24h':
			periodDurationMs = 24 * 60 * 60 * 1000;
			currentStart = new Date(now.getTime() - periodDurationMs);
			bucket = 'hour';
			break;
		case '7d':
			periodDurationMs = 7 * 24 * 60 * 60 * 1000;
			currentStart = new Date(now.getTime() - periodDurationMs);
			bucket = 'day';
			break;
		case '30d':
			periodDurationMs = 30 * 24 * 60 * 60 * 1000;
			currentStart = new Date(now.getTime() - periodDurationMs);
			bucket = 'day';
			break;
		case '90d':
			periodDurationMs = 90 * 24 * 60 * 60 * 1000;
			currentStart = new Date(now.getTime() - periodDurationMs);
			bucket = 'day';
			break;
		case 'all':
		default:
			currentStart = new Date(0); // All time
			periodDurationMs = now.getTime();
			bucket = 'day';
			break;
	}

	const previousStart = currentStart.getTime() > 0
		? new Date(currentStart.getTime() - periodDurationMs)
		: new Date(0);
	const previousEnd = currentStart;

	return {
		range: rangeStr,
		currentStart,
		currentEnd: now,
		previousStart,
		previousEnd,
		periodDurationMs,
		bucket,
		timezone: ADMIN_TIMEZONE,
	};
}

function calculateDelta(current, previous) {
	if (!previous || previous === 0) {
		return current > 0 ? 100 : 0;
	}
	return Number((((current - previous) / previous) * 100).toFixed(1));
}

// ── Overview KPI Aggregation ──────────────────────────────────
async function getOverviewStats(rangeStr = '7d') {
	const cacheKey = getCacheKey('overview', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, previousStart, previousEnd, range } = parseTimeRange(rangeStr);
		const isAllTime = range.toLowerCase() === 'all';

		const pvCurrentMatch = isAllTime
			? { isBot: false }
			: { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false };

		const pvPrevMatch = isAllTime
			? { isBot: false }
			: { ts: { $gte: previousStart, $lt: previousEnd }, isBot: false };

		const trCurrentMatch = isAllTime
			? {}
			: { createdAt: { $gte: currentStart, $lte: currentEnd } };

		const trPrevMatch = isAllTime
			? {}
			: { createdAt: { $gte: previousStart, $lt: previousEnd } };

		const [
			trackingStartDoc,
			currentPvAgg,
			prevPvAgg,
			currentVisitorsAgg,
			prevVisitorsAgg,
			returningVisitorsAgg,
			currentTrAgg,
			prevTrAgg,
			activeTransfersCount,
			speedAgg,
			crawlerHitsAgg,
		] = await Promise.all([
			PageView.findOne({}, { ts: 1 }).sort({ ts: 1 }).lean(),

			// Current Pageviews
			PageView.aggregate([
				{ $match: pvCurrentMatch },
				{ $group: { _id: null, count: { $sum: 1 } } },
			]).maxTimeMS(8000),

			// Previous Pageviews
			isAllTime ? Promise.resolve([]) : PageView.aggregate([
				{ $match: pvPrevMatch },
				{ $group: { _id: null, count: { $sum: 1 } } },
			]).maxTimeMS(8000),

			// Current Visitors (Distinct vid or dayHash)
			PageView.aggregate([
				{ $match: pvCurrentMatch },
				{
					$group: {
						_id: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] },
					},
				},
				{ $group: { _id: null, count: { $sum: 1 } } },
			]).allowDiskUse(true).maxTimeMS(8000),

			// Previous Visitors
			isAllTime ? Promise.resolve([]) : PageView.aggregate([
				{ $match: pvPrevMatch },
				{
					$group: {
						_id: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] },
					},
				},
				{ $group: { _id: null, count: { $sum: 1 } } },
			]).allowDiskUse(true).maxTimeMS(8000),

			// Returning visitors (visitors with >1 session)
			PageView.aggregate([
				{ $match: pvCurrentMatch },
				{
					$group: {
						_id: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] },
						sessionCount: { $addToSet: '$sid' },
					},
				},
				{
					$project: {
						isReturning: { $gt: [{ $size: '$sessionCount' }, 1] },
					},
				},
				{
					$group: {
						_id: null,
						total: { $sum: 1 },
						returning: { $sum: { $cond: ['$isReturning', 1, 0] } },
					},
				},
			]).allowDiskUse(true).maxTimeMS(8000),

			// Current Transfers Aggregate
			Transfer.aggregate([
				{ $match: trCurrentMatch },
				{
					$group: {
						_id: null,
						totalTransfers: { $sum: 1 },
						totalFiles: { $sum: '$fileCount' },
						totalBytes: { $sum: '$totalSize' },
						totalDownloads: { $sum: '$downloadCount' },
						downloadedTransfers: {
							$sum: { $cond: [{ $gt: ['$downloadCount', 0] }, 1, 0] },
						},
						burnTransfers: {
							$sum: { $cond: ['$burnAfterDownload', 1, 0] },
						},
						passwordTransfers: {
							$sum: { $cond: ['$passwordProtected', 1, 0] },
						},
						textTransfers: {
							$sum: { $cond: [{ $eq: ['$kind', 'text'] }, 1, 0] },
						},
					},
				},
			]).allowDiskUse(true).maxTimeMS(8000),

			// Previous Transfers Aggregate
			isAllTime ? Promise.resolve([]) : Transfer.aggregate([
				{ $match: trPrevMatch },
				{
					$group: {
						_id: null,
						totalTransfers: { $sum: 1 },
						totalFiles: { $sum: '$fileCount' },
						totalBytes: { $sum: '$totalSize' },
						totalDownloads: { $sum: '$downloadCount' },
					},
				},
			]).allowDiskUse(true).maxTimeMS(8000),

			// Active transfers right now
			Transfer.countDocuments({
				isDeleted: false,
				expiresAt: { $gt: new Date() },
			}).maxTimeMS(4000),

			// Speed Stats
			Transfer.aggregate([
				{
					$match: {
						...trCurrentMatch,
						$or: [{ downloadSpeed: { $gt: 0 } }, { uploadSpeed: { $gt: 0 } }],
					},
				},
				{
					$project: {
						speed: {
							$cond: [{ $gt: ['$downloadSpeed', 0] }, '$downloadSpeed', '$uploadSpeed'],
						},
					},
				},
				{ $group: { _id: null, avgSpeed: { $avg: '$speed' } } },
			]).allowDiskUse(true).maxTimeMS(8000),

			// Crawler Hits
			PageView.countDocuments(
				isAllTime ? { isBot: true } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: true }
			).maxTimeMS(4000),
		]);

		const currentPV = currentPvAgg[0]?.count || 0;
		const prevPV = prevPvAgg[0]?.count || 0;

		const currentVisitors = currentVisitorsAgg[0]?.count || 0;
		const prevVisitors = prevVisitorsAgg[0]?.count || 0;

		const retTotal = returningVisitorsAgg[0]?.total || 0;
		const retCount = returningVisitorsAgg[0]?.returning || 0;
		const returningVisitorsPct = retTotal > 0 ? Number(((retCount / retTotal) * 100).toFixed(1)) : 0;

		const trCurrent = currentTrAgg[0] || {
			totalTransfers: 0,
			totalFiles: 0,
			totalBytes: 0,
			totalDownloads: 0,
			downloadedTransfers: 0,
			burnTransfers: 0,
			passwordTransfers: 0,
			textTransfers: 0,
		};

		const trPrev = prevTrAgg[0] || {
			totalTransfers: 0,
			totalFiles: 0,
			totalBytes: 0,
			totalDownloads: 0,
		};

		const downloadRate = trCurrent.totalTransfers > 0
			? Number(((trCurrent.downloadedTransfers / trCurrent.totalTransfers) * 100).toFixed(1))
			: 0;

		const burnModePct = trCurrent.totalTransfers > 0
			? Number(((trCurrent.burnTransfers / trCurrent.totalTransfers) * 100).toFixed(1))
			: 0;

		const passwordProtectedPct = trCurrent.totalTransfers > 0
			? Number(((trCurrent.passwordTransfers / trCurrent.totalTransfers) * 100).toFixed(1))
			: 0;

		const textSnippetPct = trCurrent.totalTransfers > 0
			? Number(((trCurrent.textTransfers / trCurrent.totalTransfers) * 100).toFixed(1))
			: 0;

		const avgTransferSpeed = Math.round(speedAgg[0]?.avgSpeed || 0);

		return {
			range,
			trackingSince: trackingStartDoc?.ts || null,
			dataThrough: new Date(),
			kpis: {
				pageviews: { value: currentPV, delta: calculateDelta(currentPV, prevPV) },
				visitors: { value: currentVisitors, delta: calculateDelta(currentVisitors, prevVisitors) },
				returningVisitorsPct: { value: returningVisitorsPct, delta: 0 },
				onlineNow: { value: getSocketConnectedCount(), delta: 0 },
				totalTransfers: { value: trCurrent.totalTransfers, delta: calculateDelta(trCurrent.totalTransfers, trPrev.totalTransfers) },
				activeTransfers: { value: activeTransfersCount, delta: 0 },
				totalFiles: { value: trCurrent.totalFiles, delta: calculateDelta(trCurrent.totalFiles, trPrev.totalFiles) },
				dataSharedBytes: { value: trCurrent.totalBytes, delta: calculateDelta(trCurrent.totalBytes, trPrev.totalBytes) },
				totalDownloads: { value: trCurrent.totalDownloads, delta: calculateDelta(trCurrent.totalDownloads, trPrev.totalDownloads) },
				downloadRate: { value: downloadRate, delta: 0 },
				avgTransferSpeed: { value: avgTransferSpeed, delta: 0 },
				burnModePct: { value: burnModePct, delta: 0 },
				passwordProtectedPct: { value: passwordProtectedPct, delta: 0 },
				textSnippetPct: { value: textSnippetPct, delta: 0 },
				crawlerHits: { value: crawlerHitsAgg, delta: 0 },
			},
		};
	});
}

// ── Timeseries Aggregation ──────────────────────────────────
async function getTimeseries(metric = 'pageviews', rangeStr = '7d') {
	const cacheKey = getCacheKey('timeseries', { metric, range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, bucket, timezone, range } = parseTimeRange(rangeStr);
		const isAllTime = range.toLowerCase() === 'all';
		const dateUnit = bucket === 'hour' ? 'hour' : 'day';

		let data = [];

		if (metric === 'pageviews' || metric === 'crawlerHits') {
			const isBot = metric === 'crawlerHits';
			const match = isAllTime ? { isBot } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot };

			data = await PageView.aggregate([
				{ $match: match },
				{
					$group: {
						_id: { $dateTrunc: { date: '$ts', unit: dateUnit, timezone } },
						v: { $sum: 1 },
					},
				},
				{ $sort: { _id: 1 } },
			]).allowDiskUse(true).maxTimeMS(8000);
		} else if (metric === 'visitors') {
			const match = isAllTime ? { isBot: false } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false };

			data = await PageView.aggregate([
				{ $match: match },
				{
					$group: {
						_id: {
							t: { $dateTrunc: { date: '$ts', unit: dateUnit, timezone } },
							uid: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] },
						},
					},
				},
				{
					$group: {
						_id: '$_id.t',
						v: { $sum: 1 },
					},
				},
				{ $sort: { _id: 1 } },
			]).allowDiskUse(true).maxTimeMS(8000);
		} else if (metric === 'transfers') {
			const match = isAllTime ? {} : { createdAt: { $gte: currentStart, $lte: currentEnd } };

			data = await Transfer.aggregate([
				{ $match: match },
				{
					$group: {
						_id: { $dateTrunc: { date: '$createdAt', unit: dateUnit, timezone } },
						v: { $sum: 1 },
					},
				},
				{ $sort: { _id: 1 } },
			]).allowDiskUse(true).maxTimeMS(8000);
		} else if (metric === 'downloads') {
			const match = isAllTime
				? { 'activity.event': 'downloaded' }
				: { 'activity.event': 'downloaded', 'activity.timestamp': { $gte: currentStart, $lte: currentEnd } };

			data = await Transfer.aggregate([
				{ $unwind: '$activity' },
				{ $match: match },
				{
					$group: {
						_id: { $dateTrunc: { date: '$activity.timestamp', unit: dateUnit, timezone } },
						v: { $sum: 1 },
					},
				},
				{ $sort: { _id: 1 } },
			]).allowDiskUse(true).maxTimeMS(8000);
		} else if (metric === 'bytes') {
			const match = isAllTime ? {} : { createdAt: { $gte: currentStart, $lte: currentEnd } };

			data = await Transfer.aggregate([
				{ $match: match },
				{
					$group: {
						_id: { $dateTrunc: { date: '$createdAt', unit: dateUnit, timezone } },
						v: { $sum: '$totalSize' },
					},
				},
				{ $sort: { _id: 1 } },
			]).allowDiskUse(true).maxTimeMS(8000);
		}

		// Fill zero buckets in Node
		const resultMap = new Map(data.map((d) => [new Date(d._id).toISOString(), d.v]));
		const result = [];
		const startMs = currentStart.getTime() > 0 ? currentStart.getTime() : (data[0]?._id ? new Date(data[0]._id).getTime() : Date.now() - 7 * 86400000);
		const stepMs = bucket === 'hour' ? 3600000 : 86400000;
		const endMs = currentEnd.getTime();

		for (let t = startMs; t <= endMs; t += stepMs) {
			const d = new Date(t);
			if (bucket === 'hour') d.setMinutes(0, 0, 0);
			else d.setHours(0, 0, 0, 0);

			const iso = d.toISOString();
			result.push({
				t: iso,
				v: resultMap.get(iso) || 0,
			});
		}

		return {
			metric,
			range: rangeStr,
			bucket,
			series: result,
		};
	});
}

// ── Traffic Breakdown Endpoints ──────────────────────────────
async function getTrafficPages(rangeStr = '7d') {
	const cacheKey = getCacheKey('traffic_pages', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, range } = parseTimeRange(rangeStr);
		const match = range === 'all' ? { isBot: false } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false };

		const rows = await PageView.aggregate([
			{ $match: match },
			{
				$group: {
					_id: '$route',
					views: { $sum: 1 },
					uniqueVisitors: { $addToSet: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] } },
				},
			},
			{
				$project: {
					route: '$_id',
					views: 1,
					visitors: { $size: '$uniqueVisitors' },
				},
			},
			{ $sort: { views: -1 } },
			{ $limit: 50 },
		]).allowDiskUse(true).maxTimeMS(8000);

		return rows;
	});
}

async function getTrafficSources(rangeStr = '7d') {
	const cacheKey = getCacheKey('traffic_sources', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, range } = parseTimeRange(rangeStr);
		const match = range === 'all' ? { isBot: false } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false };

		const [hostAgg, utmAgg] = await Promise.all([
			PageView.aggregate([
				{ $match: match },
				{
					$group: {
						_id: '$refHost',
						views: { $sum: 1 },
						visitors: { $addToSet: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] } },
					},
				},
				{
					$project: {
						host: '$_id',
						views: 1,
						visitors: { $size: '$visitors' },
					},
				},
				{ $sort: { views: -1 } },
				{ $limit: 50 },
			]).allowDiskUse(true).maxTimeMS(8000),

			PageView.aggregate([
				{
					$match: {
						...match,
						$or: [
							{ 'utm.source': { $ne: '' } },
							{ 'utm.campaign': { $ne: '' } },
						],
					},
				},
				{
					$group: {
						_id: {
							source: '$utm.source',
							medium: '$utm.medium',
							campaign: '$utm.campaign',
						},
						views: { $sum: 1 },
					},
				},
				{ $sort: { views: -1 } },
				{ $limit: 20 },
			]).allowDiskUse(true).maxTimeMS(8000),
		]);

		// Group hosts into categories
		const searchEngines = ['google.', 'bing.', 'duckduckgo.', 'yahoo.', 'ecosia.', 'baidu.', 'yandex.'];
		const socialMedia = ['t.co', 'twitter.', 'x.com', 'facebook.', 'instagram.', 'whatsapp.', 'telegram.', 'linkedin.', 'reddit.', 'youtube.', 'tiktok.', 'pinterest.'];

		let direct = 0;
		let search = 0;
		let social = 0;
		let other = 0;

		for (const h of hostAgg) {
			const host = h.host || '';
			if (!host) {
				direct += h.views;
			} else if (searchEngines.some((s) => host.includes(s))) {
				search += h.views;
			} else if (socialMedia.some((s) => host.includes(s))) {
				social += h.views;
			} else {
				other += h.views;
			}
		}

		return {
			categories: { direct, search, social, other },
			hosts: hostAgg,
			utmCampaigns: utmAgg.map((u) => ({
				source: u._id.source,
				medium: u._id.medium,
				campaign: u._id.campaign,
				views: u.views,
			})),
		};
	});
}

async function getTrafficCountries(rangeStr = '7d') {
	const cacheKey = getCacheKey('traffic_countries', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, range } = parseTimeRange(rangeStr);
		const match = range === 'all'
			? { isBot: false, country: { $ne: '' } }
			: { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false, country: { $ne: '' } };

		return PageView.aggregate([
			{ $match: match },
			{
				$group: {
					_id: '$country',
					views: { $sum: 1 },
					visitors: { $addToSet: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] } },
				},
			},
			{
				$project: {
					code: '$_id',
					views: 1,
					visitors: { $size: '$visitors' },
				},
			},
			{ $sort: { visitors: -1 } },
			{ $limit: 60 },
		]).allowDiskUse(true).maxTimeMS(8000);
	});
}

async function getTrafficDevices(rangeStr = '7d') {
	const cacheKey = getCacheKey('traffic_devices', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, range } = parseTimeRange(rangeStr);
		const match = range === 'all' ? { isBot: false } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false };

		const [devices, browsers, osList] = await Promise.all([
			PageView.aggregate([
				{ $match: match },
				{ $group: { _id: '$device', count: { $sum: 1 } } },
				{ $sort: { count: -1 } },
			]).maxTimeMS(8000),

			PageView.aggregate([
				{ $match: match },
				{ $group: { _id: '$browser', count: { $sum: 1 } } },
				{ $sort: { count: -1 } },
				{ $limit: 10 },
			]).maxTimeMS(8000),

			PageView.aggregate([
				{ $match: match },
				{ $group: { _id: '$os', count: { $sum: 1 } } },
				{ $sort: { count: -1 } },
				{ $limit: 10 },
			]).maxTimeMS(8000),
		]);

		return { devices, browsers, os: osList };
	});
}

async function getTrafficHours(rangeStr = '7d') {
	const cacheKey = getCacheKey('traffic_hours', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, timezone, range } = parseTimeRange(rangeStr);
		const match = range === 'all' ? { isBot: false } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false };

		// MongoDB $dayOfWeek returns 1 (Sunday) to 7 (Saturday)
		// $hour returns 0-23
		const heatmap = await PageView.aggregate([
			{ $match: match },
			{
				$group: {
					_id: {
						dayOfWeek: { $dayOfWeek: { date: '$ts', timezone } },
						hour: { $hour: { date: '$ts', timezone } },
					},
					views: { $sum: 1 },
				},
			},
		]).allowDiskUse(true).maxTimeMS(8000);

		// Format as 7x24 grid (0..6 day, 0..23 hour)
		const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
		for (const h of heatmap) {
			const dayIndex = (h._id.dayOfWeek - 1) % 7; // 0 = Sunday
			const hourIndex = h._id.hour;
			if (grid[dayIndex] && typeof grid[dayIndex][hourIndex] !== 'undefined') {
				grid[dayIndex][hourIndex] = h.views;
			}
		}

		return grid;
	});
}

async function getTrafficCrawlers(rangeStr = '7d') {
	const cacheKey = getCacheKey('traffic_crawlers', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, range } = parseTimeRange(rangeStr);
		const match = range === 'all' ? { isBot: true } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: true };

		return PageView.aggregate([
			{ $match: match },
			{
				$group: {
					_id: '$botName',
					hits: { $sum: 1 },
					lastSeen: { $max: '$ts' },
				},
			},
			{
				$project: {
					bot: '$_id',
					hits: 1,
					lastSeen: 1,
				},
			},
			{ $sort: { hits: -1 } },
			{ $limit: 20 },
		]).maxTimeMS(8000);
	});
}

// ── Funnel & Breakdowns ──────────────────────────────────────
async function getFunnel(rangeStr = '7d') {
	const cacheKey = getCacheKey('funnel', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, range } = parseTimeRange(rangeStr);
		const pvMatch = range === 'all' ? { isBot: false } : { ts: { $gte: currentStart, $lte: currentEnd }, isBot: false };
		const trMatch = range === 'all' ? {} : { createdAt: { $gte: currentStart, $lte: currentEnd } };

		const [visitorsAgg, transfersAgg] = await Promise.all([
			PageView.aggregate([
				{ $match: pvMatch },
				{
					$group: {
						_id: { $cond: [{ $ne: ['$vid', ''] }, '$vid', '$dayHash'] },
					},
				},
				{ $group: { _id: null, count: { $sum: 1 } } },
			]).allowDiskUse(true).maxTimeMS(8000),

			Transfer.aggregate([
				{ $match: trMatch },
				{
					$group: {
						_id: null,
						created: { $sum: 1 },
						downloaded: { $sum: { $cond: [{ $gt: ['$downloadCount', 0] }, 1, 0] } },
					},
				},
			]).allowDiskUse(true).maxTimeMS(8000),
		]);

		const visitors = visitorsAgg[0]?.count || 0;
		const created = transfersAgg[0]?.created || 0;
		const downloaded = transfersAgg[0]?.downloaded || 0;

		return {
			visitors,
			created,
			downloaded,
			createRate: visitors > 0 ? Number(((created / visitors) * 100).toFixed(1)) : 0,
			downloadRate: created > 0 ? Number(((downloaded / created) * 100).toFixed(1)) : 0,
		};
	});
}

async function getBreakdowns(rangeStr = '7d') {
	const cacheKey = getCacheKey('breakdowns', { range: rangeStr });
	return withAdminCache(cacheKey, 30000, async () => {
		const { currentStart, currentEnd, range } = parseTimeRange(rangeStr);
		const trMatch = range === 'all' ? {} : { createdAt: { $gte: currentStart, $lte: currentEnd } };

		const [mimeAgg, sizeAgg, flagsAgg, kindAgg] = await Promise.all([
			// MIME types family
			Transfer.aggregate([
				{ $match: trMatch },
				{ $unwind: '$files' },
				{
					$project: {
						family: {
							$cond: [
								{ $regexMatch: { input: '$files.mimeType', regex: /^image\//i } }, 'Image',
								{ $cond: [
									{ $regexMatch: { input: '$files.mimeType', regex: /^video\//i } }, 'Video',
									{ $cond: [
										{ $regexMatch: { input: '$files.mimeType', regex: /^audio\//i } }, 'Audio',
										{ $cond: [
											{ $regexMatch: { input: '$files.mimeType', regex: /^text\/|application\/json|application\/javascript/i } }, 'Document/Code',
											{ $cond: [
												{ $regexMatch: { input: '$files.mimeType', regex: /zip|rar|tar|gz|7z/i } }, 'Archive',
												'Other',
											] },
										] },
									] },
								] },
							],
						},
					},
				},
				{ $group: { _id: '$family', count: { $sum: 1 } } },
				{ $sort: { count: -1 } },
			]).allowDiskUse(true).maxTimeMS(8000),

			// Size buckets (<1MB, 1-10MB, 10-50MB, 50-100MB, >100MB)
			Transfer.aggregate([
				{ $match: trMatch },
				{
					$project: {
						bucket: {
							$switch: {
								branches: [
									{ case: { $lt: ['$totalSize', 1048576] }, then: '< 1 MB' },
									{ case: { $lt: ['$totalSize', 10485760] }, then: '1 - 10 MB' },
									{ case: { $lt: ['$totalSize', 52428800] }, then: '10 - 50 MB' },
									{ case: { $lt: ['$totalSize', 104857600] }, then: '50 - 100 MB' },
								],
								default: '> 100 MB',
							},
						},
					},
				},
				{ $group: { _id: '$bucket', count: { $sum: 1 } } },
			]).allowDiskUse(true).maxTimeMS(8000),

			// Flags and file counts
			Transfer.aggregate([
				{ $match: trMatch },
				{
					$group: {
						_id: null,
						total: { $sum: 1 },
						singleFile: { $sum: { $cond: [{ $eq: ['$fileCount', 1] }, 1, 0] } },
						multiFile: { $sum: { $cond: [{ $gt: ['$fileCount', 1] }, 1, 0] } },
						burn: { $sum: { $cond: ['$burnAfterDownload', 1, 0] } },
						password: { $sum: { $cond: ['$passwordProtected', 1, 0] } },
					},
				},
			]).allowDiskUse(true).maxTimeMS(8000),

			// Kind (file vs text)
			Transfer.aggregate([
				{ $match: trMatch },
				{ $group: { _id: '$kind', count: { $sum: 1 } } },
			]).allowDiskUse(true).maxTimeMS(8000),
		]);

		return {
			mimeTypes: mimeAgg,
			sizes: sizeAgg,
			flags: flagsAgg[0] || { total: 0, singleFile: 0, multiFile: 0, burn: 0, password: 0 },
			kind: kindAgg,
		};
	});
}

// ── Transfer Management & Listing ────────────────────────────
async function listTransfers({ page = 1, limit = 25, status, burn, password, search, sort = 'createdAt_desc' }) {
	const safePage = Math.max(1, parseInt(page, 10) || 1);
	const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
	const skip = (safePage - 1) * safeLimit;

	const filter = {};

	if (status) {
		const s = status.toUpperCase();
		const now = new Date();
		if (s === 'ACTIVE') {
			filter.isDeleted = false;
			filter.expiresAt = { $gt: now };
		} else if (s === 'EXPIRED') {
			filter.isDeleted = false;
			filter.expiresAt = { $lte: now };
		} else if (s === 'DELETED') {
			filter.isDeleted = true;
			filter.cancelledAt = null;
		} else if (s === 'CANCELLED') {
			filter.isDeleted = true;
			filter.cancelledAt = { $ne: null };
		} else if (s === 'CLAIMED') {
			filter.burnAfterDownload = true;
			filter.claimantToken = { $ne: '' };
		}
	}

	if (burn === 'true') filter.burnAfterDownload = true;
	if (burn === 'false') filter.burnAfterDownload = false;

	if (password === 'true') filter.passwordProtected = true;
	if (password === 'false') filter.passwordProtected = false;

	if (search) {
		const term = String(search).trim();
		if (/^[A-Za-z0-9]{4,10}$/.test(term)) {
			filter.code = term.toUpperCase();
		} else {
			filter.senderDeviceName = { $regex: term, $options: 'i' };
		}
	}

	let sortQuery = { createdAt: -1 };
	if (sort === 'createdAt_asc') sortQuery = { createdAt: 1 };
	else if (sort === 'size_desc') sortQuery = { totalSize: -1 };
	else if (sort === 'downloads_desc') sortQuery = { downloadCount: -1 };

	const [total, items] = await Promise.all([
		Transfer.countDocuments(filter).maxTimeMS(4000),
		Transfer.find(filter, {
			code: 1,
			fileCount: 1,
			totalSize: 1,
			files: 1,
			isZipped: 1,
			kind: 1,
			burnAfterDownload: 1,
			passwordProtected: 1,
			downloadCount: 1,
			viewCount: 1,
			uploadSpeed: 1,
			downloadSpeed: 1,
			expiresAt: 1,
			isDeleted: 1,
			cancelledAt: 1,
			senderIp: 1,
			senderDeviceName: 1,
			createdAt: 1,
		})
			.sort(sortQuery)
			.skip(skip)
			.limit(safeLimit)
			.lean()
			.maxTimeMS(8000),
	]);

	const sanitizedItems = items.map((t) => {
		let computedStatus = 'ACTIVE';
		if (t.isDeleted && t.cancelledAt) computedStatus = 'CANCELLED';
		else if (t.isDeleted) computedStatus = 'DELETED';
		else if (t.burnAfterDownload && t.claimantToken) computedStatus = 'CLAIMED';
		else if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) computedStatus = 'EXPIRED';

		return {
			code: t.code,
			status: computedStatus,
			kind: t.kind || 'file',
			fileCount: t.fileCount,
			totalSize: t.totalSize,
			files: (t.files || []).map((f) => ({
				originalName: f.originalName,
				size: f.size,
				mimeType: f.mimeType,
				icon: f.icon,
			})),
			burnAfterDownload: t.burnAfterDownload,
			passwordProtected: t.passwordProtected,
			downloadCount: t.downloadCount,
			viewCount: t.viewCount,
			uploadSpeed: t.uploadSpeed,
			downloadSpeed: t.downloadSpeed,
			createdAt: t.createdAt,
			expiresAt: t.expiresAt,
			senderDeviceName: t.senderDeviceName,
			senderIpMasked: maskIp(t.senderIp),
		};
	});

	return {
		page: safePage,
		limit: safeLimit,
		total,
		totalPages: Math.ceil(total / safeLimit) || 1,
		items: sanitizedItems,
	};
}

async function getTransferDetails(code) {
	const transfer = await Transfer.findOne(
		{ code: String(code || '').toUpperCase().trim() },
		{
			code: 1,
			fileCount: 1,
			totalSize: 1,
			files: 1,
			isZipped: 1,
			kind: 1,
			burnAfterDownload: 1,
			passwordProtected: 1,
			downloadCount: 1,
			viewCount: 1,
			uploadSpeed: 1,
			downloadSpeed: 1,
			uploadDuration: 1,
			downloadDuration: 1,
			expiresAt: 1,
			isDeleted: 1,
			cancelledAt: 1,
			burnClaimedAt: 1,
			burnFinalizedAt: 1,
			senderIp: 1,
			senderDeviceName: 1,
			createdAt: 1,
			activity: 1,
		}
	).lean();

	if (!transfer) return null;

	let computedStatus = 'ACTIVE';
	if (transfer.isDeleted && transfer.cancelledAt) computedStatus = 'CANCELLED';
	else if (transfer.isDeleted) computedStatus = 'DELETED';
	else if (transfer.burnAfterDownload && transfer.claimantToken) computedStatus = 'CLAIMED';
	else if (transfer.expiresAt && new Date(transfer.expiresAt).getTime() < Date.now()) computedStatus = 'EXPIRED';

	return {
		code: transfer.code,
		status: computedStatus,
		kind: transfer.kind || 'file',
		fileCount: transfer.fileCount,
		totalSize: transfer.totalSize,
		files: (transfer.files || []).map((f) => ({
			originalName: f.originalName,
			size: f.size,
			mimeType: f.mimeType,
			icon: f.icon,
		})),
		burnAfterDownload: transfer.burnAfterDownload,
		passwordProtected: transfer.passwordProtected,
		downloadCount: transfer.downloadCount,
		viewCount: transfer.viewCount,
		uploadSpeed: transfer.uploadSpeed,
		downloadSpeed: transfer.downloadSpeed,
		uploadDuration: transfer.uploadDuration,
		downloadDuration: transfer.downloadDuration,
		createdAt: transfer.createdAt,
		expiresAt: transfer.expiresAt,
		senderDeviceName: transfer.senderDeviceName,
		senderIpMasked: maskIp(transfer.senderIp),
		activity: (transfer.activity || []).map((a) => ({
			event: a.event,
			device: a.device,
			ipMasked: maskIp(a.ip),
			timestamp: a.timestamp,
		})),
	};
}

module.exports = {
	parseTimeRange,
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
};
