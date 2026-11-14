/**
 * Connecting a cloud account from the settings page (hosted connectors).
 *
 * The connect flow reuses the shared Google OAuth callback, told apart by its
 * own pending record, and keeps the token — encrypted, by email — so a hosted
 * file read can use it. These drive the real routes; only Google's token and
 * userinfo endpoints are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { kvGet, kvSet, keys, __resetMemory } from '../src/oauth/kv.js';
import {
  readConnection, connectionsFor, writeConnection,
  shareConnection, connectionSharedWith, connectorSharesBy,
} from '../src/oauth/connectors.js';

let server, base;

beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());
beforeEach(() => __resetMemory());

const GOOGLE = { id: null, login: null, name: 'Priya', email: 'priya@acme.com', token: null, source: 'google' };

/** Stand in for Google's token + userinfo endpoints. */
function stubGoogle({ refresh = 'rt', email = 'priya@acme.com' } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: refresh, expires_in: 3600 }) };
    }
    if (url.includes('userinfo')) return { ok: true, status: 200, json: async () => ({ email }) };
    return real(u, o);
  };
  return () => { globalThis.fetch = real; };
}

async function as(user, path, { method = 'GET', form, cookie = 'teamctx_sid=s' } = {}) {
  await kvSet(keys.session('s'), user);
  const res = await globalThis.fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { cookie, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.get('set-cookie'), body: await res.text() };
}

