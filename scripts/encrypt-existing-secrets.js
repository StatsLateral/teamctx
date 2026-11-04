#!/usr/bin/env node
/**
 * One-off: encrypt the secret records written before encryption-at-rest.
 *
 * `kvGet` already upgrades a plaintext secret the first time it is read, so the
 * store heals itself over time. This does the rest in one pass at deploy, so a
 * backup taken straight after holds no plaintext.
 *
 *   node scripts/encrypt-existing-secrets.js
 *
 * Needs the app's KV env and a configured key (TEAMCTX_SECRET_KEYS +
 * TEAMCTX_SECRET_KEY_ACTIVE); reading a plaintext record re-writes it encrypted.
 */
import { isPersistent, kvGet, kvScanKeys, SECRET_PREFIXES, isSecretKey } from '../src/oauth/kv.js';

async function main() {
  if (!isPersistent()) {
    console.error('No KV configured. Nothing to encrypt.');
    process.exitCode = 1;
    return;
  }
  let seen = 0;
  for (const prefix of SECRET_PREFIXES) {
    const matched = (await kvScanKeys(`${prefix}*`)).filter(isSecretKey);
    for (const key of matched) {
      // Reading upgrades a legacy plaintext record; an already-encrypted one is
      // returned unchanged.
      await kvGet(key);
      seen += 1;
    }
    console.log(`swept ${matched.length} under ${prefix}*`);
  }
  console.log(`read ${seen} secret record(s); any that were plaintext are now encrypted.`);
}

main().catch((err) => {
  console.error('encrypt pass failed:', err.message);
  process.exitCode = 1;
});
