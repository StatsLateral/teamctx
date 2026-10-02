/**
 * The person who made the project, coming back the other way.
 *
 * A project created through the web is gated on whoever made it. When GitHub
 * handed over their verified address that gate reads `git:<address>`, and a
 * Google sign-in with the same address matches it. When GitHub did not — a
 * private address, or a token without the scope — the gate reads `github:<id>`,
 * which a Google sign-in has no way to be. They were turned away from their own
 * project for arriving the way they tell everybody else to.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { __resetMemory, kvSet, keys } = await import('./kv.js');
const { resolveGoogleMember } = await import('./member-access.js');

const OWNER = 'acme';
const REPO = 'ledger';
const MAKER = { email: 'maya@example.com', name: 'Maya' };

const config = (over = {}) => ({
  project: 'Ledger',
  managerKey: 'github:4242',
  members: [],
  ...over,
});

function github(cfg) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: Buffer.from(JSON.stringify(cfg)).toString('base64') }),
  })));
}

beforeEach(async () => {
  __resetMemory();
  await kvSet(keys.projectGhCred(OWNER, REPO), { token: 'gh-lent' });
});

describe('a gate written as a GitHub id', () => {
  it('turns away somebody whose address has proved nothing', async () => {
    github(config());
    await expect(resolveGoogleMember({ googleUser: MAKER, owner: OWNER, repo: REPO }))
      .rejects.toThrow(/not on the acme\/ledger roster/);
  });

  it('recognises the account behind the address GitHub verified for it', async () => {
    github(config());
    await kvSet(keys.githubIdentities('maya@example.com'), { ids: ['4242'] });
    const r = await resolveGoogleMember({ googleUser: MAKER, owner: OWNER, repo: REPO });
    expect(r.isManager).toBe(true);
    expect(r.ghToken).toBe('gh-lent');
  });

  it('does not let one person inherit another account proof', async () => {
    github(config());
    await kvSet(keys.githubIdentities('someone-else@example.com'), { ids: ['4242'] });
    await expect(resolveGoogleMember({ googleUser: MAKER, owner: OWNER, repo: REPO }))
      .rejects.toThrow(/not on the acme\/ledger roster/);
  });

  it('still lets a plain roster member in, as before', async () => {
    github(config({ members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com' }] }));
    const r = await resolveGoogleMember({
      googleUser: { email: 'priya@example.com', name: 'Priya' }, owner: OWNER, repo: REPO,
    });
    expect(r.member.name).toBe('Priya');
  });

  it('needs no proof when the gate is already an address', async () => {
    github(config({ managerKey: 'git:maya@example.com' }));
    expect((await resolveGoogleMember({ googleUser: MAKER, owner: OWNER, repo: REPO })).isManager).toBe(true);
  });
});
