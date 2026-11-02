/**
 * Setting and clearing a project's Slack notices on the settings page (#182):
 * a manager only, a Slack incoming webhook only, kept in the store and never
 * shown on the page again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

let pushable = [];
vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  GithubSession: class { async prefetch() {} },
  listPushableRepos: async () => pushable,
}));

const { kvGet, kvSet, keys, __resetMemory } = await import('../src/oauth/kv.js');

let server, base;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const MAYA_GOOGLE = { id: null, login: null, name: 'Maya', email: 'maya@example.com', token: null, source: 'google' };
const MAYA_GITHUB = { id: 77, login: 'maya', name: 'Maya', email: 'maya@example.com', token: 'gh-maya', source: 'github' };
const SAM_GOOGLE = { id: null, login: null, name: 'Sam', email: 'sam@example.com', token: null, source: 'google' };
const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64');

let restore;
let blockedToken = null;
function stubGithub(config = { project: 'Ledger', managerKey: 'git:maya@example.com' }) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('/contents/.teamctx/config.json')) {
      // An organisation that keeps this account's own token out of the repository.
      if (String(o?.headers?.Authorization || '').includes(blockedToken || 'no token is blocked')) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: b64(config) }) };
    }
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ([]) };
    return real(u, o);
  };
  return () => { globalThis.fetch = real; };
}

async function as(user, path, { method = 'GET', form } = {}) {
  await kvSet(keys.session('s'), user);
  const res = await fetch(`${base}${path}`, {
    method, redirect: 'manual',
    headers: { cookie: 'teamctx_sid=s', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return { status: res.status, location: decodeURIComponent(res.headers.get('location') || ''), body: await res.text() };
}

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });
const set = (user, webhook = HOOK) => as(user, '/settings/slack', { method: 'POST', form: { project: 'acme/ledger', webhook } });

beforeEach(() => {
  __resetMemory();
  pushable = [];
  blockedToken = null;
  restore?.();
  restore = stubGithub();
});
afterAll(() => restore?.());

describe('setting the webhook', () => {
  it('keeps it in the store for a manager, and records who set it', async () => {
    await lend();
    const r = await set(MAYA_GOOGLE);
    expect(r.location).toBe('/settings?saved=1');
    expect(await kvGet(keys.slackWebhook('acme', 'ledger'))).toMatchObject({ url: HOOK, setBy: 'maya@example.com' });
  });

  it('works for a manager signed in with GitHub, with no access lent', async () => {
    expect((await set(MAYA_GITHUB)).location).toBe('/settings?saved=1');
  });

  it('falls back on the access the project lends when their own token cannot read it', async () => {
    await lend();
    blockedToken = 'gh-maya';
    expect((await set(MAYA_GITHUB)).location).toBe('/settings?saved=1');
  });

  it('is refused for someone who is not a manager', async () => {
    await lend();
    const r = await set(SAM_GOOGLE);
    expect(r.location).toMatch(/Only a manager of acme\/ledger can set its Slack notices/);
    expect(await kvGet(keys.slackWebhook('acme', 'ledger'))).toBeNull();
  });

  it('is refused for an address that is not a Slack incoming webhook', async () => {
    await lend();
    const r = await set(MAYA_GOOGLE, 'https://example.com/collect');
    expect(r.location).toMatch(/not a Slack incoming webhook/);
    expect(await kvGet(keys.slackWebhook('acme', 'ledger'))).toBeNull();
  });
});

describe('the page', () => {
  it('says it is set, by whom, and never shows the webhook', async () => {
    await lend();
    await set(MAYA_GOOGLE);
    const page = await as(MAYA_GOOGLE, '/settings');
    expect(page.body).toContain('<h2>Slack</h2>');
    expect(page.body).toMatch(/<code>acme\/ledger<\/code>\s*<span class="muted">— set by maya@example.com on \d{4}-\d{2}-\d{2}<\/span>/);
    expect(page.body).not.toContain('SECRET');
    expect(page.body).not.toContain('hooks.slack.com/services/T000');
  });

  it('shows a co-manager one another manager set, so they can stop it', async () => {
    await lend();
    await set(MAYA_GOOGLE);
    const LEE_GITHUB = { id: 88, login: 'lee', name: 'Lee', email: 'lee@example.com', token: 'gh-lee', source: 'github' };
    restore();
    restore = stubGithub({ project: 'Ledger', managerKeys: ['git:maya@example.com', 'git:lee@example.com'] });
    pushable = [{ fullName: 'acme/ledger', private: true }];
    const page = await as(LEE_GITHUB, '/settings');
    expect(page.body).toMatch(/<code>acme\/ledger<\/code>\s*<span class="muted">— set by maya@example.com/);
  });

  it('does not list it for someone who is not a manager', async () => {
    await lend();
    await set(MAYA_GOOGLE);
    await kvSet(keys.slackSetBy('sam@example.com'), { projects: ['acme/ledger'] });
    const page = await as(SAM_GOOGLE, '/settings');
    expect(page.body).not.toMatch(/<code>acme\/ledger<\/code>\s*<span class="muted">— set by/);
  });
});

describe('clearing the webhook', () => {
  it('removes it, for a manager only', async () => {
    await lend();
    await set(MAYA_GOOGLE);
    const refused = await as(SAM_GOOGLE, '/settings/slack', { method: 'POST', form: { project: 'acme/ledger', clear: '1' } });
    expect(refused.location).toMatch(/Only a manager/);
    expect(await kvGet(keys.slackWebhook('acme', 'ledger'))).toBeTruthy();
    await as(MAYA_GOOGLE, '/settings/slack', { method: 'POST', form: { project: 'acme/ledger', clear: '1' } });
    expect(await kvGet(keys.slackWebhook('acme', 'ledger'))).toBeNull();
  });
});
