/**
 * A Coda page as a connected source (#174), end to end: imported with the
 * shipped Coda importer, or passed by the person's assistant, it is recorded
 * under Coda by one link, with a summary, when, and what it feeds — and never
 * the page's text or the token.
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

const TOKEN = 'coda-THE-SECRET-TOKEN';
const BODY = 'Badges are printed on the Friday before, 200 copies';
const PAGE_LINK = 'https://coda.io/d/Webhacks_dAbCd1234/Badge-plan_su42';
const LINK = 'https://coda.io/d/_dAbCd1234/_su42';
let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const as = fn => runWithActor(manager, fn);
const written = () => readdirSync(join(dir, 'sources')).map(f => readFileSync(join(dir, 'sources', f), 'utf-8')).join('\n');

const json = body => ({ ok: true, status: 200, json: async () => body });
const codaApi = () => vi.fn(async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://storage.example')) return { ok: true, status: 200, text: async () => BODY };
  if (init?.method === 'POST') return json({ id: 'job1' });
  if (u.includes('/export/job1')) return json({ status: 'complete', downloadLink: 'https://storage.example/export.md' });
  return json({ items: [{ id: 'canvas-1', name: 'Badge plan', contentType: 'canvas', browserLink: PAGE_LINK }] });
});

let realFetch;
beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  globalThis.fetch = codaApi();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-coda-src-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'goodies', number: 1, name: 'Goodies' }], nextKey: { workstream: 2, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('goodies', makeWorkstream('goodies'), dir);
  proposeDiff.mockResolvedValue({ summary: 'Badges printed the Friday before', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Print 200 badges on Friday' } }] });
});
afterEach(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

const importPage = () => as(() => importDocuments({
  paths: [PAGE_LINK], from: 'coda',
  env: { CODA_TOKEN: TOKEN }, workstreamId: 'goodies', teamctxDir: dir, cwd: dir,
}));

describe('a Coda page brought in by teamctx import', () => {
  it('is recorded under Coda by its link, with its name, a summary and when', async () => {
    const r = await importPage();
    expect(r.results).toHaveLength(1);
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({
      connector: 'coda', title: 'Badge plan', link: LINK,
      feeds: [{ workstream: 'goodies', contribution: r.results[0].contributionId, summary: 'Badges printed the Friday before', via: 'import' }],
    });
  });

  it('never writes the page text or the token', async () => {
    await importPage();
    const files = written();
    expect(files).not.toContain(TOKEN);
    expect(files).not.toContain(BODY);
  });
});

describe('a Coda page passed by the person’s assistant', () => {
  it('lands on the same reference as the import, even after a rename, without a Coda call', async () => {
    await importPage();
    globalThis.fetch.mockClear();
    const r = await as(() => contributeCore({
      text: 'From the badge plan: print on Friday.', workstreamId: 'goodies', teamctxDir: dir, source: 'mcp',
      sources: [{ connector: 'Coda', title: 'Badge plan', link: 'https://coda.io/d/Webhacks-2026_dAbCd1234/Badges_su42#Tasks_tu9/r5', summary: 'Badges on Friday' }],
    }));
    const refs = Object.values(readSourceRefs(dir));
    expect(refs).toHaveLength(1);
    expect(refs[0].feeds.at(-1)).toMatchObject({ contribution: r.id, summary: 'Badges on Friday', via: 'assistant' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
