#!/usr/bin/env node
/**
 * Re-encrypt every secret record under the active key.
 *
 * Rotation: add a new key id, set it active, deploy (new writes use it, old
 * records still read because the old key is still listed), then run this to move
 * the existing records onto the new key. Once it reports everything moved, drop
 * the old key id.
 *
 *   node scripts/rotate-secrets.js
 *
 * Needs the app's KV env, TEAMCTX_SECRET_KEY_ACTIVE set to the new id, and
 * TEAMCTX_SECRET_KEYS holding both the old and new keys.
 *
 * Note: a record is read and written back, so a record that carries a TTL (an
 * access or refresh token, a web session) has its TTL reset. Those are
 * short-lived and re-minted under the new key on their own, so rotation is
 * really for the long-lived secrets (AI keys, lent credentials, webhooks),
 * which carry no TTL.
 */
import { isPersistent, kvGet, kvSet, kvScanKeys, SECRET_PREFIXES, isSecretKey } from '../src/oauth/kv.js';

async function main() {
  if (!isPersistent()) {
    console.error('No KV configured. Nothing to rotate.');
    process.exitCode = 1;
    return;
  }
  if (!process.env.TEAMCTX_SECRET_KEY_ACTIVE) {
    console.error('Set TEAMCTX_SECRET_KEY_ACTIVE to the new key id before rotating.');
    process.exitCode = 1;
    return;
  }
  let moved = 0;
  for (const prefix of SECRET_PREFIXES) {
    const matched = (await kvScanKeys(`${prefix}*`)).filter(isSecretKey);
    for (const key of matched) {
      const value = await kvGet(key);           // decrypts under whichever key sealed it
      if (value === null) continue;             // absent or undecryptable — leave it
      await kvSet(key, value);                  // re-seals under the active key
      moved += 1;
    }
  }
  console.log(`re-encrypted ${moved} secret record(s) under the active key.`);
}

main().catch((err) => {
  console.error('rotation failed:', err.message);
  process.exitCode = 1;
});
