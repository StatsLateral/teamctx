import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TeamctxOAuthProvider, providerFromEnv, oauthConfigStatus } from './provider.js';
import { __resetMemory, kvGet, kvSet, keys } from './kv.js';

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

/** Captures whatever `authorize()` redirects to. */
function fakeRes() {
  return { redirectedTo: null, redirect(url) { this.redirectedTo = url; } };
}

/** Drive authorize → GitHub callback and return our authorization code. */
async function runAuthFlow(provider, { fetchMock, params = {} } = {}) {
  const res = fakeRes();
  await provider.authorize(CLIENT, {
    redirectUri: CLIENT.redirect_uris[0],
    codeChallenge: 'challenge-abc',
    state: 'claude-state',
    scopes: ['mcp:tools'],
    ...params,
  }, res);

  const state = new URL(res.redirectedTo).searchParams.get('state');
  if (fetchMock) vi.stubGlobal('fetch', fetchMock);
  const back = await provider.handleGithubCallback({ code: 'gh-code', state });
  return { redirectedTo: res.redirectedTo, back, code: new URL(back).searchParams.get('code') };
}

/** Happy-path GitHub: token exchange then profile lookup. */
function githubHappyPath() {
  return vi.fn(async (url) => {
    if (String(url).includes('login/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'gho_realtoken' }) };
    }
    if (String(url).includes('api.github.com/user')) {
      return { ok: true, json: async () => ({ id: 4242, login: 'satyagyasingh', name: 'Satya' }) };
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

  it('rejects a state that was already consumed (replay)', async () => {
    const provider = makeProvider();
    const res = fakeRes();
    await provider.authorize(CLIENT, { redirectUri: CLIENT.redirect_uris[0], codeChallenge: 'c' }, res);
    const state = new URL(res.redirectedTo).searchParams.get('state');

    vi.stubGlobal('fetch', githubHappyPath());
    await provider.handleGithubCallback({ code: 'gh-code', state });
    await expect(provider.handleGithubCallback({ code: 'gh-code', state }))
      .rejects.toThrow(/expired or was already used/);
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

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ error: 'bad_verification_code', error_description: 'expired' }),
    })));
    await expect(provider.handleGithubCallback({ code: 'x', state })).rejects.toThrow(/expired/);
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
