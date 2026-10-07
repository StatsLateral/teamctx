/**
 * The manager's review-and-impact screen (#118).
 *
 * What the issue accepts on: the manager can clear the queue and see what a
 * broken assumption affects without leaving the page; a scoped member's page
 * data has nothing from outside their parts; an unknown `?item=` says so and
 * never writes the value back.
 *
 * The repository here keeps what is written to it, so an approval made from the
 * page can be checked by reading the page again — the way the manager would.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map() }));

vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  listPushableRepos: async () => [],
  listUserOrgs: async () => [],
  GithubSession: class {
    constructor({ owner, repo: name, ghToken }) {
      Object.assign(this, { owner, repo: name, ghToken });
      this.staged = new Map();
    }

    async prefetch() {}

    read(p) {
      if (this.staged.has(p)) return this.staged.get(p) === null ? null : { content: this.staged.get(p) };
      return repo.files.has(p) ? { content: repo.files.get(p) } : null;
    }

    write(p, content) { this.staged.set(p, content); }

    del(p) { this.staged.set(p, null); }

    listDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const all = new Set([...repo.files.keys(), ...this.staged.keys()]);
      return [...all].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && this.read(p))
        .map(p => p.slice(prefix.length)).sort();
    }

    // All or nothing, as a hosted commit is.
    async commit() {
      for (const [p, c] of this.staged) (c === null ? repo.files.delete(p) : repo.files.set(p, c));
      this.staged.clear();
      return { committed: true };
    }
  },
}));

const { kvSet, keys, __resetMemory } = await import('../src/oauth/kv.js');
const { readProjectView } = await import('../src/oauth/project-view.js');

let server, base, host;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  host = `127.0.0.1:${server.address().port}`;
  base = `http://${host}`;
});
afterAll(() => server?.close());

const MANAGER = { id: '7', login: 'maya', name: 'Maya', email: 'maya@example.com', token: 'gho-maya' };
const MEMBER = { id: null, login: null, name: 'Priya', email: 'priya@example.com', token: null, source: 'google' };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', name: 'Product' }, { id: 'tech', name: 'Tech' }],
  roles: [],
  members: [
    { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] },
  ],
};

const BROKEN_AT = '2026-09-01T10:00:00.000Z';

function project() {
  repo.files = new Map([
    ['.teamctx/config.json', JSON.stringify(CONFIG)],
    ['.teamctx/contributions.jsonl', ''],
    ['.teamctx/project.json', JSON.stringify({
      name: 'Ledger',
      records: [
        { id: 'r1', key: 'R-1', type: 'rule', text: 'every change is reviewed', status: 'active' },
        { id: 'x1', key: 'X-1', type: 'exception', text: 'hotfixes skip review', status: 'active', expiresAt: '2000-01-01', links: { bends: 'r1' } },
      ],
      tasks: [],
    })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product',
      records: [
        { id: 'w1', key: 'D-2', type: 'decision', text: 'price it monthly', status: 'active' },
        { id: 'a1', key: 'A-1', type: 'assumption', text: 'buyers pay by card', status: 'broken', brokenAt: BROKEN_AT },
        { id: 'd1', key: 'D-3', type: 'decision', text: 'card checkout only', status: 'active', links: { restsOn: ['a1'] } },
        { id: 'd2', key: 'D-4', type: 'decision', text: 'no invoicing', status: 'active', links: { restsOn: ['a1'] }, reviewedAt: '2026-09-02T10:00:00.000Z' },
      ],
      tasks: [],
    })],
    ['.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech',
      records: [
        { id: 't-secret', key: 'A-2', type: 'assumption', text: 'the tech-only secret assumption', status: 'active', reviewBy: '2000-01-01' },
      ],
      tasks: [],
    })],
    ['.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', summary: 'adds annual billing', workstream: 'product',
      operations: [
        { type: 'addRecord', record: { type: 'decision', text: 'offer annual billing too' } },
        { type: 'addTask', title: 'Draft the annual plan copy' },
      ],
    })],
    ['.teamctx/queue/c-2.json', JSON.stringify({
      id: 'c-2', status: 'pending', author: 'Priya', summary: 'switches to weekly pricing', workstream: 'product',
      operations: [{ type: 'addRecord', record: { type: 'decision', text: 'price it weekly' } }],
      contradictions: [{ operationIndex: 0, proposedText: 'price it weekly',
        record: { id: 'w1', key: 'D-2', type: 'decision', text: 'price it monthly', workstream: 'product' } }],
    })],
  ]);
}

async function signIn(user) { await kvSet(keys.session('s'), user); }

async function visit(path, user) {
  if (user) await signIn(user);
  const res = await fetch(`${base}${path}`, { redirect: 'manual', headers: user ? { cookie: 'teamctx_sid=s' } : {} });
  return { status: res.status, location: res.headers.get('location') || '', body: await res.text() };
}

async function act(id, fields, user = MANAGER, origin = base) {
  await signIn(user);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) body.append(k, one);
  const res = await fetch(`${base}/project/acme/ledger/review/${id}`, {
    method: 'POST', redirect: 'manual', body,
    headers: { cookie: 'teamctx_sid=s', 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
  });
  return { status: res.status, location: res.headers.get('location') || '', body: await res.text() };
}

const product = () => JSON.parse(repo.files.get('.teamctx/workstreams/product.json'));

// A Google sign-in reads through the access the manager lent the project.
const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

beforeEach(async () => {
  __resetMemory();
  project();
  await lend();
});

describe('the tabs', () => {
  it('gives the manager Current state first and open, then Tasks, then one Review tab counting both sections', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const tabs = /<nav class="tabs"[\s\S]*?<\/nav>/.exec(body)[0];
    expect(tabs.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toMatch(/^ Current state \d+ Tasks \d+ open Review 5 $/);
    expect(tabs).toMatch(/aria-current="page">Current state/);
    expect(tabs).toMatch(/Review<span class="n warn">5/);
  });

  it('shows both sections in the Review tab, the queue first', async () => {
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toMatch(/aria-current="page">Review/);
    expect(body.indexOf('Waiting for you —')).toBeGreaterThan(-1);
    expect(body.indexOf('Needs review — across the whole project')).toBeGreaterThan(body.indexOf('Waiting for you —'));
  });

  it('pages each section on its own, each pager keeping the other’s place', async () => {
    for (let i = 0; i < 12; i++) {
      repo.files.set(`.teamctx/queue/q-${i}.json`, JSON.stringify({
        id: `q-${i}`, status: 'pending', author: 'Priya', summary: `queued ${i}`, workstream: 'product',
        operations: [{ type: 'addTask', title: `task ${i}` }],
      }));
    }
    const tech = JSON.parse(repo.files.get('.teamctx/workstreams/tech.json'));
    for (let i = 0; i < 12; i++) tech.records.push({ id: `old-${i}`, type: 'assumption', text: `stale ${i}`, status: 'active', reviewBy: '2000-01-02' });
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify(tech));

    const first = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect((first.body.match(/<nav class="pager"/g) || []).length).toBe(2);
    expect(first.body).toContain('href="/project/acme/ledger?tab=review&amp;page=2#panel"');
    expect(first.body).toContain('href="/project/acme/ledger?tab=review&amp;npage=2#panel"');

    const both = await visit('/project/acme/ledger?tab=review&page=2&npage=2', MANAGER);
    expect(both.body).toContain('href="/project/acme/ledger?tab=review&amp;npage=2#panel"'); // queue back to 1, needs stays
    expect(both.body).toContain('href="/project/acme/ledger?tab=review&amp;page=2#panel"'); // needs back to 1, queue stays
    expect(both.body).toContain('stale 11');
    expect(both.body).not.toContain('the tech-only secret assumption');
  });

  it('gives a member Current state and Tasks only', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MEMBER);
    const tabs = /<nav class="tabs"[\s\S]*?<\/nav>/.exec(body)[0];
    expect(tabs.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toMatch(/^ Current state \d+ Tasks \d+ open $/);
  });
});

describe('waiting for you', () => {
  it('shows one card per contribution, its changes under it, and says how many of each', async () => {
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toContain('2 waiting · 3 changes');
    expect((body.match(/<article class="proposal card">/g) || []).length).toBe(2);
    const card = /<article class="proposal card">[\s\S]*?<\/article>/.exec(body.slice(body.indexOf('adds annual billing') - 2000))[0];
    expect(card).toContain('2 changes in this contribution');
    expect(card).toMatch(/<div class="changes">[\s\S]*offer annual billing too[\s\S]*Draft the annual plan copy/);
  });

  it('lets the manager approve from the page, and the change is then part of the context', async () => {
    const res = await act('c-1', { action: 'approve' });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/project/acme/ledger?tab=review&done=approved#panel');
    expect(product().records.map(r => r.text)).toContain('offer annual billing too');

    const after = await visit('/project/acme/ledger?tab=review&done=approved', MANAGER);
    expect(after.body).toContain('Approved — it is now part of the team’s context.');
    expect(after.body).not.toContain('adds annual billing');
    expect(after.body).toContain('1 waiting · 1 change');
  });

  it('lets the manager reject from the page, changing nothing in the context', async () => {
    const before = repo.files.get('.teamctx/workstreams/product.json');
    const res = await act('c-1', { action: 'reject', reason: 'not this quarter' });
    expect(res.location).toBe('/project/acme/ledger?tab=review&done=rejected#panel');
    expect(repo.files.get('.teamctx/workstreams/product.json')).toBe(before);
    const after = await visit('/project/acme/ledger?tab=review&done=rejected', MANAGER);
    expect(after.body).toContain('Rejected — nothing was changed.');
    expect(after.body).not.toContain('adds annual billing');
  });

  it('asks which record a contradicting contribution replaces, and needs the answer to approve', async () => {
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toMatch(/Approving this replaces:[\s\S]*name="replaces" value="D-2" required/);

    const refused = await act('c-2', { action: 'approve' });
    expect(refused.status).toBe(409);
    expect(refused.body).toContain('Contradicts');
    expect(product().records.find(r => r.id === 'w1').status).toBe('active');

    const ok = await act('c-2', { action: 'approve', replaces: 'D-2' });
    expect(ok.status).toBe(303);
    const records = product().records;
    expect(records.find(r => r.id === 'w1').status).not.toBe('active');
    expect(records.find(r => r.text === 'price it weekly')?.links?.replaces).toBe('w1');
  });

  it('says where an inherited conflict can be resolved, instead of offering an Approve that would fail', async () => {
    repo.files.set('.teamctx/queue/c-3.json', JSON.stringify({
      id: 'c-3', status: 'pending', author: 'Priya', summary: 'lets product skip review', workstream: 'product',
      operations: [{ type: 'addRecord', record: { type: 'rule', text: 'product changes skip review' } }],
      contradictions: [{ operationIndex: 0, proposedText: 'product changes skip review',
        record: { id: 'r1', key: 'R-1', type: 'rule', text: 'every change is reviewed', workstream: null } }],
    }));
    const { body } = await visit('/project/acme/ledger?tab=review&item=c-3', MANAGER);
    const card = body.slice(body.lastIndexOf('<article', body.indexOf('lets product skip review')));
    expect(card).toMatch(/Conflicts with R-1 Rule: every change is reviewed in Ledger\. Replace or retire it there first/);
    expect(card).toMatch(/<button type="submit" class="primary" disabled>Approve/);
    expect(card.slice(0, card.indexOf('</article>'))).not.toContain('name="replaces"');
  });

  it('refuses a member who posts an approval, the way the CLI would, and changes nothing', async () => {
    const before = new Map(repo.files);
    const res = await act('c-1', { action: 'approve' }, MEMBER);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('Approved —');
    expect(repo.files).toEqual(before);
  });

  it('refuses a post from another site', async () => {
    const before = new Map(repo.files);
    const res = await act('c-1', { action: 'approve' }, MANAGER, 'https://elsewhere.example');
    expect(res.status).toBe(403);
    expect(repo.files).toEqual(before);
  });

  it('says plainly when the contribution has already been handled', async () => {
    await act('c-1', { action: 'reject' });
    const again = await act('c-1', { action: 'approve' });
    expect(again.status).toBe(409);
    expect(again.body).toMatch(/class="note"/);
    expect(again.body).not.toContain('Approved —');
  });
});

describe('needs review', () => {
  it('shows a broken assumption with what rests on it, re-confirmed ones marked as such', async () => {
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    const panel = body.slice(body.indexOf('Needs review — across the whole project'));
    expect(panel).toMatch(/A-1[\s\S]*buyers pay by card[\s\S]*Rests on it/);
    expect(panel).toMatch(/D-3[\s\S]*card checkout only[\s\S]*Needs re-confirming/);
    expect(panel).toMatch(/D-4[\s\S]*no invoicing[\s\S]*Re-confirmed/);
    expect(panel).toContain('href="/project/acme/ledger?ws=product&amp;item=a1#panel"');
  });

  it('lists assumptions past their check-by date and exceptions ending or ended, wherever they are', async () => {
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toMatch(/Past their check-by date[\s\S]*the tech-only secret assumption[\s\S]*check by 2000-01-01/);
    expect(body).toMatch(/Exceptions ending within 14 days[\s\S]*hotfixes skip review[\s\S]*ended/);
  });

  it('is never given to a member, not even when they ask for the Review tab', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&tab=review', MEMBER);
    expect(body).not.toContain('across the whole project');
    expect(body).not.toContain('the tech-only secret assumption');
    expect(body).toMatch(/aria-current="page">Current state/);
  });
});

describe('a scoped member’s page data', () => {
  it('has nothing from outside their parts: no queue, no second look, no other part', async () => {
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER });
    expect(view.pending).toBeNull();
    expect(view.needsReview).toBeNull();
    expect(JSON.stringify(view)).not.toContain('the tech-only secret assumption');
  });
});

describe('an item that is not here', () => {
  it('says so, and never writes the value back', async () => {
    const asked = 'gone-<b>zzq</b>';
    const { status, body } = await visit(`/project/acme/ledger?item=${encodeURIComponent(asked)}`, MANAGER);
    expect(status).toBe(200);
    expect(body).toContain('That item isn’t here anymore.');
    expect(body).not.toContain('zzq');
  });

  it('says so for a well-formed link to something gone', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&item=gone-zzq', MANAGER);
    expect(body).toContain('That item isn’t here anymore.');
    expect(body).not.toContain('zzq');
  });

  it('says nothing when the item is there', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(body).not.toContain('isn’t here anymore');
  });
});
