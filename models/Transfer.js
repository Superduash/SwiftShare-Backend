const mongoose = require("mongoose");

const transferFileSchema = new mongoose.Schema(
	{
		originalName: {
			type: String,
			required: true,
		},
		storedKey: {
			type: String,
			required: true,
		},
		size: {
			type: Number,
			required: true,
			min: 0,
		},
		mimeType: {
			type: String,
			required: true,
		},
		icon: {
			type: String,
			required: true,
		},
		// Optional inline content for small text shares (helps the frontend render
		// text immediately without an extra backend round-trip to R2).
		inlineContent: {
			type: String,
			default: null,
		},
	},
	{ _id: false },
);

const transferActivitySchema = new mongoose.Schema(
	{
		event: {
			type: String,
			required: true,
		},
		device: {
			type: String,
			default: "Unknown Device",
		},
		ip: {
			type: String,
			default: "",
		},
		timestamp: {
			type: Date,
			default: Date.now,
		},
	},
	{ _id: false },
);

const transferSchema = new mongoose.Schema(
	{
		code: {
			type: String,
			required: true,
			unique: true,
			index: true,
		},
		files: {
			type: [transferFileSchema],
			required: true,
		},
		totalSize: {
			type: Number,
			required: true,
			min: 0,
		},
		fileCount: {
			type: Number,
			required: true,
			min: 0,
		},
		isZipped: {
			type: Boolean,
			default: false,
		},
		burnAfterDownload: {
			type: Boolean,
			default: false,
		},
		passwordProtected: {
			type: Boolean,
			default: false,
		},
		passwordHash: {
			type: String,
			default: null,
		},
		passwordAttempts: {
			type: Number,
			default: 0,
			min: 0,
		},
		extendedOnce: {
			type: Boolean,
			default: false,
		},
		downloadCount: {
			type: Number,
			default: 0,
			min: 0,
		},
		burnClaimOwner: {
			type: String,
			default: "",
		},
		claimantToken: {
			type: String,
			default: "",
		},
		claimantSocketId: {
			type: String,
			default: "",
		},
		burnClaimedAt: {
			type: Date,
			default: null,
		},
		burnLastActiveAt: {
			type: Date,
			default: null,
		},
		burnFinalizedAt: {
			type: Date,
			default: null,
		},
		uploadSpeed: {
			type: Number,
			default: 0,
			min: 0,
		},
		uploadDuration: {
			type: Number,
			default: 0,
			min: 0,
		},
		downloadSpeed: {
			type: Number,
			default: 0,
			min: 0,
		},
		downloadDuration: {
			type: Number,
			default: 0,
			min: 0,
		},
		expiresAt: {
			type: Date,
			required: true,
		},
		isDeleted: {
			type: Boolean,
			default: false,
		},
		cancelledAt: {
			type: Date,
			default: null,
		},
		senderIp: {
			type: String,
			default: "",
		},
		senderDeviceName: {
			type: String,
			default: "",
		},
		senderSocketId: {
			type: String,
			default: "",
		},
		ownershipToken: {
			type: String,
			default: "",
		},
		qrDataUri: {
			type: String,
			default: "",
			// @deprecated: Server-side QR generation was removed. Frontend renders QR
			// from shareLink using react-qr-code. Field retained for schema backward-compat.
		},
		activity: {
			type: [transferActivitySchema],
			default: [],
		},
	},
	{
		timestamps: true,
		toJSON: { virtuals: true },
		toObject: { virtuals: true },
	},
);

transferSchema.virtual("status").get(function () {
	if (this.isDeleted && this.cancelledAt) {
		return "CANCELLED";
	}

	if (this.isDeleted) {
		return "DELETED";
	}

	if (this.burnAfterDownload && (this.claimantToken || this.burnClaimOwner)) {
		return "CLAIMED";
	}

	if (this.expiresAt && new Date(this.expiresAt).getTime() < Date.now()) {
		return "EXPIRED";
	}

	return "ACTIVE";
});

// Recency sort for stats / sender-page recents.
transferSchema.index({ createdAt: -1 });

// Optimizes the nearby-devices query (senderIp prefix + active filter + recency sort).
// Compound order matches the common predicate.
transferSchema.index(
	{ isDeleted: 1, expiresAt: 1, senderIp: 1, createdAt: -1 },
	{ name: "nearby_active_by_subnet" },
);

// Optimizes the cleanup sweep predicate (expired & not yet deleted).
transferSchema.index(
	{ isDeleted: 1, expiresAt: 1 },
	{ name: "cleanup_active" },
);

// Optimizes the burn-finalize sweep (claimed but idle).
transferSchema.index(
	{ burnAfterDownload: 1, isDeleted: 1, burnLastActiveAt: 1 },
	{ name: "cleanup_stale_burn", sparse: true },
);

// Optimizes stale socket cleanup (finds transfers with specific senderSocketId)
transferSchema.index({ senderSocketId: 1 }, { sparse: true });

// Optimizes stats distinct query with recency window. Also serves bare-senderIp lookups,
// so no separate { senderIp: 1 } index is needed.
transferSchema.index({ senderIp: 1, createdAt: 1 });

// Optimizes the nearby-devices socket query
transferSchema.index({ isDeleted: 1, expiresAt: 1, senderSocketId: 1, createdAt: -1 }, { name: "nearby_sockets" });

// TTL safety net: MongoDB auto-deletes documents 24 hours after expiresAt.
// Gives the cleanup job time to delete R2 files first; do NOT use expireAfterSeconds: 0
// (which would delete immediately on expiry and orphan R2 objects).
transferSchema.index(
	{ expiresAt: 1 },
	{ expireAfterSeconds: 86400, name: "ttl_post_expiry_safety_net" },
);

// Disable Mongoose's autoIndex in production: index builds at app start can stall
// the dyno on cold-start. Indexes are managed via this file + occasional manual sync.
if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
	transferSchema.set("autoIndex", false);
}

module.exports = mongoose.model("Transfer", transferSchema);

