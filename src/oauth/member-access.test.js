import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { __resetMemory, kvSet, keys } from './kv.js';
import { resolveGoogleMember, MemberAccessError } from './member-access.js';

const OWNER = 'acme';
const REPO = 'ledger';

const CONFIG = {
  project: 'Ledger',
  managerKey: 'github:1001',
  members: [
    { key: 'git:mia@example.com', name: 'Mia', login: null, email: 'Mia@Example.com' },
    { key: 'github:alex', name: 'Alex', login: 'alex', email: null },
  ],
};

const lend = (token = 'ghp-project') =>
  kvSet(keys.projectGhCred(OWNER, REPO), { token, lentById: '1001', lentByLogin: 'manager' });

/** GitHub's contents API shape: base64 in a `content` field. */
function mockConfigFetch(config = CONFIG, { ok = true, status = 200 } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok, status,
    json: async () => ({ content: Buffer.from(JSON.stringify(config)).toString('base64') }),
  }));
  globalThis.fetch = fetchMock;
  return fetchMock;
}

const google = (email, name = 'Mia') => ({ email, name, sub: 'g-1' });

beforeEach(() => __resetMemory());
afterEach(() => { vi.restoreAllMocks(); });

describe('a member who signed in with Google', () => {
  it('acts on the credential the project lent', async () => {
    await lend();
    mockConfigFetch();
    const r = await resolveGoogleMember({ googleUser: google('mia@example.com'), owner: OWNER, repo: REPO });
    expect(r.ghToken).toBe('ghp-project');
    expect(r.actor.name).toBe('Mia');
    // Their identity is the roster entry, so contributing from a clone and
    // contributing through an assistant come out as the same author.
    expect(r.actor.key).toBe('git:mia@example.com');
  });

  it('matches the roster regardless of how the address was capitalised', async () => {
    // The manager types the invite by hand; Google lowercases what it returns.
    await lend();
    mockConfigFetch();
    const r = await resolveGoogleMember({ googleUser: google('mia@example.com'), owner: OWNER, repo: REPO });
    expect(r.member.name).toBe('Mia');
  });

  it('is refused when the address is not on the roster', async () => {
    // Without this, any Google account anywhere is a member of every project
    // that lends a credential.
    await lend();
    mockConfigFetch();
    await expect(resolveGoogleMember({ googleUser: google('stranger@example.com'), owner: OWNER, repo: REPO }))
      .rejects.toThrow(MemberAccessError);
  });

  it('names the address it checked, since the usual mistake is the wrong Google account', async () => {
    await lend();
    mockConfigFetch();
    await expect(resolveGoogleMember({ googleUser: google('other@example.com'), owner: OWNER, repo: REPO }))
      .rejects.toThrow(/other@example\.com/);
  });

  it('is refused when the project has lent nothing', async () => {
    mockConfigFetch();
    await expect(resolveGoogleMember({ googleUser: google('mia@example.com'), owner: OWNER, repo: REPO }))
      .rejects.toThrow(/has not lent GitHub access/);
  });

  it('cannot reach a project other than the one the credential was lent to', async () => {
    // The pinning: the credential is looked up by the owner/repo in the URL,
    // which is otherwise unchecked. Reaching a second repo with it is the
    // failure this prevents.
    await lend();
    const fetchMock = mockConfigFetch();
    await expect(resolveGoogleMember({ googleUser: google('mia@example.com'), owner: OWNER, repo: 'secrets' }))
      .rejects.toThrow(/has not lent GitHub access/);
    expect(fetchMock, 'no repo should be read at all').not.toHaveBeenCalled();
  });

  it('does not match a member who has a login but no email', async () => {
    // Alex is on the roster as a GitHub user. A Google account claiming an
    // empty email field must not resolve to them.
    await lend();
    mockConfigFetch();
    await expect(resolveGoogleMember({ googleUser: google(''), owner: OWNER, repo: REPO }))
      .rejects.toThrow(MemberAccessError);
  });

  it('says so plainly when the lent credential has stopped working', async () => {
    await lend();
    mockConfigFetch(CONFIG, { ok: false, status: 401 });
    await expect(resolveGoogleMember({ googleUser: google('mia@example.com'), owner: OWNER, repo: REPO }))
      .rejects.toThrow(/can no longer read/);
  });
});

describe('the manager signing in with Google', () => {
  // The manager is not on their own roster and has no reason to be. Without
  // this they are turned away from their own project for signing in the way
  // they tell everyone else to.
  const MANAGED = { ...CONFIG, managerKey: 'git:ada@example.com' };

  it('is let in on the identity the gate already holds', async () => {
    // An email is the one identity every surface agrees on: a clone reads it
    // from git config, Google hands it over verified. So the gate pinned from
    // a laptop recognises the same person arriving through Google.
    await lend();
    mockConfigFetch(MANAGED);
    const r = await resolveGoogleMember({ googleUser: google('ada@example.com', 'Ada'), owner: OWNER, repo: REPO });
    expect(r.isManager).toBe(true);
    expect(r.actor.key).toBe('git:ada@example.com');
  });

  it('does not need a roster entry to get in', async () => {
    await lend();
    mockConfigFetch(MANAGED);
    const r = await resolveGoogleMember({ googleUser: google('ada@example.com'), owner: OWNER, repo: REPO });
    expect(r.member).toBe(null);
  });

  it('still refuses a Google account that is neither manager nor member', async () => {
    await lend();
    mockConfigFetch(MANAGED);
    await expect(resolveGoogleMember({ googleUser: google('stranger@example.com'), owner: OWNER, repo: REPO }))
      .rejects.toThrow(MemberAccessError);
  });

  it('resolves an ordinary member to the same email namespace', async () => {
    // Mia is on the roster as git:mia@example.com, so contributing from a
    // clone and through an assistant come out as one author.
    await lend();
    mockConfigFetch(MANAGED);
    const r = await resolveGoogleMember({ googleUser: google('mia@example.com'), owner: OWNER, repo: REPO });
    expect(r.isManager).toBeUndefined();
    expect(r.actor.key).toBe('git:mia@example.com');
  });
});
