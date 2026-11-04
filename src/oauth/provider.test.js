import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TeamctxOAuthProvider, providerFromEnv, oauthConfigStatus, tokenHash, validateClientRegistration } from './provider.js';
import { __resetMemory, kvGet, kvSet, keys } from './kv.js';
import { consentPage } from '../views/consent.js';

const BASE = 'https://teamctx.example';

function makeProvider() {
  return new TeamctxOAuthProvider({
    githubClientId: 'gh-client',
    githubClientSecret: 'gh-secret',
    baseUrl: BASE,
  });
}

const CLIENT = {
  client_id: 'claude-client',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
};

/**
 * Assert a call rejects with a specific OAuth error code. The code is what
 * ends up on the wire and what Claude branches on — the prose is not.
 */
async function expectOAuthError(promise, code) {
  let caught;
  try { await promise; } catch (e) { caught = e; }
  expect(caught, 'expected the call to reject').toBeDefined();
  expect(caught.errorCode).toBe(code);
}

/** Captures whatever `authorize()` redirects to, and the cookies it sets. */
function fakeRes() {
  return {
    redirectedTo: null, headers: {},
    redirect(url) { this.redirectedTo = url; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
  };
}

/** The value of one cookie from a Set-Cookie header. */
function cookieValue(setCookie, name) {
  const m = String(setCookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

/**
 * Drive authorize → GitHub callback → consent and return our authorization
 * code, binding the browser. The callback now lands on the consent page the
 * first time, so by default this approves to reach the code; `approve: false`
 * cancels, and a flow whose client is already approved skips the page.
 */
async function runAuthFlow(provider, { fetchMock, params = {}, bind, approve = true } = {}) {
  const res = fakeRes();
  await provider.authorize(CLIENT, {
    redirectUri: CLIENT.redirect_uris[0],
    codeChallenge: 'challenge-abc',
    state: 'claude-state',
    scopes: ['mcp:tools'],
    ...params,
  }, res);

  const state = new URL(res.redirectedTo).searchParams.get('state');
  // The nonce the browser would carry back on the callback, unless the test
  // overrides it to simulate another browser.
  const carried = bind === undefined ? cookieValue(res.headers['set-cookie'], 'teamctx_bind') : bind;
  if (fetchMock) vi.stubGlobal('fetch', fetchMock);
  const back = await provider.handleGithubCallback({ code: 'gh-code', state, bind: carried });

  const url = new URL(back);
  if (url.pathname === '/oauth/consent') {
    const c = url.searchParams.get('c');
    const final = approve
      ? await provider.approveConsent(c, carried)
      : await provider.denyConsent(c);
    return { redirectedTo: res.redirectedTo, consentUrl: back, back: final, code: new URL(final).searchParams.get('code') };
  }
  return { redirectedTo: res.redirectedTo, back, code: url.searchParams.get('code') };
}

/** Happy-path GitHub: token exchange then profile lookup. */
function githubHappyPath({ email, emails } = {}) {
  return vi.fn(async (url) => {
    if (String(url).includes('login/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'gho_realtoken' }) };
    }
    // Checked before `/user`, which it would otherwise match as a prefix.
    if (String(url).includes('api.github.com/user/emails')) {
      return emails
        ? { ok: true, json: async () => emails }
        // The ordinary answer for a token minted before `user:email` was asked
        // for, which is what the rest of these tests are exercising.
        : { ok: false, status: 403, json: async () => ({}) };
    }
    if (String(url).includes('api.github.com/user')) {
      return { ok: true, json: async () => ({ id: 4242, login: 'satyagyasingh', name: 'Satya', ...(email ? { email } : {}) }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => __resetMemory());
afterEach(() => vi.unstubAllGlobals());

describe('authorize', () => {
  it('redirects to GitHub with our callback, scopes and a fresh state', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, {
      redirectUri: CLIENT.redirect_uris[0],
      codeChallenge: 'challenge-abc',
      state: 'claude-state',
    }, res);

    const url = new URL(res.redirectedTo);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-client');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/github/callback`);
    expect(url.searchParams.get('scope')).toContain('repo');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('stashes the PKCE challenge and client state against that state key', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, {
      redirectUri: CLIENT.redirect_uris[0],
      codeChallenge: 'challenge-abc',
      state: 'claude-state',
    }, res);

    const state = new URL(res.redirectedTo).searchParams.get('state');
    const pending = await kvGet(keys.pending(state));
    expect(pending).toMatchObject({
      clientId: 'claude-client',
      codeChallenge: 'challenge-abc',
      clientState: 'claude-state',
    });
  });

  it('does not leak the client state into the GitHub URL', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, {
      redirectUri: CLIENT.redirect_uris[0],
      codeChallenge: 'c',
      state: 'claude-state',
    }, res);
    expect(res.redirectedTo).not.toContain('claude-state');
  });
});

describe('handleGithubCallback', () => {
  it('exchanges the GitHub code and redirects back to the client with our code', async () => {
    const provider = makeProvider();
    const { back, code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });

    expect(back.startsWith('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(new URL(back).searchParams.get('state')).toBe('claude-state');
    expect(code).toBeTruthy();
  });

  it('stores the GitHub token and profile against our code, never the client', async () => {
    const provider = makeProvider();
    const { back, code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });

    // The GitHub token must not travel back to Claude.
    expect(back).not.toContain('gho_realtoken');

    const record = await kvGet(keys.code(code));
    expect(record.githubToken).toBe('gho_realtoken');
    expect(record.githubUser).toMatchObject({ id: '4242', login: 'satyagyasingh' });
  });

  it('records the account the address has proved, for a manager who never opens the web app', async () => {
    // A project can be set up entirely through an assistant. Nothing on this
    // path renders a page, so if the link between address and account is only
    // written by the settings page, it is never written for these people — and
    // the gate on their own project, keyed by GitHub id, turns them away when
    // they later sign in with Google.
    const provider = makeProvider();
    await runAuthFlow(provider, { fetchMock: githubHappyPath({ email: 'Satya@Example.com' }) });
    expect((await kvGet(keys.githubIdentities('satya@example.com')))?.ids).toEqual(['4242']);
  });

  it('falls back to the primary verified address when the profile shows none', async () => {
    const provider = makeProvider();
    await runAuthFlow(provider, {
      fetchMock: githubHappyPath({
        emails: [
          { email: 'old@example.com', primary: false, verified: true },
          { email: 'Satya@Example.com', primary: true, verified: true },
        ],
      }),
    });
    expect((await kvGet(keys.githubIdentities('satya@example.com')))?.ids).toEqual(['4242']);
  });

  it('will not link an address GitHub has not confirmed, even a primary one', async () => {
    // This address is what a later Google sign-in matches a `github:<id>` gate
    // by. GitHub lets you add an address before confirming it, so accepting an
    // unverified one would let somebody claim a gate pinned to an email they do
    // not own — the whole point of the link.
    const provider = makeProvider();
    await runAuthFlow(provider, {
      fetchMock: githubHappyPath({
        emails: [{ email: 'notmine@example.com', primary: true, verified: false }],
      }),
    });
    expect(await kvGet(keys.githubIdentities('notmine@example.com'))).toBe(null);
  });

  it('rejects a state that was already consumed (replay)', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, { redirectUri: CLIENT.redirect_uris[0], codeChallenge: 'c' }, res);
    const state = new URL(res.redirectedTo).searchParams.get('state');
    const bind = cookieValue(res.headers['set-cookie'], 'teamctx_bind');

    vi.stubGlobal('fetch', githubHappyPath());
    await provider.handleGithubCallback({ code: 'gh-code', state, bind });
    await expect(provider.handleGithubCallback({ code: 'gh-code', state, bind }))
      .rejects.toThrow(/expired or was already used/);
  });

  it('refuses a callback from a browser that did not start the flow (no or wrong cookie)', async () => {
    const provider = makeProvider();
    // No cookie at all.
    await expect(runAuthFlow(provider, { fetchMock: githubHappyPath(), bind: null }))
      .rejects.toThrow(/another browser/);
    // A different browser's cookie.
    await expect(runAuthFlow(provider, { fetchMock: githubHappyPath(), bind: 'someone-elses-nonce' }))
      .rejects.toThrow(/another browser/);
  });

  it('propagates a GitHub denial back to the client as an OAuth error', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, {
      redirectUri: CLIENT.redirect_uris[0], codeChallenge: 'c', state: 'claude-state',
    }, res);
    const state = new URL(res.redirectedTo).searchParams.get('state');

    const back = await provider.handleGithubCallback({
      state, error: 'access_denied', errorDescription: 'The user declined',
    });
    const url = new URL(back);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('claude-state');
  });

  it('surfaces a failed GitHub token exchange', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, { redirectUri: CLIENT.redirect_uris[0], codeChallenge: 'c' }, res);
    const state = new URL(res.redirectedTo).searchParams.get('state');
    const bind = cookieValue(res.headers['set-cookie'], 'teamctx_bind');

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ error: 'bad_verification_code', error_description: 'expired' }),
    })));
    await expect(provider.handleGithubCallback({ code: 'x', state, bind })).rejects.toThrow(/expired/);
  });
});

