/**
 * Uploading a file output by one-shot URL (#257).
 *
 * request_upload mints a ticket; the chatbot's sandbox PUTs the bytes straight
 * to the returned URL, so the model never carries them. These drive that
 * endpoint for real over HTTP, against a session that persists writes in
 * memory: a ticket stores the file exactly as a page upload does and can be
 * downloaded back byte-for-byte; the ticket is single-use; an expired or unknown
 * ticket, an over-limit or wrong-type file, and an accepted task are each
 * refused, storing nothing.
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

const { __resetMemory } = await import('../src/oauth/kv.js');
const { createUploadTicket } = await import('../src/oauth/upload-tickets.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const PRIYA = { key: 'github:9', name: 'Priya', email: 'priya@example.com', source: 'github' };
const CONFIG = {
  project: 'Ledger', managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', number: 1, name: 'Product' }],
  roles: [],
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
  ]);
}

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

beforeEach(() => { __resetMemory(); project(); });

async function ticketFor(taskId = 'prod-task', over = {}) {
  const { token } = await createUploadTicket({
    owner: 'acme', repo: 'ledger', taskId, actor: PRIYA,
    name: 'banner.png', title: 'Banner', notes: 'first cut',
    ghToken: 'gho-priya', maxBytes: 4 * 1024 * 1024, ...over,
  });
  return token;
}

function put(taskId, token, bytes = PNG) {
  return fetch(`${base}/project/acme/ledger/task/${taskId}/upload/${token}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
}

function savedOutput(taskId) {
  const prefix = `.teamctx/outputs/${taskId}/`;
  const name = [...repo.files.keys()].find(p => p.startsWith(prefix) && p.endsWith('.json') && !p.includes('/files/'));
  return name ? JSON.parse(repo.files.get(name)) : null;
}

describe('uploading a file by one-shot URL', () => {
  it('stores the file like a page upload, recording the ticket holder as author', async () => {
    const token = await ticketFor();
    const res = await put('prod-task', token);
    expect(res.status).toBe(201);
    const payload = await res.json();
    expect(payload).toMatchObject({ ok: true, name: 'banner.png' });

    const output = savedOutput('prod-task');
    expect(output).toMatchObject({ kind: 'file', title: 'Banner', notes: 'first cut', source: 'web' });
    expect(output.file).toMatchObject({ name: 'banner.png', type: 'image/png', size: PNG.length });
    expect(output.author).toMatchObject({ name: 'Priya' });
    // The bytes are in the repo, unmangled.
    expect(repo.files.get(`.teamctx/${output.file.path}`).equals(PNG)).toBe(true);
  });

  it('spends the ticket once: a second PUT with the same token is refused', async () => {
    const token = await ticketFor();
    expect((await put('prod-task', token)).status).toBe(201);
    const again = await put('prod-task', token);
    expect(again.status).toBe(404);
    // Only one output was stored.
    const outputs = [...repo.files.keys()].filter(p => p.startsWith('.teamctx/outputs/prod-task/') && p.endsWith('.json') && !p.includes('/files/'));
    expect(outputs).toHaveLength(1);
  });

  it('refuses an unknown or already-used ticket', async () => {
    const res = await put('prod-task', 'not-a-real-ticket');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not valid|expired|already been used/i);
    expect(savedOutput('prod-task')).toBeNull();
  });

  it('refuses a ticket redirected onto a different task, storing nothing', async () => {
    const token = await ticketFor('prod-task');
    const res = await put('other-task', token);
    expect(res.status).toBe(404);
    expect(savedOutput('other-task')).toBeNull();
  });

  it('refuses a file over the cap, with a message that names the command line', async () => {
    const token = await ticketFor();
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41);
    const res = await put('prod-task', token, big);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/command line/i);
    expect(savedOutput('prod-task')).toBeNull();
  });

  it('refuses a file whose bytes do not match its name, storing nothing', async () => {
    const token = await ticketFor();
    const res = await put('prod-task', token, Buffer.from('just text, not a png'));
    expect(res.status).toBe(400);
    expect(savedOutput('prod-task')).toBeNull();
  });

  it('refuses an empty upload', async () => {
    const token = await ticketFor();
    const res = await put('prod-task', token, Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(savedOutput('prod-task')).toBeNull();
  });

  it('refuses an accepted task cleanly, not as a 500', async () => {
    repo.files.set('.teamctx/approved/a1.json', JSON.stringify({ id: 'a1', forTask: 'prod-task', approvedBy: { name: 'Maya' } }));
    const token = await ticketFor();
    const res = await put('prod-task', token);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/accepted|closed/i);
    expect(savedOutput('prod-task')).toBeNull();
  });
});
