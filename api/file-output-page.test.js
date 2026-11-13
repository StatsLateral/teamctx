/**
 * Attaching and downloading a file output from the project page (#247).
 *
 * The routes are driven for real over HTTP, against a session that persists
 * writes in memory: a member uploads a file to a task in their scope, it is
 * stored and can be downloaded back byte-for-byte as an attachment; an
 * over-limit or wrong-type file is refused with a message; a task out of the
 * member's scope serves and stores nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map() }));

vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  listPushableRepos: async () => [],
  listUserOrgs: async () => [],
  // A session that persists writes straight into the map, so a write this
  // request makes is readable in the same request and by the next one.
  GithubSession: class {
    constructor({ owner, repo: name, ghToken }) { Object.assign(this, { owner, repo: name, ghToken }); }
    async prefetch() {}
    read(p) { return repo.files.has(p) ? { content: repo.files.get(p) } : null; }
    write(p, c) { repo.files.set(p, String(c)); }
    writeBytes(p, b) { repo.files.set(p, Buffer.from(b)); }
    async readBytes(p) {
      const v = repo.files.get(p);
      if (v == null) return null;
      return Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
    }
    del(p) { repo.files.delete(p); }
    listDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...repo.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    }
    async commit() { return { committed: true }; }
  },
}));

const { kvSet, keys, __resetMemory } = await import('../src/oauth/kv.js');

// A minimal but real 1x1 PNG — the type sniff recognises it, and it carries
// NUL and high bytes, so a UTF-8 round-trip would wreck it.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const MEMBER = { id: '9', login: 'priya', name: 'Priya', email: 'priya@example.com', token: 'gho-priya' };
const CONFIG = {
  project: 'Ledger', managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', number: 1, name: 'Product' }, { id: 'tech', number: 2, name: 'Tech' }],
  roles: [],
  // On the roster, scoped to product only, keyed to the GitHub id this sign-in carries.
  members: [{ key: 'github:9', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] }],
};

function project() {
  repo.files = new Map([
    ['.teamctx/config.json', JSON.stringify(CONFIG)],
    ['.teamctx/project.json', JSON.stringify({ name: 'Ledger', records: [], tasks: [] })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', records: [],
      tasks: [{ id: 'prod-task', key: '1.1', title: 'Draft the deck', owner: 'Priya', workstream: 'product', status: 'open' }],
    })],
    ['.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech', records: [],
      tasks: [{ id: 'tech-task', key: '2.1', title: 'Migrate the db', owner: 'Dev', workstream: 'tech', status: 'open' }],
    })],
  ]);
}

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

beforeEach(() => { __resetMemory(); project(); });

async function signedIn() { await kvSet(keys.session('s'), MEMBER); return { cookie: 'teamctx_sid=s' }; }

async function attach(taskId, { bytes = PNG, name = 'banner.png', type = 'image/png', title, note } = {}) {
  const headers = await signedIn();
  const form = new FormData();
  form.set('file', new Blob([bytes], { type }), name);
  if (title != null) form.set('title', title);
  if (note != null) form.set('note', note);
  const res = await fetch(`${base}/project/acme/ledger/task/${taskId}/attach`, {
    method: 'POST', redirect: 'manual', headers, body: form,
  });
  return { status: res.status, location: res.headers.get('location') || '', body: await res.text() };
}

function savedOutput(taskId) {
  const prefix = `.teamctx/outputs/${taskId}/`;
  const name = [...repo.files.keys()].find(p => p.startsWith(prefix) && p.endsWith('.json') && !p.includes('/files/'));
  return name ? JSON.parse(repo.files.get(name)) : null;
}

describe('attaching a file from the project page', () => {
  it('stores the file and its record, and downloads it back byte-for-byte', async () => {
    const r = await attach('prod-task', { title: 'Banner', note: 'first cut' });
    expect(r.status).toBe(303);
    expect(r.location).toContain('/project/acme/ledger');

    const output = savedOutput('prod-task');
    expect(output).toMatchObject({ kind: 'file', title: 'Banner', notes: 'first cut', source: 'web' });
    expect(output.file).toMatchObject({ name: 'banner.png', type: 'image/png', size: PNG.length });
    // The bytes are in the repo, unmangled.
    expect(repo.files.get(`.teamctx/${output.file.path}`).equals(PNG)).toBe(true);

    const headers = await signedIn();
    const dl = await fetch(`${base}/project/acme/ledger/task/prod-task/file/${output.id}`, { headers, redirect: 'manual' });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('image/png');
    expect(dl.headers.get('content-disposition')).toMatch(/attachment; filename="banner.png"/);
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    const got = Buffer.from(await dl.arrayBuffer());
    expect(got.equals(PNG)).toBe(true);
  });

  it('refuses a file whose bytes do not match its name, storing nothing', async () => {
    const r = await attach('prod-task', { bytes: Buffer.from('just text, not a png'), name: 'banner.png' });
    expect(r.status).toBe(400);
    expect(savedOutput('prod-task')).toBeNull();
  });

  it('refuses a file over the page limit, with a message that names the command line', async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41);
    const r = await attach('prod-task', { bytes: big, name: 'big.txt', type: 'text/plain' });
    expect(r.status).toBe(413);
    expect(r.body).toMatch(/command line/i);
    expect(savedOutput('prod-task')).toBeNull();
  });

  it('refuses to attach to a task outside the member\'s scope, storing nothing', async () => {
    const r = await attach('tech-task');
    expect(r.status).toBe(403);
    expect(savedOutput('tech-task')).toBeNull();
  });

  it('refuses a closed task cleanly, not as a 500 to retry forever', async () => {
    // The task was accepted and closed; attaching is a dead end, said plainly.
    repo.files.set('.teamctx/approved/a1.json', JSON.stringify({ id: 'a1', forTask: 'prod-task', approvedBy: { name: 'Maya' } }));
    const r = await attach('prod-task');
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/accepted|closed/i);
    expect(savedOutput('prod-task')).toBeNull();
  });
});

describe('downloading a file output', () => {
  it('serves nothing for a task outside the member\'s scope', async () => {
    // A file really exists on the tech task; the product-scoped member still cannot have it.
    await kvSet(keys.session('s'), MEMBER);
    repo.files.set('.teamctx/outputs/tech-task/o-x.json', JSON.stringify({
      id: 'o-x', task: 'tech-task', kind: 'file', title: 'secret',
      file: { name: 's.png', type: 'image/png', size: PNG.length, sha256: 'x', path: 'outputs/tech-task/files/o-x-s.png' },
    }));
    repo.files.set('.teamctx/outputs/tech-task/files/o-x-s.png', Buffer.from(PNG));
    const headers = { cookie: 'teamctx_sid=s' };
    const dl = await fetch(`${base}/project/acme/ledger/task/tech-task/file/o-x`, { headers, redirect: 'manual' });
    expect(dl.status).toBe(404);
  });

  it('is a sign-in redirect when nobody is signed in', async () => {
    const dl = await fetch(`${base}/project/acme/ledger/task/prod-task/file/o-x`, { redirect: 'manual' });
    expect([302, 303, 307]).toContain(dl.status);
  });
});