describe('token exchange', () => {
  it('returns the PKCE challenge recorded at the start of the flow', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    expect(await provider.challengeForAuthorizationCode(CLIENT, code)).toBe('challenge-abc');
  });

  it('issues an access token and a refresh token', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    expect(tokens.token_type).toBe('bearer');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBeGreaterThan(0);
  });

  it('burns the authorization code — a second exchange fails', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    await provider.exchangeAuthorizationCode(CLIENT, code);
    await expectOAuthError(provider.exchangeAuthorizationCode(CLIENT, code), 'invalid_grant');
  });

  it('refuses a code that was issued to a different client', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    await expectOAuthError(
      provider.exchangeAuthorizationCode({ client_id: 'someone-else' }, code), 'invalid_grant');
  });

  it('refuses a redirect_uri that differs from the authorization request', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    await expectOAuthError(
      provider.exchangeAuthorizationCode(CLIENT, code, 'verifier', 'https://evil.example/cb'),
      'invalid_grant');
  });

  it('accepts the matching redirect_uri', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    const tokens = await provider.exchangeAuthorizationCode(
      CLIENT, code, 'verifier', CLIENT.redirect_uris[0]);
    expect(tokens.access_token).toBeTruthy();
  });

  it('rotates the refresh token and invalidates the old one', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    const first = await provider.exchangeAuthorizationCode(CLIENT, code);

    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    await expectOAuthError(
      provider.exchangeRefreshToken(CLIENT, first.refresh_token), 'invalid_grant');
  });

  it('carries the GitHub token across a refresh', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    const first = await provider.exchangeAuthorizationCode(CLIENT, code);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token);

    const auth = await provider.verifyAccessToken(second.access_token);
    expect(auth.extra.githubToken).toBe('gho_realtoken');
  });
});

