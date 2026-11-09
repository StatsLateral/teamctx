/**
 * The consent form is a POST, and what it answers with decides what the browser
 * sends next. A 302 behind Vercel's rewrite layer arrives as a 307, which makes
 * the browser repeat the POST at the client's callback; that callback takes only
 * GET, and the person lands on "Method Not Allowed" instead of finishing the
 * connection. A 303 is the status that mandates a GET on the next hop.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { kvSet, keys, __resetMemory } from '../src/oauth/kv.js';

let server, base;

beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());
beforeEach(() => __resetMemory());

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

async function postConsent(decision) {
  await kvSet(keys.consentPending('tok'), {
    codeRecord: { clientId: 'c1' },
    clientId: 'c1',
    redirectUri: CALLBACK,
    clientState: 'st',
    redirectOrigin: 'https://claude.ai',
    subject: 'github:maya',
    identity: 'maya',
    bindHash: null,
  });
  const res = await fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ c: 'tok', decision }).toString(),
  });
  return { status: res.status, location: res.headers.get('location') || '' };
}

describe('POST /oauth/consent', () => {
  it('answers approve with a 303 to the callback, so the browser follows with a GET', async () => {
    const r = await postConsent('approve');
    expect(r.status).toBe(303);
    expect(r.location.startsWith(CALLBACK)).toBe(true);
    expect(new URL(r.location).searchParams.get('code')).toBeTruthy();
  });

  it('answers deny with a 303 to the callback carrying access_denied', async () => {
    const r = await postConsent('deny');
    expect(r.status).toBe(303);
    expect(new URL(r.location).searchParams.get('error')).toBe('access_denied');
  });
});
