/**
 * verify-indexes.js — Verifies required MongoDB indexes exist on the Transfer collection.
 *
 * Usage: node scripts/verify-indexes.js
 *
 * Checks for all indexes defined in Transfer.js and warns about any missing ones.
 * Safe to run in production — read-only operation.
 */
'use strict';

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

// Required indexes: [name, keySpec description]
const REQUIRED_INDEXES = [
  { name: 'code_1',        key: { code: 1 },        note: 'Primary lookup by transfer code' },
  { name: 'expiresAt_1',   key: { expiresAt: 1 },   note: 'TTL safety net (expireAfterSeconds)' },
  { name: 'createdAt_-1',  key: { createdAt: -1 },  note: 'Recency sort for stats/sender recents' },
  { name: 'cleanup_active',         note: 'isDeleted + expiresAt compound — cleanup sweep' },
  { name: 'nearby_active_by_subnet', note: 'isDeleted + expiresAt + senderIp + createdAt — nearby devices' },
  { name: 'cleanup_stale_burn',      note: 'burnAfterDownload + isDeleted + burnLastActiveAt — stale burn cleanup' },
  { name: 'nearby_sockets',          note: 'isDeleted + expiresAt + senderSocketId + createdAt — nearby sockets' },
  { name: 'ttl_post_expiry_safety_net', note: 'expiresAt TTL index — auto-delete 24h after expiry' },
  { name: 'senderSocketId_1',        note: 'senderSocketId sparse — socket cleanup' },
  { name: 'senderIp_1_createdAt_1',  note: 'senderIp + createdAt — stats distinct + IP lookups' },
];

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('ERROR: MONGODB_URI environment variable is not set.');
    process.exit(1);
  }

  console.log('\n📋 SwiftShare — MongoDB Index Verification\n');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('✅ Connected to MongoDB\n');

  const db = mongoose.connection.db;
  const existingIndexes = await db.collection('transfers').indexes();
  const existingNames = new Set(existingIndexes.map((idx) => idx.name));

  // Print all existing indexes
  console.log(`Found ${existingIndexes.length} existing index(es):`);
  for (const idx of existingIndexes) {
    const keys = JSON.stringify(idx.key);
    const extra = [];
    if (idx.expireAfterSeconds !== undefined) extra.push(`TTL=${idx.expireAfterSeconds}s`);
    if (idx.sparse) extra.push('sparse');
    if (idx.unique) extra.push('unique');
    console.log(`  ${idx.name.padEnd(38)} keys=${keys} ${extra.join(' ')}`);
  }

  console.log('\nVerifying required indexes…');
  let missing = 0;
  for (const req of REQUIRED_INDEXES) {
    const found = existingNames.has(req.name);
    const status = found ? '✅' : '❌ MISSING';
    console.log(`  ${status.padEnd(12)} ${req.name.padEnd(38)} ${req.note}`);
    if (!found) missing++;
  }

  if (missing === 0) {
    console.log('\n✅ All required indexes are present.\n');
  } else {
    console.error(`\n⚠️  ${missing} required index(es) are MISSING.`);
    console.error('   Run the application once to let Mongoose autoIndex create them,');
    console.error('   or apply them manually via mongosh.\n');
    process.exitCode = 1;
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
