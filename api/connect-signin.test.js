/**
 * The screen somebody sees while connecting their AI client.
 *
 * Two ways in sat side by side under one question, with the difference between
 * them in small print underneath — and Google was offered on projects it could
 * not work for, because a member without a GitHub account reaches a project only
 * through the GitHub access it lends.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';

const { kvSet, keys, __resetMemory } = await import('../src/oauth/kv.js');

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

const get = async path => {
  const res = await fetch(`${base}${path}`, { redirect: 'manual' });
  return { status: res.status, body: await res.text() };
};

/** An authorization in flight, for one project. */
const pending = (resource = 'https://team.example.app/api/mcp/acme/ledger') =>
  kvSet(keys.pending('s1'), { clientId: 'c', redirectUri: 'https://claude.ai/cb', resource });
const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

beforeEach(() => __resetMemory());

describe('choosing how to sign in', () => {
  it('names the project being connected to', async () => {
    await pending();
    await lend();
    expect((await get('/oauth/choose?state=s1')).body).toContain('Connect to acme/ledger');
  });

  it('says who each way in is for, where the choice is made', async () => {
    await pending();
    await lend();
    const { body } = await get('/oauth/choose?state=s1');
    expect(body).toMatch(/Continue with GitHub[\s\S]*For the manager, and anyone who works in the repository/);
    expect(body).toMatch(/Continue with Google[\s\S]*invited to the project by email/);
    // GitHub first: it is the one the manager needs.
    expect(body.indexOf('Continue with GitHub')).toBeLessThan(body.indexOf('Continue with Google'));
  });

  it('does not offer Google on a project that lends no GitHub access, and says why', async () => {
    await pending();
    const { body } = await get('/oauth/choose?state=s1');
    expect(body).not.toContain('/oauth/choose/google');
    expect(body).toMatch(/has not lent GitHub access/);
    expect(body).toContain('/oauth/choose/github');
  });

  it('offers both when it cannot tell which project this is', async () => {
    // An expired or unfamiliar authorization: hiding a way in would be worse
    // than offering one that may not apply.
    const { body } = await get('/oauth/choose?state=unknown');
    expect(body).toContain('/oauth/choose/github');
    expect(body).toContain('/oauth/choose/google');
    expect(body).toContain('Connect to teamctx');
  });

  it('still refuses without a state', async () => {
    expect((await get('/oauth/choose')).status).toBe(400);
  });
});