describe('a refresh and the GitHub sign-in behind it', () => {
  const signedIn = async (provider) => {
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    return provider.exchangeAuthorizationCode(CLIENT, code);
  };

  it('refuses to refresh once GitHub no longer accepts the sign-in, so the client has to sign in again', async () => {
    // Refreshing used to carry a dead GitHub token forward for the whole life of the
    // refresh token, 90 days, and the connector stayed broken with nothing to tell
    // the client to start over.
    const provider = makeProvider();
    const first = await signedIn(provider);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) })));
    await expectOAuthError(provider.exchangeRefreshToken(CLIENT, first.refresh_token), 'invalid_grant');
    // And it is not left usable.
    await expectOAuthError(provider.exchangeRefreshToken(CLIENT, first.refresh_token), 'invalid_grant');
  });

  it('keeps the connection when GitHub is merely unreachable or erroring', async () => {
    const provider = makeProvider();
    const first = await signedIn(provider);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect((await provider.exchangeRefreshToken(CLIENT, first.refresh_token)).access_token).toBeTruthy();
    const again = await signedIn(provider);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
    expect((await provider.exchangeRefreshToken(CLIENT, again.refresh_token)).access_token).toBeTruthy();
  });

  it('does not ask GitHub about a sign-in that never had a GitHub token', async () => {
    const provider = makeProvider();
    await kvSet(keys.refreshV2(tokenHash('google-refresh')), { clientId: CLIENT.client_id, googleUser: { email: 'p@example.com' }, scopes: [], family: 'fam-google' });
    const spy = vi.fn(async () => { throw new Error('GitHub must not be asked'); });
    vi.stubGlobal('fetch', spy);
    const tokens = await provider.exchangeRefreshToken(CLIENT, 'google-refresh');
    expect(tokens.access_token).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('records when GitHub signed the person in, and keeps it across refreshes', async () => {
    const provider = makeProvider();
    const first = await signedIn(provider);
    const before = (await provider.verifyAccessToken(first.access_token)).extra.githubSignedInAt;
    expect(Number.isNaN(Date.parse(before))).toBe(false);
    vi.stubGlobal('fetch', githubHappyPath());
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token);
    expect((await provider.verifyAccessToken(second.access_token)).extra.githubSignedInAt).toBe(before);
  });
});

