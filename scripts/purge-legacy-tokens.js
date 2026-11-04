#!/usr/bin/env node
/**
 * One-off: delete the pre-hashing OAuth token records.
 *
 * Before token hashing, access and refresh tokens were stored under the raw
 * token (`oauth:token:<token>`, `oauth:refresh:<token>`), so a dump of the
 * store handed out working credentials. Hashing moved new records to
 * `oauth:token:v2:` / `oauth:refresh:v2:`; the old records keep sitting there,
 * valid-looking, until their TTL runs out.
 *
 * Run this once at the deploy that ships hashing, so the store holds nothing
 * that looks like a live token. It deletes only the two legacy prefixes and
 * explicitly keeps the `:v2:` records, so running it again is harmless.
 *
 *   node scripts/purge-legacy-tokens.js
 *
 * Needs the same KV env as the app (KV_REST_API_URL/TOKEN or the UPSTASH pair).
 */
import { isPersistent, kvScanDelete } from '../src/oauth/kv.js';

async function main() {
  if (!isPersistent()) {
    console.error('No KV configured (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN). Nothing to purge.');
    process.exitCode = 1;
    return;
  }

  const removedTokens = await kvScanDelete('oauth:token:*', { excludePrefix: 'oauth:token:v2:' });
  const removedRefresh = await kvScanDelete('oauth:refresh:*', { excludePrefix: 'oauth:refresh:v2:' });
  console.log(`removed ${removedTokens} legacy access and ${removedRefresh} legacy refresh record(s).`);
  console.log('the hashed oauth:*:v2: records were left untouched.');
}

main().catch((err) => {
  console.error('purge failed:', err.message);
  process.exitCode = 1;
});
