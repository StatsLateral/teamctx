/**
 * A failed sign-in must never render the raw error to the person. A deployment
 * with no encryption key configured refused to store the session and the
 * callback showed the error verbatim — including the session key and its id.
 * signInFailed sanitises that: the detail goes to the log, the page gets a
 * clean message, and a persistent deployment with no key gets a useful hint.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

beforeAll(() => {
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
});

const { signInFailed } = await import('./oauth-server.js');
const { OAuthCallbackError } = await import('../src/oauth/provider.js');

function fakeRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    send(b) { this.body = b; return this; },
  };
}

const SAVED = { ...process.env };
afterEach(() => {
  // Restore whatever the persistent-mode test changed.
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  if (SAVED.TEAMCTX_SECRET_KEYS !== undefined) process.env.TEAMCTX_SECRET_KEYS = SAVED.TEAMCTX_SECRET_KEYS;
  if (SAVED.TEAMCTX_SECRET_KEY_ACTIVE !== undefined) process.env.TEAMCTX_SECRET_KEY_ACTIVE = SAVED.TEAMCTX_SECRET_KEY_ACTIVE;
});

const LEAKY = new Error('Refusing to store a secret at teamctx:session:XGUi9kGcLIjQsKpsBdtwqPpuOBdU32Db with no encryption key configured.');

describe('signInFailed never leaks the raw error to the page', () => {
  it('shows a generic message for an unexpected error, not its text', () => {
    const res = fakeRes();
    signInFailed(res, LEAKY);
    expect(res.code).toBe(400);
    expect(res.body).not.toContain('teamctx:session:');
    expect(res.body).not.toContain('Refusing to store a secret');
    expect(res.body).toContain('Sign-in could not be completed');
  });

  it('keeps the safe message of a known OAuth error', () => {
    const res = fakeRes();
    signInFailed(res, new OAuthCallbackError('access_denied', 'GitHub returned: access_denied'));
    expect(res.body).toContain('access_denied');
    expect(res.body).not.toContain('teamctx:session:');
  });

  it('on a persistent deployment with no key, points the admin at the setting — still no raw text', () => {
    process.env.KV_REST_API_URL = 'https://example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'tok';
    delete process.env.TEAMCTX_SECRET_KEYS;
    delete process.env.TEAMCTX_SECRET_KEY_ACTIVE;
    const res = fakeRes();
    signInFailed(res, LEAKY);
    expect(res.body).toContain('TEAMCTX_SECRET_KEYS');
    expect(res.body).not.toContain('teamctx:session:');
  });
});
