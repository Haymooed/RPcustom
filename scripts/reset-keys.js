#!/usr/bin/env node
'use strict';

// Usage:
//   node scripts/reset-keys.js          → resets keys for all active subscribers
//   node scripts/reset-keys.js --force  → bypasses 24h cooldown check

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const { resetAllSubscriberKeys, saveLastReset, getLastReset } = require('../lib/keyReset');

const force = process.argv.includes('--force');
const last = getLastReset();
const hoursSince = last ? Math.round((Date.now() - last) / 3600000) : null;

if (!force && last && Date.now() - last < 24 * 60 * 60 * 1000) {
    console.log(`\n  Keys were last reset ${hoursSince}h ago. Run with --force to override.\n`);
    process.exit(0);
}

console.log('\n  Onyx Key Reset — Daily Subscriber Keys\n');
console.log('─'.repeat(52));
if (hoursSince !== null) console.log(`  Last reset: ${hoursSince}h ago`);

(async () => {
    try {
        const result = await resetAllSubscriberKeys(null);
        saveLastReset();
        console.log(`\n  ✓ Reset ${result.count}/${result.total} subscriber keys`);
        if (result.errors.length) {
            console.log(`  ✗ ${result.errors.length} errors:`);
            result.errors.forEach(e => console.log(`    - ${e.id}: ${e.error}`));
        }
        console.log('\n  Note: Discord DMs require the panel server to be running.\n');
    } catch (e) {
        console.error('\n  ✗ Reset failed:', e.message);
        process.exit(1);
    }
    console.log('─'.repeat(52) + '\n');
    process.exit(0);
})();
