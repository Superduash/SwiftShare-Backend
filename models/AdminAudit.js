const mongoose = require("mongoose");

const adminAuditSchema = new mongoose.Schema(
	{
		ts: {
			type: Date,
			default: Date.now,
			index: true,
		},
		action: {
			type: String,
			required: true,
			// login_success, login_failed, lockout, expire_transfer, logout, logout_all
		},
		username: {
			type: String,
			default: "admin",
		},
		ipMasked: {
			type: String,
			default: "",
		},
		ua: {
			type: String,
			default: "",
		},
		details: {
			type: mongoose.Schema.Types.Mixed,
			default: {},
		},
	},
	{
		timestamps: false,
		versionKey: false,
	},
);

adminAuditSchema.index({ ts: -1 });

if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
	adminAuditSchema.set("autoIndex", false);
}

module.exports = mongoose.model("AdminAudit", adminAuditSchema);
