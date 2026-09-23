/**
 * Where a project stands, for somebody who would rather look than ask.
 *
 * Everything shown here is already in the repository; what is checked is that
 * the page reads it with the right credential, shows only what the person is
 * allowed to see, and keeps the manager's queue to the manager.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map(), prefetchError: null }));

vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  listPushableRepos: async () => [],
  listUserOrgs: async () => [],
  GithubSession: class {
    constructor({ owner, repo: name, ghToken }) {
      Object.assign(this, { owner, repo: name, ghToken });
      repo.usedToken = ghToken;
    }

    async prefetch() { if (repo.prefetchError) throw new Error(repo.prefetchError); }

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

const MANAGER = { id: '7', login: 'maya', name: 'Maya', email: 'maya@example.com', token: 'gho-maya' };
const MEMBER_GOOGLE = { id: null, login: null, name: 'Priya', email: 'priya@example.com', token: null, source: 'google' };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', name: 'Product' }, { id: 'tech', name: 'Tech' }],
  roles: [],
  members: [
    { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] },
    { key: 'git:dev@example.com', name: 'Dev', email: 'dev@example.com' },
    { key: 'agent:a1', name: 'Nightly report', kind: 'agent' },
  ],
};

function project() {
  repo.files = new Map([
    ['.teamctx/config.json', JSON.stringify(CONFIG)],
    ['.teamctx/contributions.jsonl', ''],
    ['.teamctx/project.json', JSON.stringify({ name: 'Ledger', whys: [{ id: 'p1', text: 'ship it' }], tasks: [] })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', whys: [{ id: 'w1', text: 'price it' }],
      tasks: [{ id: 'pricing-page', title: 'Draft the pricing page', owner: 'Priya', status: 'open' }],
    })],
    ['.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech', whys: [],
      tasks: [
        { id: 'migrate-db', title: 'Migrate the database', owner: 'Dev', status: 'open' },
        { id: 'old-thing', title: 'Something finished', owner: 'Dev', status: 'done' },
      ],
    })],
    ['.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', summary: 'adds the pricing tiers', workstream: 'product',
    })],
  ]);
  repo.prefetchError = null;
}

async function visit(path, user) {
  if (user) await kvSet(keys.session('s'), user);
  const res = await fetch(`${base}${path}`, {
    method: 'GET', redirect: 'manual', headers: user ? { cookie: 'teamctx_sid=s' } : {},
  });
  return { status: res.status, location: decodeURIComponent(res.headers.get('location') || ''), body: await res.text() };
}

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

beforeEach(() => {
  __resetMemory();
  project();
});

describe('the manager looking at a project', () => {
  it('sees the parts of the work and who is on each', async () => {
    const { status, body } = await visit('/project/acme/ledger', MANAGER);
    expect(status).toBe(200);
    expect(body).toMatch(/Product[\s\S]*Priya/);
    expect(body).toMatch(/Tech[\s\S]*Dev/);
  });

  it('sees every open task and who has it, and a count of what is done', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('Draft the pricing page');
    expect(body).toContain('Migrate the database');
    expect(body).not.toContain('Something finished');
    expect(body).toMatch(/1\s*\n?task already done/);
  });

  it('sees what is waiting on them', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('Waiting on you');
    expect(body).toContain('adds the pricing tiers');
  });

  it('reads the project with their own GitHub token', async () => {
    await visit('/project/acme/ledger', MANAGER);
    expect(repo.usedToken).toBe('gho-maya');
  });
});

describe('a member looking at the same project', () => {
  it('reads it through the access the project lends', async () => {
    await lend();
    const { status } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(status).toBe(200);
    expect(repo.usedToken).toBe('gh-lent');
  });

  it('sees only the part of the work they are on', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).toContain('Draft the pricing page');
    expect(body).not.toContain('Migrate the database');
    expect(body).toContain('you see product');
  });

  it('is not shown the approval queue, which is the manager\'s', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('Waiting on you');
    expect(body).not.toContain('adds the pricing tiers');
  });

  it('is refused on a project whose roster does not name them', async () => {
    await lend();
    const { status, body } = await visit('/project/acme/ledger', { ...MEMBER_GOOGLE, email: 'stranger@example.com' });
    expect(status).toBe(403);
    expect(body).toMatch(/not on the acme\/ledger roster/);
  });

  it('is told plainly when the project lends no access to read it with', async () => {
    const { status, body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(status).toBe(403);
    expect(body).toMatch(/has not lent GitHub access/);
  });
});

describe('getting there', () => {
  it('lists the projects somebody is on', async () => {
    await kvSet(keys.connectedProjects('maya@example.com'), { projects: ['acme/ledger'] });
    const { body } = await visit('/projects', MANAGER);
    expect(body).toContain('href="/project/acme/ledger"');
  });

  it('says so when there are none yet', async () => {
    expect((await visit('/projects', MANAGER)).body).toMatch(/Nothing here yet/);
  });

  it('sends a signed-out visitor to sign in, and back again', async () => {
    const r = await visit('/project/acme/ledger');
    expect(r.status).toBe(303);
    expect(r.location).toBe('/settings/signin?returnTo=/project/acme/ledger');
  });

  it('reports a repository it cannot read, rather than failing silently', async () => {
    repo.prefetchError = 'github: repo acme/ledger not found (or PAT lacks access)';
    const { status, body } = await visit('/project/acme/ledger', MANAGER);
    expect(status).toBe(403);
    expect(body).toMatch(/could not be read/);
  });
});
