/**
 * Tips & Tricks is for signed-in people: a signed-out click goes through
 * sign-in and comes back to the same address, project and all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

let server, base;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

describe('GET /tips', () => {
  it('sends a signed-out visitor to sign in, and back', async () => {
    const res = await fetch(`${base}/tips?project=acme%2Fgtm`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/signin?returnTo=${encodeURIComponent('/tips?project=acme/gtm')}`);
  });

  it('does not carry a malformed project through sign-in', async () => {
    const res = await fetch(`${base}/tips?project=//evil.test`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`/signin?returnTo=${encodeURIComponent('/tips')}`);
  });
});

describe('GET /project/:owner/:repo/contributions', () => {
  it('sends a signed-out visitor to sign in, and back with the grouping', async () => {
    const res = await fetch(`${base}/project/acme/gtm/contributions?group=person`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/signin?returnTo=${encodeURIComponent('/project/acme/gtm/contributions?group=person')}`);
  });
});
