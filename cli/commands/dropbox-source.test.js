/**
 * A Dropbox file as a connected source (#173), end to end: imported with the
 * shipped Dropbox importer, or passed by the person's assistant, it is recorded
 * under Dropbox by its address, with a summary, when, and what it feeds — and
 * never the file's text, the token, or a shared link.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, readSourceRefs } from '../../src/storage.js';
import { importDocuments } from './import.core.js';
import { contributeCore } from './contribute.core.js';
import { proposeDiff } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({ ...(await original()), proposeDiff: vi.fn(), callClaude: vi.fn(async ({ prompt }) => prompt) }));

const TOKEN = 'sl.THE-SECRET-TOKEN';
const BODY = 'Badges are printed on the Friday before, 200 copies';
const ADDRESS = 'https://www.dropbox.com/home/Webhacks?preview=Badge%20plan.md';
const SHARE = 'https://www.dropbox.com/scl/fi/abc123/Badge%20plan.md?rlkey=SECRETKEY&dl=0';
let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const as = fn => runWithActor(manager, fn);
const written = () => readdirSync(join(dir, 'sources')).map(f => readFileSync(join(dir, 'sources', f), 'utf-8')).join('\n');

const meta = { '.tag': 'file', name: 'Badge plan.md', path_lower: '/webhacks/badge plan.md', path_display: '/Webhacks/Badge plan.md', id: 'id:abc', is_downloadable: true, server_modified: '2026-10-01T00:00:00Z', size: BODY.length };
const dropboxApi = () => vi.fn(async (url) => {
  const u = String(url);
  if (u.startsWith('https://content.dropboxapi.com')) return { ok: true, status: 200, text: async () => BODY };
  return { ok: true, status: 200, json: async () => meta };
});

let realFetch;
beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  globalThis.fetch = dropboxApi();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-dropbox-src-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'goodies', number: 1, name: 'Goodies' }], nextKey: { workstream: 2, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('goodies', makeWorkstream('goodies'), dir);
  proposeDiff.mockResolvedValue({ summary: 'Badges printed the Friday before', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Print 200 badges on Friday' } }] });
});
afterEach(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

const importFrom = path => as(() => importDocuments({
  paths: [path], from: 'dropbox',
  env: { DROPBOX_ACCESS_TOKEN: TOKEN }, workstreamId: 'goodies', teamctxDir: dir, cwd: dir,
}));

describe('a Dropbox file brought in by teamctx import', () => {
  it('is recorded under Dropbox by its address, with its name, a summary and when', async () => {
    const r = await importFrom('/Webhacks/Badge plan.md');
    expect(r.results).toHaveLength(1);
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({
      connector: 'dropbox', title: 'Badge plan.md', link: ADDRESS,
      feeds: [{ workstream: 'goodies', contribution: r.results[0].contributionId, summary: 'Badges printed the Friday before', via: 'import' }],
    });
  });

  it('keeps one reached through a shared link by its name, never the link', async () => {
    await importFrom(SHARE);
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({ connector: 'dropbox', title: 'Badge plan.md', link: null });
    expect(written()).not.toContain('SECRETKEY');
  });

  it('never writes the file text or the token', async () => {
    await importFrom('/Webhacks/Badge plan.md');
    const files = written();
    expect(files).not.toContain(TOKEN);
    expect(files).not.toContain(BODY);
  });
});

describe('a Dropbox file passed by the person’s assistant', () => {
  it('lands on the same reference as the import when it brings the address, without a Dropbox call', async () => {
    await importFrom('/Webhacks/Badge plan.md');
    globalThis.fetch.mockClear();
    const r = await as(() => contributeCore({
      text: 'From the badge plan: print on Friday.', workstreamId: 'goodies', teamctxDir: dir, source: 'mcp',
      sources: [{ connector: 'Dropbox', title: 'Badge plan.md', link: `${ADDRESS}&di=left_nav`, summary: 'Badges on Friday' }],
    }));
    const refs = Object.values(readSourceRefs(dir));
    expect(refs).toHaveLength(1);
    expect(refs[0].feeds.at(-1)).toMatchObject({ contribution: r.id, summary: 'Badges on Friday', via: 'assistant' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
