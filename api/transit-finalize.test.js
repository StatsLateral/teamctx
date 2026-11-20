/**
 * Finalising a transit upload by one-shot URL (#251).
 *
 * A file too big for the function body is PUT straight to a transit blob; the
 * sandbox then POSTs the finalize URL, and the server fetches those bytes back,
 * stores them exactly as a page upload does, and deletes the blob. These drive
 * that endpoint for real over HTTP, with the blob store stubbed: a transit
 * ticket stores the file byte-for-byte and deletes the blob; a wrong-type file,
 * a direct ticket, and an already-used ticket are each refused. A finalize that
 * arrives before the bytes keeps the ticket alive so it can retry once the PUT
 * lands; once there are bytes to commit, the ticket is spent and the blob gone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map() }));
const blob = vi.hoisted(() => ({ bytes: null, deleted: [] }));

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

vi.mock('../src/oauth/blob-transit.js', () => ({
  blobConfigured: () => true,
  mintBlobUpload: vi.fn(),
  fetchTransitBytes: vi.fn(async () => (blob.bytes ? { bytes: blob.bytes } : null)),
  deleteTransitBlob: vi.fn(async ({ pathname }) => { blob.deleted.push(pathname); }),
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
const PATHNAME = 'teamctx-transit/prod-task/abc/banner.png';

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

beforeEach(() => { __resetMemory(); project(); blob.bytes = PNG; blob.deleted = []; });

async function transitTicket(over = {}) {
  const { token } = await createUploadTicket({
    owner: 'acme', repo: 'ledger', taskId: 'prod-task', actor: PRIYA,
    name: 'banner.png', title: 'Banner', notes: 'first cut',
    ghToken: 'gho-priya', maxBytes: 25 * 1024 * 1024,
    transport: 'blob', blobPathname: PATHNAME, ...over,
  });
  return token;
}
const finalize = (taskId, token) => fetch(`${base}/project/acme/ledger/task/${taskId}/finalize/${token}`, { method: 'POST' });

function savedOutput(taskId) {
  const prefix = `.teamctx/outputs/${taskId}/`;
  const name = [...repo.files.keys()].find(p => p.startsWith(prefix) && p.endsWith('.json') && !p.includes('/files/'));
  return name ? JSON.parse(repo.files.get(name)) : null;
}

describe('finalising a transit upload', () => {
  it('fetches the bytes back, stores them like a page upload, and deletes the blob', async () => {
    const token = await transitTicket();
    const res = await finalize('prod-task', token);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, name: 'banner.png' });

    const output = savedOutput('prod-task');
    expect(output).toMatchObject({ kind: 'file', title: 'Banner', notes: 'first cut', source: 'web' });
    expect(output.file).toMatchObject({ name: 'banner.png', type: 'image/png', size: PNG.length });
    expect(output.author).toMatchObject({ name: 'Priya' });
    expect(repo.files.get(`.teamctx/${output.file.path}`).equals(PNG)).toBe(true);
    // Transit only: the blob is gone.
    expect(blob.deleted).toContain(PATHNAME);
  });

  it('spends the ticket once', async () => {
    const token = await transitTicket();
    expect((await finalize('prod-task', token)).status).toBe(201);
    expect((await finalize('prod-task', token)).status).toBe(404);
  });

  it('leaves the ticket and blob alone when the bytes are not there yet, so finalize can retry', async () => {
    blob.bytes = null; // the PUT has not landed yet
    const token = await transitTicket();
    const first = await finalize('prod-task', token);
    expect(first.status).toBe(404);
    expect((await first.json()).error).toMatch(/no uploaded file/i);
    expect(savedOutput('prod-task')).toBeNull();
    // Nothing spent: the ticket survives and the (absent) blob is not deleted.
    expect(blob.deleted).not.toContain(PATHNAME);

    // The PUT lands; the same ticket now finalizes cleanly.
    blob.bytes = PNG;
    const second = await finalize('prod-task', token);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ ok: true, name: 'banner.png' });
    expect(savedOutput('prod-task')).toMatchObject({ kind: 'file', title: 'Banner' });
    expect(blob.deleted).toContain(PATHNAME);
  });

  it('refuses a file whose bytes do not match its name, and deletes the blob', async () => {
    blob.bytes = Buffer.from('not a png at all');
    const token = await transitTicket();
    const res = await finalize('prod-task', token);
    expect(res.status).toBe(400);
    expect(savedOutput('prod-task')).toBeNull();
    expect(blob.deleted).toContain(PATHNAME);
  });

  it('refuses a direct ticket sent to finalize', async () => {
    const token = await transitTicket({ transport: 'direct', blobPathname: null });
    const res = await finalize('prod-task', token);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a transit upload/i);
  });

  it('refuses an unknown ticket', async () => {
    const res = await finalize('prod-task', 'not-a-real-ticket');
    expect(res.status).toBe(404);
  });

  it('refuses a transit ticket PUT to the direct upload route', async () => {
    const token = await transitTicket();
    const res = await fetch(`${base}/project/acme/ledger/task/prod-task/upload/${token}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: PNG,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/transit store/i);
  });
});