describe('starting a connection', () => {
  it('redirects to Google asking for the Drive metadata scope, and stashes a pending record', async () => {
    const r = await as(GOOGLE, '/settings/connect/gdrive');
    expect(r.status).toBe(302);
    const url = new URL(r.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toContain('drive.metadata.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(r.setCookie).toMatch(/teamctx_bind=/);
  });

  it('sends a signed-out visitor to sign in first', async () => {
    const res = await globalThis.fetch(`${base}/settings/connect/gdrive`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\/signin\?returnTo=/);
  });
});

describe('finishing a connection at the shared Google callback', () => {
  it('exchanges the code, stores the token by email, and lands back on settings', async () => {
    // Seed a pending record with no bindHash, so the bind check passes (older-record path).
    await kvSet(keys.pending('connect-google:st'), { kind: 'connect', provider: 'gdrive', email: 'priya@acme.com' });
    const restore = stubGoogle({ email: 'priya@acme.com' });
    try {
      const res = await globalThis.fetch(`${base}/oauth/google/callback?state=st&code=xyz`, { redirect: 'manual' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/settings?connected=gdrive');
    } finally { restore(); }
    const stored = await readConnection({ email: 'priya@acme.com', provider: 'gdrive' });
    expect(stored).toMatchObject({ accessToken: 'at', refreshToken: 'rt', account: 'priya@acme.com' });
    expect(await connectionsFor('priya@acme.com')).toEqual(['gdrive']);
  });

  it('does not store the token in the clear', async () => {
    await kvSet(keys.pending('connect-google:st2'), { provider: 'gdrive', email: 'priya@acme.com' });
    const restore = stubGoogle({ refresh: 'SECRET-REFRESH' });
    try {
      await globalThis.fetch(`${base}/oauth/google/callback?state=st2&code=xyz`, { redirect: 'manual' });
    } finally { restore(); }
    const { __dumpMemory } = await import('../src/oauth/kv.js');
    expect(__dumpMemory()).not.toContain('SECRET-REFRESH');
  });
});

describe('disconnecting', () => {
  it('clears the stored connection', async () => {
    await writeConnection({ email: 'priya@acme.com', provider: 'gdrive', accessToken: 'at' });
    const r = await as(GOOGLE, '/settings/disconnect', { method: 'POST', form: { provider: 'gdrive' } });
    expect(r.status).toBe(303);
    expect(r.location).toBe('/settings?disconnected=gdrive');
    expect(await readConnection({ email: 'priya@acme.com', provider: 'gdrive' })).toBeNull();
  });
});

describe('the settings page', () => {
  it('offers Connect when nothing is connected, and no share control yet', async () => {
    const r = await as(GOOGLE, '/settings');
    expect(r.body).toContain('Connected accounts');
    expect(r.body).toContain('/settings/connect/gdrive');
    // The share option lives in the same box and only once connected.
    expect(r.body).not.toContain('/settings/connect/share');
  });

  it('shows the connected account, a Disconnect form, and the share control once connected', async () => {
    await writeConnection({ email: 'priya@acme.com', provider: 'gdrive', accessToken: 'at', account: 'priya@acme.com' });
    const r = await as(GOOGLE, '/settings');
    expect(r.body).toContain('connected as priya@acme.com');
    expect(r.body).toContain('/settings/disconnect');
    expect(r.body).toContain('/settings/connect/share'); // share lives in the same box
    expect(r.body).not.toContain('/settings/connect/gdrive'); // already connected
  });

  it('lists the projects a connection is shared with', async () => {
    await writeConnection({ email: 'priya@acme.com', provider: 'gdrive', accessToken: 'at' });
    await shareConnection({ owner: 'acme', repo: 'ledger', email: 'priya@acme.com', provider: 'gdrive' });
    const r = await as(GOOGLE, '/settings');
    expect(r.body).toContain('acme/ledger');
    expect(r.body).toContain('/settings/connect/unshare');
  });
});

describe('sharing a connection with a project', () => {
  // A GitHub sign-in with push access to the project, so the add-to-project gate passes.
  const BOSS = { id: '7', login: 'boss', name: 'Boss', email: 'boss@acme.com', token: 'gh-tok', source: 'github' };

  /** Let the project's push-permission check see a repo the user can push to. */
  function stubRepoPush() {
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('api.github.com/repos/')) {
        return { ok: true, status: 200, json: async () => ({ permissions: { push: true } }) };
      }
      if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ([]) };
      return real(u, o);
    };
    return () => { globalThis.fetch = real; };
  }

  it('shares a connected account with a project', async () => {
    await writeConnection({ email: 'boss@acme.com', provider: 'gdrive', accessToken: 'at' });
    const restore = stubRepoPush();
    try {
      const r = await as(BOSS, '/settings/connect/share', { method: 'POST', form: { provider: 'gdrive', project: 'acme/ledger' } });
      expect(r.status).toBe(303);
    } finally { restore(); }
    expect(await connectionSharedWith({ owner: 'acme', repo: 'ledger', email: 'boss@acme.com', provider: 'gdrive' })).toBe(true);
    expect(await connectorSharesBy('boss@acme.com')).toEqual([{ slug: 'acme/ledger', provider: 'gdrive' }]);
  });

  it('refuses to share an account that is not connected', async () => {
    const restore = stubRepoPush();
    try {
      const r = await as(BOSS, '/settings/connect/share', { method: 'POST', form: { provider: 'gdrive', project: 'acme/ledger' } });
      expect(r.location).toMatch(/error=/);
    } finally { restore(); }
    expect(await connectionSharedWith({ owner: 'acme', repo: 'ledger', email: 'boss@acme.com', provider: 'gdrive' })).toBe(false);
  });

  it('stops sharing', async () => {
    await writeConnection({ email: 'boss@acme.com', provider: 'gdrive', accessToken: 'at' });
    await shareConnection({ owner: 'acme', repo: 'ledger', email: 'boss@acme.com', provider: 'gdrive' });
    const r = await as(BOSS, '/settings/connect/unshare', { method: 'POST', form: { provider: 'gdrive', project: 'acme/ledger' } });
    expect(r.status).toBe(303);
    expect(await connectionSharedWith({ owner: 'acme', repo: 'ledger', email: 'boss@acme.com', provider: 'gdrive' })).toBe(false);
  });
});
