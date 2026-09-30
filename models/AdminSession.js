const mongoose = require("mongoose");

const adminSessionSchema = new mongoose.Schema(
	{
		jti: {
			type: String,
			required: true,
			unique: true,
			index: true,
		},
		username: {
			type: String,
			required: true,
		},
		ipMasked: {
			type: String,
			default: "",
		},
		ua: {
			type: String,
			default: "",
		},
		createdAt: {
			type: Date,
			default: Date.now,
		},
		expiresAt: {
			type: Date,
			required: true,
			index: { expires: 0 },
		},
	},
	{
		timestamps: false,
		versionKey: false,
	},
);

if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
	adminSessionSchema.set("autoIndex", false);
}

module.exports = mongoose.model("AdminSession", adminSessionSchema);