describe('verifyAccessToken', () => {
  it('returns AuthInfo carrying the GitHub token and profile', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth.clientId).toBe('claude-client');
    expect(auth.extra.githubToken).toBe('gho_realtoken');
    expect(auth.extra.githubUser.login).toBe('satyagyasingh');
  });

  it('rejects an unknown token', async () => {
    await expectOAuthError(makeProvider().verifyAccessToken('nope'), 'invalid_token');
  });

  it('rejects a revoked token', async () => {
    const provider = makeProvider();
    const { code } = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    await provider.revokeToken(CLIENT, { token: tokens.access_token });
    await expectOAuthError(provider.verifyAccessToken(tokens.access_token), 'invalid_token');
  });
});

describe('clientsStore', () => {
  it('round-trips a dynamically registered client', async () => {
    const provider = makeProvider();
    await provider.clientsStore.registerClient({ client_id: 'abc', redirect_uris: ['https://x/cb'] });
    expect((await provider.clientsStore.getClient('abc')).redirect_uris).toEqual(['https://x/cb']);
  });

  it('returns undefined for an unknown client', async () => {
    expect(await makeProvider().clientsStore.getClient('ghost')).toBeUndefined();
  });

  it('accepts https and loopback http redirect URIs', async () => {
    const provider = makeProvider();
    await provider.clientsStore.registerClient({ client_id: 'a', redirect_uris: ['https://claude.ai/cb', 'http://127.0.0.1:5173/cb', 'http://localhost/cb'] });
    expect((await provider.clientsStore.getClient('a')).redirect_uris.length).toBe(3);
  });

  it('refuses a redirect that cannot belong to a real client', async () => {
    const provider = makeProvider();
    const bad = [
      'http://evil.example/cb',           // http to a non-loopback host
      'javascript:alert(1)',              // scheme that could execute in a browser
      'https://user:pass@claude.ai/cb',   // userinfo
      'https://claude.ai/cb#frag',        // fragment
    ];
    for (const uri of bad) {
      await expectOAuthError(provider.clientsStore.registerClient({ client_id: 'x', redirect_uris: [uri] }), 'invalid_client_metadata');
    }
  });

  it('accepts a native client private-use scheme (VS Code, Cursor), but not a browser scheme', async () => {
    const provider = makeProvider();
    await provider.clientsStore.registerClient({ client_id: 'native', redirect_uris: ['vscode://anthropic.claude/auth', 'cursor://auth/callback'] });
    expect((await provider.clientsStore.getClient('native')).redirect_uris.length).toBe(2);
    for (const uri of ['data:text/html,x', 'file:///etc/passwd', 'vbscript:msgbox']) {
      await expectOAuthError(provider.clientsStore.registerClient({ client_id: 'bad', redirect_uris: [uri] }), 'invalid_client_metadata');
    }
  });

  it('caps the number of redirect URIs', async () => {
    const provider = makeProvider();
    const uris = Array.from({ length: 11 }, (_, i) => `https://c.example/cb${i}`);
    await expectOAuthError(provider.clientsStore.registerClient({ client_id: 'x', redirect_uris: uris }), 'invalid_client_metadata');
  });

  it('bounds and strips the client name shown on the consent page', async () => {
    const provider = makeProvider();
    await provider.clientsStore.registerClient({
      client_id: 'n', redirect_uris: ['https://c.example/cb'],
      client_name: 'Ev\u0007il<script>' + 'x'.repeat(200),
    });
    const name = (await provider.clientsStore.getClient('n')).client_name;
    expect(name).not.toContain('\u0007');
    expect(name.length).toBe(100);
  });

  it('honours TEAMCTX_ALLOWED_REDIRECT_HOSTS when set, always allowing loopback', () => {
    const env = { TEAMCTX_ALLOWED_REDIRECT_HOSTS: 'claude.ai, chatgpt.com' };
    expect(() => validateClientRegistration({ client_id: 'a', redirect_uris: ['https://claude.ai/cb'] }, env)).not.toThrow();
    expect(() => validateClientRegistration({ client_id: 'a', redirect_uris: ['http://127.0.0.1/cb'] }, env)).not.toThrow();
    expect(() => validateClientRegistration({ client_id: 'a', redirect_uris: ['https://evil.example/cb'] }, env)).toThrow();
  });
});

