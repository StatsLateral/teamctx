import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { seal, open, isEnvelope, loadSecretKeys } from './secret-box.js';

const keys = { k1: randomBytes(32) };
const cfg = { keys, kid: 'k1' };

/** Flip the first byte of a base64url field. */
function flip(b64u) {
  const buf = Buffer.from(String(b64u), 'base64url');
  buf[0] ^= 0xff;
  return buf.toString('base64url');
}

describe('secret-box AES-256-GCM envelope', () => {
  it('round-trips a record', () => {
    const env = seal({ token: 'gho_x', n: 1 }, 'oauth:token:abc', cfg);
    expect(isEnvelope(env)).toBe(true);
    expect(env.ct).not.toContain('gho_x');
    expect(open(env, 'oauth:token:abc', { keys })).toEqual({ token: 'gho_x', n: 1 });
  });

  it('fails to open when ct, tag or iv is altered', () => {
    const env = seal({ token: 'gho_x' }, 'k', cfg);
    for (const field of ['ct', 'tag', 'iv']) {
      expect(() => open({ ...env, [field]: flip(env[field]) }, 'k', { keys }), field).toThrow();
    }
  });

  it('fails when the ciphertext is moved to another key name (AAD)', () => {
    const env = seal({ token: 'gho_x' }, 'oauth:token:A', cfg);
    expect(() => open(env, 'oauth:token:B', { keys })).toThrow();
  });

  it('fails with the wrong key', () => {
    const env = seal({ token: 'x' }, 'k', cfg);
    expect(() => open(env, 'k', { keys: { k1: randomBytes(32) } })).toThrow();
  });

  it('loads keys from env and rejects a key that is not 32 bytes', () => {
    const good = randomBytes(32).toString('base64');
    expect(loadSecretKeys({ TEAMCTX_SECRET_KEYS: JSON.stringify({ k1: good }) }).k1.length).toBe(32);
    expect(() => loadSecretKeys({ TEAMCTX_SECRET_KEYS: JSON.stringify({ k1: Buffer.from('short').toString('base64') }) })).toThrow(/32-byte/);
    expect(() => loadSecretKeys({ TEAMCTX_SECRET_KEYS: 'not json' })).toThrow(/valid JSON/);
  });
});
