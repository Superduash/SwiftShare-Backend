'use strict';

const mongoose = require('mongoose');

const adminSettingsSchema = new mongoose.Schema(
	{
		key: {
			type: String,
			required: true,
			unique: true,
			default: 'global',
		},
		twoFactorEnabled: {
			type: Boolean,
			default: false,
		},
		twoFactorSecret: {
			type: String,
			default: '',
		},
		pendingTwoFactorSecret: {
			type: String,
			default: '',
		},
		twoFactorConfirmedAt: {
			type: Date,
			default: null,
		},
		pendingBackupCodes: [
			{
				codeHash: { type: String, required: true },
				used: { type: Boolean, default: false },
				usedAt: { type: Date, default: null },
			},
		],
		backupCodes: [
			{
				codeHash: { type: String, required: true },
				used: { type: Boolean, default: false },
				usedAt: { type: Date, default: null },
			},
		],
		updatedAt: {
			type: Date,
			default: Date.now,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model('AdminSettings', adminSettingsSchema);