describe('providerFromEnv', () => {
  it('builds a provider when everything is present', () => {
    expect(providerFromEnv({
      GITHUB_OAUTH_CLIENT_ID: 'a',
      GITHUB_OAUTH_CLIENT_SECRET: 'b',
      TEAMCTX_BASE_URL: BASE,
    })).toBeInstanceOf(TeamctxOAuthProvider);
  });

  it('returns null when configuration is incomplete', () => {
    expect(providerFromEnv({ GITHUB_OAUTH_CLIENT_ID: 'a' })).toBeNull();
    expect(providerFromEnv({})).toBeNull();
  });

  it('falls back to the Vercel-provided URL', () => {
    const p = providerFromEnv({
      GITHUB_OAUTH_CLIENT_ID: 'a',
      GITHUB_OAUTH_CLIENT_SECRET: 'b',
      VERCEL_PROJECT_PRODUCTION_URL: 'teamctx.vercel.app',
    });
    expect(p.githubCallbackUrl).toBe('https://teamctx.vercel.app/oauth/github/callback');
  });

  it('reports which settings are missing', () => {
    expect(oauthConfigStatus({ GITHUB_OAUTH_CLIENT_ID: 'a' })).toEqual({
      githubClientId: true, githubClientSecret: false, baseUrl: false,
      googleClientId: false, googleClientSecret: false,
    });
  });

  it('reports Google, whose absence is otherwise silent', () => {
    // Without it `/authorize` skips the sign-in chooser and goes straight to
    // GitHub, which looks like the chooser is broken rather than switched off.
    const on = oauthConfigStatus({ GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 's' });
    expect(on.googleClientId).toBe(true);
    expect(on.googleClientSecret).toBe(true);
  });
});

describe('AI key storage', () => {
  it('is keyed by GitHub user id, separate from the OAuth token', async () => {
    await kvSet(keys.aiKey('4242'), { provider: 'anthropic', apiKey: 'sk-ant-xyz' });
    expect((await kvGet(keys.aiKey('4242'))).apiKey).toBe('sk-ant-xyz');
    expect(await kvGet(keys.aiKey('9999'))).toBeNull();
  });
});

