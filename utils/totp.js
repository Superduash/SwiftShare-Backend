'use strict';

const crypto = require('crypto');
const qrcode = require('qrcode');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a Buffer to a Base32 string (RFC 4648)
 */
function base32Encode(buffer) {
	let bits = 0;
	let value = 0;
	let output = '';

	for (let i = 0; i < buffer.length; i++) {
		value = (value << 8) | buffer[i];
		bits += 8;

		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}

	if (bits > 0) {
		output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}

	return output;
}

/**
 * Decode a Base32 string to a Buffer (RFC 4648)
 */
function base32Decode(str) {
	const clean = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
	let bits = 0;
	let value = 0;
	const output = [];

	for (let i = 0; i < clean.length; i++) {
		const val = BASE32_ALPHABET.indexOf(clean[i]);
		if (val === -1) continue;

		value = (value << 5) | val;
		bits += 5;

		if (bits >= 8) {
			output.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}

	return Buffer.from(output);
}

/**
 * Generate a cryptographically secure Base32 secret for TOTP (20 bytes = 160 bits)
 */
function generateSecret(length = 20) {
	const randomBytes = crypto.randomBytes(length);
	return base32Encode(randomBytes);
}

/**
 * Generate a 6-digit TOTP token for a given counter
 */
function generateHOTP(secretBuffer, counter) {
	const buf = Buffer.alloc(8);
	buf.writeBigInt64BE(BigInt(counter));

	const hmac = crypto.createHmac('sha1', secretBuffer).update(buf).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;

	return String(code).padStart(6, '0');
}

/**
 * Verify a 6-digit TOTP token with a ±1 window (covering current, -30s, +30s clock drift)
 */
function verifyTOTP(token, secret, window = 1, timeStep = 30) {
	const cleanToken = String(token || '').trim();
	if (!/^\d{6}$/.test(cleanToken)) return false;

	const secretBuffer = base32Decode(secret);
	if (!secretBuffer || secretBuffer.length === 0) return false;

	const epoch = Math.floor(Date.now() / 1000);
	const currentCounter = Math.floor(epoch / timeStep);

	for (let i = -window; i <= window; i++) {
		const expectedCode = generateHOTP(secretBuffer, currentCounter + i);
		if (crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(expectedCode))) {
			return true;
		}
	}

	return false;
}

/**
 * Generate an otpauth:// URL for authenticator apps
 */
function getOtpAuthUrl(secret, label = 'Admin', issuer = 'SwiftShare') {
	const encodedIssuer = encodeURIComponent(issuer);
	const encodedLabel = encodeURIComponent(label);
	return `otpauth://totp/${encodedIssuer}:${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Generate a QR code data URI from the otpauth URL
 */
async function generateQrCodeDataUri(otpAuthUrl) {
	return qrcode.toDataURL(otpAuthUrl, {
		width: 256,
		margin: 2,
		color: {
			dark: '#000000',
			light: '#FFFFFF',
		},
	});
}

/**
 * Generate 8 random backup recovery codes (format: XXXX-XXXX)
 */
function generateBackupCodes(count = 8) {
	const codes = [];
	for (let i = 0; i < count; i++) {
		const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
		const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
		codes.push(`${part1}-${part2}`);
	}
	return codes;
}

module.exports = {
	base32Encode,
	base32Decode,
	generateHOTP,
	generateSecret,
	verifyTOTP,
	getOtpAuthUrl,
	generateQrCodeDataUri,
	generateBackupCodes,
};
