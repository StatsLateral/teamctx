import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';
import {
  __resetMemory, __resetSecrets, __rawGet, __rawSet, __dumpMemory,
  kvGet, kvSet, kvTake, keys, SECRET_PREFIXES, isSecretKey, secretsConfigured,
} from './kv.js';

beforeEach(() => { __resetMemory(); __resetSecrets(); });

describe('secrets at rest', () => {
  it('encrypts secret records; a raw dump holds none of them in the clear', async () => {
    await kvSet(keys.personalAiKey('x@e.com'), { apiKey: 'sk-ant-SECRET123', provider: 'anthropic' });
    await kvSet(keys.token('tok'), { githubToken: 'gho_SECRET456', clientId: 'c' });
    await kvSet(keys.slackWebhook('o', 'r'), { url: 'https://hooks.slack.com/SECRET789' });

    const dump = __dumpMemory();
    for (const secret of ['sk-ant-SECRET123', 'gho_SECRET456', 'SECRET789']) {
      expect(dump).not.toContain(secret);
    }
    // …yet every one reads back.
    expect((await kvGet(keys.personalAiKey('x@e.com'))).apiKey).toBe('sk-ant-SECRET123');
    expect((await kvGet(keys.token('tok'))).githubToken).toBe('gho_SECRET456');
    expect((await kvTake(keys.slackWebhook('o', 'r'))).url).toContain('SECRET789');
  });

  it('a non-secret record is still stored in the clear', async () => {
    await kvSet(keys.pending('state1'), { clientId: 'c', redirectUri: 'https://x' });
    expect(__dumpMemory()).toContain('https://x');
  });

  it('lists every secret-bearing key builder in SECRET_PREFIXES', () => {
    const secretKeys = [
      keys.personalAiKey('a@b.com'),
      keys.aiKey('4242'),
      keys.projectAiKey('o', 'r'),
      keys.projectAiKeys('o', 'r'),
      keys.agentAiKey('id'),
      keys.projectGhCred('o', 'r'),
      keys.slackWebhook('o', 'r'),
      keys.connectorToken('a@b.com', 'gdrive'),
      keys.token('t'),
      keys.refresh('t'),
      keys.tokenV2('h'),
      keys.refreshV2('h'),
      keys.code('c'),
      keys.consentPending('c'),
      keys.session('s'),
    ];
    for (const k of secretKeys) expect(isSecretKey(k), k).toBe(true);
    // The pending record carries no token, so it stays in the clear.
    expect(isSecretKey(keys.pending('s'))).toBe(false);
    // The connector index lists provider names only, no token.
    expect(isSecretKey(keys.connectorIndex('a@b.com'))).toBe(false);
    // Project connector shares and their index are pointers, not tokens.
    expect(isSecretKey(keys.projectConnectors('o', 'r'))).toBe(false);
    expect(isSecretKey(keys.connectorsSharedBy('a@b.com'))).toBe(false);
    // Family, replay and revocation records hold only hashes and ids.
    for (const k of [keys.tokenFamily('f'), keys.familyRevoked('f'), keys.usedRefresh('h')]) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });

  it('encrypts a sign-in held at the consent page, whose code record carries the token', async () => {
    await kvSet(keys.consentPending('ct'), { codeRecord: { githubToken: 'gho_CONSENTSECRET' }, clientId: 'c' });
    expect(__dumpMemory()).not.toContain('gho_CONSENTSECRET');
    expect((await kvGet(keys.consentPending('ct'))).codeRecord.githubToken).toBe('gho_CONSENTSECRET');
  });

  it('encrypts an authorization-code record that carries a GitHub token', async () => {
    await kvSet(keys.code('abc'), { githubToken: 'gho_CODESECRET', clientId: 'c' });
    expect(__dumpMemory()).not.toContain('gho_CODESECRET'); // not in the clear
    expect((await kvGet(keys.code('abc'))).githubToken).toBe('gho_CODESECRET');
  });

  it('reports whether an encryption key is configured', () => {
    const good = randomBytes(32).toString('base64');
    expect(secretsConfigured({ TEAMCTX_SECRET_KEYS: JSON.stringify({ k1: good }), TEAMCTX_SECRET_KEY_ACTIVE: 'k1' })).toBe(true);
    expect(secretsConfigured({})).toBe(false);                                   // nothing set
    expect(secretsConfigured({ TEAMCTX_SECRET_KEYS: JSON.stringify({ k1: good }) })).toBe(false); // no active kid
    expect(secretsConfigured({ TEAMCTX_SECRET_KEYS: 'not json', TEAMCTX_SECRET_KEY_ACTIVE: 'k1' })).toBe(false); // malformed
  });

  it('reads a pre-encryption plaintext secret and upgrades it on read', async () => {
    // Seed a legacy record straight into the store, bypassing encryption.
    await __rawSet(keys.aiKey('99'), { apiKey: 'sk-LEGACY' });
    expect(await __rawGet(keys.aiKey('99'))).toEqual({ apiKey: 'sk-LEGACY' }); // plain

    expect((await kvGet(keys.aiKey('99'))).apiKey).toBe('sk-LEGACY');          // still readable
    expect((await __rawGet(keys.aiKey('99'))).enc).toBe('v1');                 // now encrypted
  });

  it('keeps a legacy secret remaining TTL when it upgrades it on read', async () => {
    // A plaintext access token with an hour left, written before encryption.
    await __rawSet(keys.token('tok'), { githubToken: 'gho_x' }, { ttlSeconds: 3600 });
    await kvGet(keys.token('tok')); // reads and upgrades in place
    const [, rec] = JSON.parse(__dumpMemory()).find(([k]) => k === keys.token('tok'));
    expect(rec.value.enc).toBe('v1');   // now encrypted
    expect(rec.expiresAt).toBeTruthy(); // and still expires — not made immortal
    const secondsLeft = (rec.expiresAt - Date.now()) / 1000;
    expect(secondsLeft).toBeGreaterThan(3000);
    expect(secondsLeft).toBeLessThanOrEqual(3600);
  });

  it('refuses to store a secret on a real deployment with no key configured', async () => {
    const env = { KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'tok' }; // persistent, no secret key
    await expect(kvSet(keys.personalAiKey('a@b.com'), { apiKey: 'x' }, {}, env))
      .rejects.toThrow(/TEAMCTX_SECRET_KEYS/);
  });

  it('reads a record under an old key after a new one becomes active (rotation)', async () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    const withK1 = { TEAMCTX_SECRET_KEYS: JSON.stringify({ k1 }), TEAMCTX_SECRET_KEY_ACTIVE: 'k1' };
    await kvSet(keys.token('t'), { githubToken: 'g' }, {}, withK1);

    const withBoth = { TEAMCTX_SECRET_KEYS: JSON.stringify({ k1, k2 }), TEAMCTX_SECRET_KEY_ACTIVE: 'k2' };
    expect((await kvGet(keys.token('t'), withBoth)).githubToken).toBe('g'); // still readable under k1
  });

  it('drops a record it cannot decrypt rather than returning ciphertext', async () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    await kvSet(keys.token('t'), { githubToken: 'g' }, {}, { TEAMCTX_SECRET_KEYS: JSON.stringify({ k1 }), TEAMCTX_SECRET_KEY_ACTIVE: 'k1' });
    // A different key set entirely: the record is treated as absent.
    const wrong = { TEAMCTX_SECRET_KEYS: JSON.stringify({ k2 }), TEAMCTX_SECRET_KEY_ACTIVE: 'k2' };
    expect(await kvGet(keys.token('t'), wrong)).toBeNull();
  });
});