describe('signing in through Google does not claim a project', () => {
  // The connector URL names a project, but nothing at sign-in says the person is
  // on it. The project is recorded by the endpoint once the roster confirms them.
  beforeEach(() => __resetMemory());
  afterEach(() => vi.unstubAllGlobals());

  it('records nothing against the address at sign-in', async () => {
    const provider = new TeamctxOAuthProvider({
      githubClientId: 'gh-client', githubClientSecret: 'gh-secret', baseUrl: BASE,
      googleClientId: 'g-client', googleClientSecret: 'g-secret',
    });
    const res = fakeRes();
    await provider.authorize(CLIENT, {
      redirectUri: CLIENT.redirect_uris[0], codeChallenge: 'c', state: 's', scopes: ['mcp:tools'],
      resource: new URL(`${BASE}/api/mcp/Acme/ledger`),
    }, res);
    const state = new URL(res.redirectedTo).searchParams.get('state');
    const bind = cookieValue(res.headers['set-cookie'], 'teamctx_bind');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => ({ access_token: 'g' }) };
      return { ok: true, json: async () => ({ email: 'Priya@Example.com', email_verified: true, name: 'Priya' }) };
    }));
    await provider.handleGoogleCallback({ code: 'code', state, bind });
    expect(await kvGet(keys.connectedProjects('priya@example.com'))).toBe(null);
  });
});

describe('consent before a client is first let in', () => {
  it('shows the consent page and issues no code until the user approves', async () => {
    const provider = makeProvider();
    const { consentUrl, back, code } = await runAuthFlow(provider, { fetchMock: githubHappyPath(), approve: true });
    expect(consentUrl).toMatch(/\/oauth\/consent\?c=/);
    expect(code).toBeTruthy();
    expect(back.startsWith('https://claude.ai')).toBe(true);
  });

  it('cancelling returns access_denied and no code', async () => {
    const provider = makeProvider();
    const { back, code } = await runAuthFlow(provider, { fetchMock: githubHappyPath(), approve: false });
    expect(new URL(back).searchParams.get('error')).toBe('access_denied');
    expect(code).toBeNull();
  });

  it('skips the page for the same client and origin the second time', async () => {
    const provider = makeProvider();
    const first = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    expect(first.consentUrl).toBeTruthy();
    const second = await runAuthFlow(provider, { fetchMock: githubHappyPath() });
    expect(second.consentUrl).toBeUndefined();
    expect(second.code).toBeTruthy();
  });

  it('requires the approval to come from the browser that signed in', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, { redirectUri: CLIENT.redirect_uris[0], codeChallenge: 'c', state: 's' }, res);
    const state = new URL(res.redirectedTo).searchParams.get('state');
    const bind = cookieValue(res.headers['set-cookie'], 'teamctx_bind');
    vi.stubGlobal('fetch', githubHappyPath());
    const back = await provider.handleGithubCallback({ code: 'gh-code', state, bind });
    const c = new URL(back).searchParams.get('c');
    await expect(provider.approveConsent(c, 'another-browser')).rejects.toThrow(/browser/);
  });

  it('escapes a hostile client name and shows the redirect host', () => {
    const html = consentPage({ clientName: '<script>alert(1)</script>', redirectHost: 'claude.ai', identity: 'github:1', cToken: 'x' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('claude.ai');
  });
});

