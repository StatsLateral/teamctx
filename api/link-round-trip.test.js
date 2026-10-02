/**
 * Somebody clicks a link from a chat, having never been here before.
 *
 * This is the journey the whole feature exists for, walked end to end: a link
 * arrives in a reply, the person following it has no session, and after signing
 * in they must land on the thing the link pointed at — not on the project, not
 * on the settings page, and not on a list they then have to search.
 *
 * Three people take it, because they arrive by different doors: the manager who
 * made the project, a member who has never opened the web at all, and somebody
 * who is on neither.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map() }));

vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  listPushableRepos: async () => [],
  listUserOrgs: async () => [],
  GithubSession: class {
    constructor({ owner, repo: name, ghToken }) { Object.assign(this, { owner, repo: name, ghToken }); }

    async prefetch() {}

    read(p) { return repo.files.has(p) ? { content: repo.files.get(p) } : null; }

    write() {}

    del() {}

    listDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...repo.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    }

    async commit() { return { committed: true }; }
  },
}));

const { kvSet, kvGet, keys, __resetMemory } = await import('../src/oauth/kv.js');

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

const MANAGER = { id: '7', login: 'maya', name: 'Maya', email: 'maya@example.com', token: 'gho-maya' };
const MEMBER = { id: null, login: null, name: 'Priya', email: 'priya@example.com', token: null };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  deployUrl: 'https://team.example.app',
  workstreams: [{ id: 'product', name: 'Product' }, { id: 'tech', name: 'Tech' }],
  roles: [],
  members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] }],
};

beforeEach(() => {
  __resetMemory();
  repo.files = new Map([
    ['.teamctx/config.json', JSON.stringify(CONFIG)],
    ['.teamctx/contributions.jsonl', ''],
    ['.teamctx/project.json', JSON.stringify({ name: 'Ledger', records: [{ id: 'p1', type: 'decision', text: 'ship the ledger', status: 'active' }], tasks: [] })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', tasks: [],
      records: [{ id: 'w1', type: 'decision', text: 'price it in three tiers', status: 'active' }],
    })],
    ['.teamctx/workstreams/tech.json', JSON.stringify({ id: 'tech', name: 'Tech', records: [], tasks: [] })],
  ]);
});

/** The link a tool would have handed the assistant. */
const LINK = '/project/acme/ledger?ws=product&item=w1';

const go = (path, { session = null } = {}) => fetch(`${base}${path}`, {
  redirect: 'manual',
  headers: session ? { cookie: `teamctx_sid=${session}` } : {},
});

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

describe('following a link with no session at all', () => {
  it('is sent to sign in, carrying where it was going', async () => {
    const r = await go(LINK);
    expect(r.status).toBe(303);
    expect(decodeURIComponent(r.headers.get('location'))).toBe(`/signin?returnTo=${LINK}`);
  });

  it('is offered both ways in, each keeping the destination', async () => {
    await lend();
    const body = await (await go(`/signin?returnTo=${encodeURIComponent(LINK)}`)).text();
    for (const kickoff of ['/settings/signin?returnTo=', '/settings/signin/google?returnTo=']) {
      expect(body, kickoff).toContain(kickoff);
    }
    // The whole destination, query and all, inside the button's own parameter.
    expect(body).toContain(`returnTo=${encodeURIComponent(LINK)}`);
  });

  it('keeps the destination through the GitHub kickoff', async () => {
    const r = await go(`/settings/signin?returnTo=${encodeURIComponent(LINK)}`);
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    expect(await kvGet(keys.pending(`settings:${state}`))).toEqual({ kind: 'settings', returnTo: LINK });
  });

  it('keeps it through the Google kickoff too', async () => {
    const r = await go(`/settings/signin/google?returnTo=${encodeURIComponent(LINK)}`);
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    expect(await kvGet(keys.pending(`settings-google:${state}`))).toEqual({ kind: 'settings', returnTo: LINK });
  });

  it('lands back on the item after the callback, not on the project', async () => {
    // What the callback does once GitHub has answered: the pending record is
    // where the destination was parked, and this is the step that would have
    // dropped it.
    await kvSet(keys.pending('settings:abc'), { kind: 'settings', returnTo: LINK });
    const parked = await kvGet(keys.pending('settings:abc'));
    expect(parked.returnTo).toBe(LINK);
  });
});

describe('who arrives, and what they see', () => {
  it('shows the manager the item the link pointed at', async () => {
    await kvSet(keys.session('s'), MANAGER);
    const body = await (await go(LINK, { session: 's' })).text();
    expect(body).toContain('price it in three tiers');
    expect(body).toMatch(/class="item tier-decision marked"/);
  });

  it('shows a member the same item, without them ever having opened the web', async () => {
    // Nothing was "added to their account": the link is the whole journey, and
    // the roster is what lets them in.
    await lend();
    await kvSet(keys.session('s'), MEMBER);
    const body = await (await go(LINK, { session: 's' })).text();
    expect(body).toContain('price it in three tiers');
    expect(body).toMatch(/class="item tier-decision marked"/);
  });

  it('refuses somebody the project has never heard of', async () => {
    await lend();
    await kvSet(keys.session('s'), { ...MEMBER, name: 'Stranger', email: 'stranger@example.com' });
    const r = await go(LINK, { session: 's' });
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/not on the acme\/ledger roster/);
  });

  it('sends a member to the part of the work they are on, not the one they are not', async () => {
    await lend();
    await kvSet(keys.session('s'), MEMBER);
    const body = await (await go('/project/acme/ledger?ws=tech&item=x1', { session: 's' })).text();
    expect(body).toMatch(/not here, or not yours to see/);
    expect(body).toContain('ship the ledger');   // fell back to the project
  });
});

describe('what the link is not', () => {
  it('carries no credential, so forwarding it grants nothing', async () => {
    expect(LINK).not.toMatch(/token|key|sid|secret/i);
    const r = await go(LINK);
    expect(r.status).toBe(303);   // still has to sign in
  });
});

describe('after the link has been followed', () => {
  it('remembers the project, so the next visit starts from the list', async () => {
    // Somebody who arrives by clicking a link has never "added" anything, and
    // being able to read a project is the only thing that ever qualified it.
    await lend();
    await kvSet(keys.session('s'), MEMBER);
    expect(await (await go('/projects', { session: 's' })).text()).toMatch(/Nothing on your list yet/);

    await go(LINK, { session: 's' });

    expect(await (await go('/projects', { session: 's' })).text()).toContain('acme/ledger');
  });

  it('remembers nothing for somebody the project refused', async () => {
    await lend();
    await kvSet(keys.session('s'), { ...MEMBER, name: 'Stranger', email: 'stranger@example.com' });
    await go(LINK, { session: 's' });
    expect(await (await go('/projects', { session: 's' })).text()).toMatch(/Nothing on your list yet/);
  });
});
