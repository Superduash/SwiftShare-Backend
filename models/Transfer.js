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
		downloadCount: {
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
		qrDataUri: {
			type: String,
			default: "",
		},
		ai: {
			type: {
				summary: { type: String, default: null },
				suggestedName: { type: String, default: null },
				category: { type: String, default: null },
				imageDescription: { type: String, default: null },
			},
			default: null,
		},
	},
	{
		timestamps: true,
	},
);

transferSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
transferSchema.index({ createdAt: -1 });
transferSchema.index({ senderIp: 1 });

module.exports = mongoose.model("Transfer", transferSchema);

