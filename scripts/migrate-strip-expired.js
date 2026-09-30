/**
 * migrate-strip-expired.js — One-time migration to strip heavy/sensitive fields
 * from already-expired or already-deleted Transfer documents.
 *
 * Removes: qrDataUri, files[].inlineContent, passwordHash, ownershipToken
 * Retains: counters, sizes, mime types, timestamps, flags for all-time analytics.
 *
 * Usage: node scripts/migrate-strip-expired.js
 */
'use strict';

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('ERROR: MONGODB_URI environment variable is not set.');
    process.exit(1);
  }

  console.log('\n🧹 SwiftShare — Expired Transfer Retention Migration\n');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('✅ Connected to MongoDB');

  const db = mongoose.connection.db;
  const collection = db.collection('transfers');

  const now = new Date();
  const filter = {
    $or: [
      { isDeleted: true },
      { expiresAt: { $lt: now } },
    ],
  };

  const update = {
    $unset: {
      qrDataUri: '',
      passwordHash: '',
      ownershipToken: '',
      'files.$[].inlineContent': '',
    },
  };

  const matchingCount = await collection.countDocuments(filter);
  console.log(`Found ${matchingCount} expired/deleted transfer document(s) to clean.`);

  if (matchingCount > 0) {
    const result = await collection.updateMany(filter, update);
    console.log(`✅ Successfully updated ${result.modifiedCount} document(s).`);
  } else {
    console.log('No documents needed migration.');
  }

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.\n');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
