import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, kvGet, kvSet, kvScanDelete, keys } from './kv.js';
import { tokenHash } from './provider.js';

describe('purging the legacy plaintext token records', () => {
  beforeEach(() => __resetMemory());

  it('deletes the raw-key records and keeps the hashed v2 ones', async () => {
    // Legacy records, under the raw token.
    await kvSet(keys.token('aaa'), { clientId: 'c' });
    await kvSet(keys.refresh('bbb'), { clientId: 'c' });
    // Live hashed records, under the v2 prefix.
    await kvSet(keys.tokenV2(tokenHash('live')), { clientId: 'c', resource: null });
    await kvSet(keys.refreshV2(tokenHash('live')), { clientId: 'c', resource: null });

    const removedAccess = await kvScanDelete('oauth:token:*', { excludePrefix: 'oauth:token:v2:' });
    const removedRefresh = await kvScanDelete('oauth:refresh:*', { excludePrefix: 'oauth:refresh:v2:' });

    expect(removedAccess).toBe(1);
    expect(removedRefresh).toBe(1);
    // Legacy gone…
    expect(await kvGet(keys.token('aaa'))).toBeNull();
    expect(await kvGet(keys.refresh('bbb'))).toBeNull();
    // …hashed records untouched.
    expect(await kvGet(keys.tokenV2(tokenHash('live')))).toBeTruthy();
    expect(await kvGet(keys.refreshV2(tokenHash('live')))).toBeTruthy();
  });

  it('is a no-op the second time', async () => {
    await kvSet(keys.token('aaa'), { clientId: 'c' });
    await kvScanDelete('oauth:token:*', { excludePrefix: 'oauth:token:v2:' });
    expect(await kvScanDelete('oauth:token:*', { excludePrefix: 'oauth:token:v2:' })).toBe(0);
  });
});
