import { describe, it, expect, beforeEach, vi } from 'vitest';

// The handler fetches the URL server-side; the fetch itself (SSRF guard, size
// cap, redirects, timeout) is covered by src/oauth/fetch-remote-file.test.js.
// Here the network is mocked so these drive the handler's wiring: type check
// before the fetch, name from the URL, the store, and a clean error when the
// fetch refuses. fileNameFromUrl and RemoteFetchError stay real.
vi.mock('../src/oauth/fetch-remote-file.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchRemoteFile: vi.fn() };
});

import { makeHandlers } from './server.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';
import { fetchRemoteFile, RemoteFetchError } from '../src/oauth/fetch-remote-file.js';

const OWNER = 'acme';
const REPO = 'ledger';
const BASE = 'https://team.example.app';
const ALICE = { key: 'github:1001', name: 'Alice Example', login: 'alice', source: 'github' };

const CONFIG = {
  project: 'Ledger', me: 'whoever-ran-init', managerKey: 'github:1001',
  model: 'claude-sonnet-4-6', autoPush: false, roles: [],
  workstreams: [{ id: 'w1', number: 1, name: 'Work' }],
  activeWorkstream: null,
};

function fakeSession({ accepted = false } = {}) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: 'a' }],
    ['.teamctx/contributions.jsonl', { content: '', sha: 'b' }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Ledger', records: [{ id: 'p1', type: 'decision', text: 'ship it', status: 'active' }], tasks: [] }), sha: 'p' }],
    ['.teamctx/workstreams/w1.json', { content: JSON.stringify({
      id: 'w1', name: 'Work', records: [],
      tasks: [{ id: 't-1', key: '1.1', title: 'Make the chart', owner: 'Alice Example', workstream: 'w1', status: 'open' }],
    }), sha: 'd' }],
  ]);
  if (accepted) files.set('.teamctx/approved/a1.json', { content: JSON.stringify({ id: 'a1', forTask: 't-1', approvedBy: { name: 'Alice Example' } }), sha: 'x' });
  return {
    owner: OWNER, repo: REPO, ghToken: 'gh-write-token',
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c), sha: null }),
    writeBytes: (p, b) => files.set(p, { content: Buffer.from(b), sha: null }),
    readBytes: p => (files.get(p) ? Buffer.from(files.get(p).content) : null),
    del: p => files.delete(p),
    listDir: dirPath => {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      return [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    },
    commit: async () => ({ committed: true }),
    files,
  };
}

const hostedRoot = () => ({ __backend: 'github', owner: OWNER, repo: REPO, ghToken: 'gh-write-token', baseUrl: BASE });
const asUser = (session, actor, fn) => runWithSession(session, () => runWithActor(actor, () => fn(makeHandlers(hostedRoot()))));
const json = async (promise) => JSON.parse((await promise).content[0].text);

beforeEach(() => { __resetMemory(); fetchRemoteFile.mockReset(); });

describe('attach_file_from_url', () => {
  it('fetches the bytes server-side and stores them as a working output', async () => {
    fetchRemoteFile.mockResolvedValue({ bytes: Buffer.from('# report\n'), contentType: 'text/markdown', fileName: 'report.md', finalUrl: 'https://cdn.example/report.md' });
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.attach_file_from_url({ id: '1.1', url: 'https://cdn.example/report.md', title: 'Report' })));

    expect(r.output.kind).toBe('file');
    expect(r.output.file.name).toBe('report.md');
    expect(r.output.title).toBe('Report');
    expect(r.output.state).toBe('working');
    expect(r.output.author).toMatchObject({ name: 'Alice Example' });
    expect(r.task.id).toBe('t-1');
    expect(r.reportBack).toMatch(/never passed through you/);
    // The fetch is capped at the page limit, not left unbounded.
    expect(fetchRemoteFile).toHaveBeenCalledWith('https://cdn.example/report.md', { maxBytes: 4 * 1024 * 1024 });
    // The bytes actually landed in the repository.
    expect([...session.files.keys()].some(p => /outputs\/t-1\/.*report\.md$/.test(p))).toBe(true);
  });

  it('takes the file name from the URL when none is given', async () => {
    fetchRemoteFile.mockResolvedValue({ bytes: Buffer.from('a,b\n1,2\n'), contentType: 'text/csv', fileName: 'data.csv', finalUrl: 'https://cdn.example/data.csv' });
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.attach_file_from_url({ id: '1.1', url: 'https://cdn.example/data.csv' })));
    expect(r.output.file.name).toBe('data.csv');
  });

  it('refuses a disallowed type before fetching anything', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.attach_file_from_url({ id: '1.1', url: 'https://cdn.example/evil.exe' })))
      .rejects.toThrow(/not an allowed output type/);
    expect(fetchRemoteFile).not.toHaveBeenCalled();
  });

  it('refuses when the URL has no usable name and none is given', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.attach_file_from_url({ id: '1.1', url: 'https://cdn.example/download?id=9' })))
      .rejects.toThrow(/pass `name`/);
    expect(fetchRemoteFile).not.toHaveBeenCalled();
  });

  it('accepts an explicit name when the URL has none', async () => {
    fetchRemoteFile.mockResolvedValue({ bytes: Buffer.from('a,b\n'), contentType: null, fileName: 'download', finalUrl: 'https://cdn.example/download?id=9' });
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.attach_file_from_url({ id: '1.1', url: 'https://cdn.example/download?id=9', name: 'data.csv' })));
    expect(r.output.file.name).toBe('data.csv');
  });

  it('requires a URL', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.attach_file_from_url({ id: '1.1' })))
      .rejects.toThrow(/URL is required/);
  });

  it('surfaces a refused fetch (the SSRF guard) as a clean error', async () => {
    fetchRemoteFile.mockRejectedValue(new RemoteFetchError('that URL resolves to a non-public address (169.254.169.254)'));
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.attach_file_from_url({ id: '1.1', url: 'https://cdn.example/a.md' })))
      .rejects.toThrow(/Could not fetch that file.*non-public address/);
  });

  it('refuses an unknown task', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.attach_file_from_url({ id: '9.9', url: 'https://cdn.example/a.md' })))
      .rejects.toThrow(/No task matches/);
  });

  it('refuses an accepted task', async () => {
    const session = fakeSession({ accepted: true });
    await expect(asUser(session, ALICE, h => h.attach_file_from_url({ id: '1.1', url: 'https://cdn.example/a.md' })))
      .rejects.toThrow();
  });
});
