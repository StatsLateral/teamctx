import { describe, it, expect, vi, afterEach } from 'vitest';
import { googleUserFromCode, googleAuthorizeUrl, GoogleAuthError } from './google.js';

const CREDS = {
  code: 'g-code', clientId: 'gid', clientSecret: 'gsecret',
  redirectUri: 'https://teamctx.example/oauth/google/callback',
};

/** Token exchange, then userinfo — the two calls the flow makes, in order. */
function mockGoogle(profile, { tokenOk = true } = {}) {
  globalThis.fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => (tokenOk ? { access_token: 'g-at' } : { error_description: 'bad code' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => profile });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('signing in with Google', () => {
  it('returns the verified address, lowercased', async () => {
    // The roster is matched on this, and addresses are case-insensitive.
    mockGoogle({ email: 'Mia@Example.com', email_verified: true, name: 'Mia', sub: '42' });
    const u = await googleUserFromCode(CREDS);
    expect(u.email).toBe('mia@example.com');
    expect(u.name).toBe('Mia');
  });

  it('refuses an address Google has not verified', async () => {
    // A Google account can be created against an address its holder does not
    // control. Accepting it would let anyone claim someone else's invite, which
    // is the single thing this flow exists to prevent.
    mockGoogle({ email: 'mia@example.com', email_verified: false, name: 'Not Mia' });
    await expect(googleUserFromCode(CREDS)).rejects.toThrow(/has not verified/);
  });

  it('refuses an account with no address at all', async () => {
    mockGoogle({ email_verified: true, name: 'Nobody' });
    await expect(googleUserFromCode(CREDS)).rejects.toThrow(GoogleAuthError);
  });

  it('reports a failed code exchange rather than continuing', async () => {
    mockGoogle({}, { tokenOk: false });
    await expect(googleUserFromCode(CREDS)).rejects.toThrow(/bad code/);
  });

  it('asks which account, instead of taking whichever the browser prefers', async () => {
    // Someone signed in to several Google accounts would otherwise be
    // authenticated silently as the wrong one — and for an invite matched on
    // address, that is the difference between joining and being turned away.
    const url = googleAuthorizeUrl({ clientId: 'gid', redirectUri: CREDS.redirectUri, state: 's-1' });
    expect(new URL(url).searchParams.get('prompt')).toBe('select_account');
    expect(new URL(url).searchParams.get('state')).toBe('s-1');
  });

  it('asks for identity scopes only', async () => {
    const scope = new URL(googleAuthorizeUrl({ clientId: 'g', redirectUri: 'x', state: 's' }))
      .searchParams.get('scope');
    expect(scope).toBe('openid email profile');
  });
});
