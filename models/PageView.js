const mongoose = require("mongoose");

const pageViewSchema = new mongoose.Schema(
	{
		ts: {
			type: Date,
			default: Date.now,
			index: true,
		},
		route: {
			type: String,
			required: true,
			trim: true,
			// NORMALIZED pattern only: "/", "/join", "/g/:code", "/download/:code", "/how-it-works"
			// Never contains real transfer codes
		},
		refHost: {
			type: String,
			default: "",
			trim: true,
			// Hostname only ("google.com", "t.co", "" for direct)
		},
		utm: {
			source: { type: String, default: "", trim: true },
			medium: { type: String, default: "", trim: true },
			campaign: { type: String, default: "", trim: true },
		},
		device: {
			type: String,
			enum: ["mobile", "tablet", "desktop", "unknown"],
			default: "unknown",
		},
		browser: {
			type: String,
			default: "Unknown",
			trim: true,
		},
		os: {
			type: String,
			default: "Unknown",
			trim: true,
		},
		country: {
			type: String,
			default: "",
			trim: true,
			uppercase: true,
			// ISO-3166 alpha-2
		},
		vid: {
			type: String,
			default: "",
			trim: true,
			// Random UUID from localStorage (returning visitor identifier, no PII)
		},
		dayHash: {
			type: String,
			default: "",
			trim: true,
			// sha256(ANALYTICS_HASH_SALT + yyyy-mm-dd + ip + ua).slice(0, 16)
		},
		sid: {
			type: String,
			default: "",
			trim: true,
			// Per-tab session id
		},
		isBot: {
			type: Boolean,
			default: false,
			index: true,
		},
		botName: {
			type: String,
			default: "",
			trim: true,
		},
	},
	{
		timestamps: false,
		versionKey: false,
	},
);

// TTL index: auto-delete pageviews after 400 days
pageViewSchema.index({ ts: 1 }, { expireAfterSeconds: 400 * 86400, name: "pageview_ttl_400d" });

// Compound indexes for fast admin analytics queries
pageViewSchema.index({ ts: -1, isBot: 1 }, { name: "pv_ts_isbot" });
pageViewSchema.index({ ts: -1, route: 1 }, { name: "pv_ts_route" });
pageViewSchema.index({ ts: -1, vid: 1 }, { name: "pv_ts_vid" });

if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
	pageViewSchema.set("autoIndex", false);
}

module.exports = mongoose.model("PageView", pageViewSchema);
