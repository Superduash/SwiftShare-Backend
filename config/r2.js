const { S3Client, HeadBucketCommand } = require("@aws-sdk/client-s3");

const required = [
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_BUCKET_NAME",
];

const isR2Configured = required.every((key) => Boolean(process.env[key]));

const r2Client = isR2Configured
	? new S3Client({
		region: process.env.R2_REGION || "auto",
		endpoint:
			process.env.R2_ENDPOINT ||
			`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY_ID,
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
		},
	})
	: null;

async function checkR2Connection() {
	if (!isR2Configured || !r2Client) {
		return false;
	}

	try {
		await r2Client.send(
			new HeadBucketCommand({
				Bucket: process.env.R2_BUCKET_NAME,
			}),
		);
		return true;
	} catch (error) {
		return false;
	}
}

module.exports = {
	r2Client,
	r2Bucket: process.env.R2_BUCKET_NAME || "",
	isR2Configured,
	checkR2Connection,
};

