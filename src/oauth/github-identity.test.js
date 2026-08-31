import { describe, it, expect, vi, afterEach } from 'vitest';
import { primaryEmail } from './github-identity.js';

const ok = (list) => { globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => list })); };
afterEach(() => { vi.restoreAllMocks(); });

describe("a GitHub account's email", () => {
  it('takes the verified primary address', async () => {
    ok([
      { email: 'old@example.com', primary: false, verified: true },
      { email: 'Ada@Example.com', primary: true, verified: true },
    ]);
    expect(await primaryEmail('t')).toBe('ada@example.com');
  });

  it('never takes an unverified address, even the primary one', async () => {
    // GitHub lets you add an address before confirming it. Treating one as
    // identity would let somebody claim a gate pinned to an email they do not
    // own — which is the whole thing the gate exists to stop.
    ok([
      { email: 'claimed@example.com', primary: true, verified: false },
      { email: 'real@example.com', primary: false, verified: true },
    ]);
    expect(await primaryEmail('t')).toBe('real@example.com');
  });

  it('returns nothing when no address is verified', async () => {
    ok([{ email: 'claimed@example.com', primary: true, verified: false }]);
    expect(await primaryEmail('t')).toBe(null);
  });

  it('falls back quietly when the token predates the user:email scope', async () => {
    // 403 is the ordinary answer for an older token. Returning null keeps that
    // session working on its numeric id rather than failing the request.
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    expect(await primaryEmail('t')).toBe(null);
  });

  it('survives a network error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    expect(await primaryEmail('t')).toBe(null);
  });
});
