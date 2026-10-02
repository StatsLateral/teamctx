/**
 * One way to sign in, offered the same way everywhere.
 *
 * The dashboard had three rules for this. The home page and the settings pages
 * redirected straight into GitHub, the connector weighed up whether the project
 * lent access, and the settings sign-in dropped the Google button when it could
 * not be used — silently, so a member invited by email met a GitHub-only screen
 * with nothing on it to say why.
 *
 * What is checked here is the rule, at every door: no screen sends somebody to
 * a provider on their behalf, and a way in that is shut is on the page with its
 * reason beside it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { kvSet, keys, __resetMemory } from '../src/oauth/kv.js';

let server, base;

beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

async function get(path, { session = null } = {}) {
  if (session) await kvSet(keys.session('s'), session);
  const res = await fetch(`${base}${path}`, {
    method: 'GET', redirect: 'manual', headers: session ? { cookie: 'teamctx_sid=s' } : {},
  });
  return {
    status: res.status,
    location: decodeURIComponent(res.headers.get('location') || ''),
    body: await res.text(),
  };
}

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

beforeEach(() => __resetMemory());

describe('every door leads to the same screen', () => {
  // The paths somebody signed out can arrive on, and where each says to go.
  const doors = [
    ['/settings', '/signin?returnTo=/settings'],
    ['/settings/new-project', '/signin?returnTo=/settings/new-project'],
    ['/projects', '/signin?returnTo=/projects'],
    ['/project/acme/ledger', '/signin?returnTo=/project/acme/ledger'],
  ];

  for (const [path, expected] of doors) {
    it(`sends a signed-out visitor from ${path} to the sign-in screen, and back after`, async () => {
      const { status, location } = await get(path);
      expect(status).toBe(303);
      expect(location).toBe(expected);
    });
  }

  it('offers the sign-in screen from the home page and the nav, not a provider', async () => {
    const { body } = await get('/');
    expect(body).toContain('href="/signin"');
    // `/settings/signin` is the GitHub kickoff, not a screen. Nothing links to
    // it but a button somebody pressed.
    expect(body).not.toContain('href="/settings/signin"');
  });

  it('does not strand somebody who is already signed in on it', async () => {
    const { status, location } = await get('/signin?returnTo=/projects', { session: { id: '7', login: 'maya', token: 'gho' } });
    expect(status).toBe(303);
    expect(location).toBe('/projects');
  });
});

describe('the screen itself', () => {
  it('offers both ways in, each straight to its provider', async () => {
    const { status, body } = await get('/signin');
    expect(status).toBe(200);
    expect(body).toContain('href="/settings/signin"');
    expect(body).toContain('href="/settings/signin/google"');
    // GitHub first: it is the one the manager needs.
    expect(body.indexOf('Continue with GitHub')).toBeLessThan(body.indexOf('Continue with Google'));
  });

  it('carries where somebody was going through either provider', async () => {
    const { body } = await get('/signin?returnTo=/project/acme/ledger');
    await lend();
    expect(body).toContain('/settings/signin?returnTo=%2Fproject%2Facme%2Fledger');
  });

  it('keeps a made-up destination out of the buttons', async () => {
    const { body } = await get('/signin?returnTo=https://evil.example/steal');
    expect(body).not.toContain('evil.example');
    expect(body).toContain('href="/settings/signin"');
  });

  it('says why Google is shut on a step that needs a GitHub account', async () => {
    const { body } = await get('/signin?returnTo=/settings/new-project');
    expect(body).toContain('Continue with Google');
    expect(body).not.toContain('href="/settings/signin/google');
    expect(body).toMatch(/creates a GitHub repository, so that step needs a GitHub account/);
  });

  it('says why Google is shut on a project that lends no access', async () => {
    const { body } = await get('/signin?returnTo=/project/acme/ledger');
    expect(body).toContain('Continue with Google');
    expect(body).not.toContain('href="/settings/signin/google');
    expect(body).toMatch(/acme\/ledger has not lent GitHub access/);
  });

  it('opens Google again once that project lends access', async () => {
    await lend();
    const { body } = await get('/signin?returnTo=/project/acme/ledger');
    expect(body).toContain('/settings/signin/google?returnTo=%2Fproject%2Facme%2Fledger');
    expect(body).not.toMatch(/has not lent GitHub access/);
  });

  it('never leaves a shut way in unexplained', async () => {
    // Whatever the reason, the button stays on the page and the reason sits
    // under it. This is the rule the whole change exists to hold.
    for (const path of ['/signin?returnTo=/settings/new-project', '/signin?returnTo=/project/acme/ledger']) {
      const { body } = await get(path);
      expect(body, path).toContain('class="btn off"');
      expect(body, path).toContain('aria-disabled="true"');
    }
  });
});

describe('the connector screen follows the same rule', () => {
  const pending = (resource = 'https://team.example.app/api/mcp/acme/ledger') =>
    kvSet(keys.pending('s1'), { clientId: 'c', redirectUri: 'https://claude.ai/cb', resource });

  it('shows the shut Google option with its reason, rather than dropping it', async () => {
    await pending();
    const { body } = await get('/oauth/choose?state=s1');
    expect(body).toContain('Continue with Google');
    expect(body).toContain('class="btn off"');
    expect(body).not.toContain('/oauth/choose/google');
    expect(body).toMatch(/acme\/ledger has not lent GitHub access/);
  });

  it('words it the same way the dashboard does', async () => {
    await pending();
    const connector = (await get('/oauth/choose?state=s1')).body;
    const dashboard = (await get('/signin?returnTo=/project/acme/ledger')).body;
    const reason = /acme\/ledger has not lent GitHub access[\s\S]{0,160}?settings page\./;
    expect(connector.match(reason)?.[0]).toBe(dashboard.match(reason)?.[0]);
  });
});

describe('coming back to what a link pointed at', () => {
  it('carries the part of the work and the item through sign-in', async () => {
    // A fragment would have been dropped on the way through GitHub; these are
    // query parameters for exactly that reason.
    const { status, location } = await get('/project/acme/ledger?ws=product&item=w1');
    expect(status).toBe(303);
    expect(location).toBe('/signin?returnTo=/project/acme/ledger?ws=product&item=w1');
  });

  it('offers both ways in, each keeping the link', async () => {
    await lend();
    const back = encodeURIComponent('/project/acme/ledger?ws=product&item=w1');
    const { body } = await get(`/signin?returnTo=${back}`);
    expect(body).toContain('ws%3Dproduct%26item%3Dw1');
    expect(body).toContain('/settings/signin/google?returnTo=');
  });

  it('drops a returnTo carrying something it would not have written', async () => {
    const back = encodeURIComponent('/project/acme/ledger?next=https://evil.example');
    const { body } = await get(`/signin?returnTo=${back}`);
    expect(body).not.toContain('evil.example');
  });
});