describe('tokens are hashed, project-bound and reuse-aware', () => {
  const RES_A = `${BASE}/api/mcp/acme/ledger`;
  const RES_B = `${BASE}/api/mcp/acme/other`;

  async function issue(provider, resource) {
    const { code } = await runAuthFlow(provider, {
      fetchMock: githubHappyPath(), params: resource ? { resource } : {},
    });
    return provider.exchangeAuthorizationCode(CLIENT, code);
  }

  it('stores no key or value that works as a token', async () => {
    const provider = makeProvider();
    const tokens = await issue(provider);
    // The raw token is never a key…
    expect(await kvGet(keys.token(tokens.access_token))).toBeNull();
    expect(await kvGet(keys.refresh(tokens.refresh_token))).toBeNull();
    // …the record lives under its hash instead.
    expect(await kvGet(keys.tokenV2(tokenHash(tokens.access_token)))).toBeTruthy();
    expect(await kvGet(keys.refreshV2(tokenHash(tokens.refresh_token)))).toBeTruthy();
  });

  it('accepts a token only on the project it was issued for, either case', async () => {
    const provider = makeProvider();
    const tokens = await issue(provider, RES_A);
    expect((await provider.enforceResource(tokens.access_token, RES_A)).ok).toBe(true);
    expect((await provider.enforceResource(tokens.access_token, RES_A.toUpperCase())).ok).toBe(true);
    const other = await provider.enforceResource(tokens.access_token, RES_B);
    expect(other.ok).toBe(false);
    expect(other.boundTo).toBe(RES_A);
  });

  it('binds a no-resource token to the first project it is used on, then enforces', async () => {
    const provider = makeProvider();
    const tokens = await issue(provider);
    expect((await provider.enforceResource(tokens.access_token, RES_A)).ok).toBe(true);
    expect((await provider.enforceResource(tokens.access_token, RES_B)).ok).toBe(false);
  });

  it('revokes the whole sign-in when a used refresh token is replayed', async () => {
    const provider = makeProvider();
    const first = await issue(provider);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token);
    expect((await provider.verifyAccessToken(second.access_token)).clientId).toBe(CLIENT.client_id);
    // Replaying the already-rotated token is treated as theft: the family dies.
    await expectOAuthError(provider.exchangeRefreshToken(CLIENT, first.refresh_token), 'invalid_grant');
    await expectOAuthError(provider.verifyAccessToken(second.access_token), 'invalid_token');
    await expectOAuthError(provider.exchangeRefreshToken(CLIENT, second.refresh_token), 'invalid_grant');
  });

  it('does not un-revoke a sign-in whose refresh was already in flight', async () => {
    const provider = makeProvider();
    const tokens = await issue(provider);
    // The refresh has consumed its record when the sign-in is revoked underneath
    // it (here, during the GitHub liveness check). It must not issue a new pair.
    vi.stubGlobal('fetch', vi.fn(async () => {
      await provider.revokeToken(null, { token: tokens.access_token });
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    await expectOAuthError(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token), 'invalid_grant');
  });

  it('revokeToken on either token kills both', async () => {
    const provider = makeProvider();
    const tokens = await issue(provider);
    await provider.revokeToken(null, { token: tokens.access_token });
    await expectOAuthError(provider.verifyAccessToken(tokens.access_token), 'invalid_token');
    await expectOAuthError(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token), 'invalid_grant');
  });

  it('keeps a first-use binding across a refresh rather than rebinding on the next project', async () => {
    const provider = makeProvider();
    const first = await issue(provider); // no resource on the token
    expect((await provider.enforceResource(first.access_token, RES_A)).ok).toBe(true);
    // After a refresh the binding must still hold: the refresh record used to
    // stay null, so the new token rebound to whatever project it next hit.
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token);
    expect((await provider.enforceResource(second.access_token, RES_B)).ok).toBe(false);
    expect((await provider.enforceResource(second.access_token, RES_A)).ok).toBe(true);
  });

  it('kills an earlier access token in the family on replay, not only the current pair', async () => {
    const provider = makeProvider();
    const first = await issue(provider);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token);
    // One clean refresh leaves the earlier access token valid on its own.
    expect((await provider.verifyAccessToken(first.access_token)).clientId).toBe(CLIENT.client_id);
    // Replaying the consumed refresh revokes the whole family.
    await expectOAuthError(provider.exchangeRefreshToken(CLIENT, first.refresh_token), 'invalid_grant');
    // revokeFamily deleted the current pair; the earlier access token survives
    // deletion, so verifyAccessToken must reject it by its revoked family.
    await expectOAuthError(provider.verifyAccessToken(first.access_token), 'invalid_token');
  });
});
