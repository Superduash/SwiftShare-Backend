/**
 * hash-admin-password.js — Generates a cost-12 bcrypt hash for SwiftShare Admin.
 *
 * Usage:
 *   node scripts/hash-admin-password.js
 *   or: npm run admin:hash
 */
'use strict';

const readline = require('readline');
const bcrypt = require('bcryptjs');

function promptPassword(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mask input in terminal if possible
    process.stdout.write(promptText);
    
    // Fallback standard line reading
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log('\n🔒 SwiftShare — Admin Password Hasher (bcrypt cost 12)\n');
  
  const password = await promptPassword('Enter new admin password: ');
  if (!password) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.warn('⚠️  Warning: Password is less than 8 characters long.');
  }

  console.log('\nGenerating hash (cost 12)...');
  const hash = await bcrypt.hash(password, 12);

  console.log('\n✅ Bcrypt Hash Generated Successfully:\n');
  console.log(`ADMIN_PASSWORD_HASH='${hash}'\n`);
  console.log('To apply:');
  console.log('1. Copy the line above into your Backend/.env or cloud deployment dashboard.');
  console.log('2. Ensure single quotes enclose the hash since it contains $ characters.');
  console.log('3. Restart the backend service. All existing admin sessions will be invalidated.\n');
}

main().catch((err) => {
  console.error('Failed to hash password:', err);
  process.exit(1);
});
