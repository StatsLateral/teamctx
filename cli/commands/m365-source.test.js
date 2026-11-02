/**
 * A SharePoint file as a connected source (#172), end to end: imported with the
 * shipped Microsoft 365 importer, or passed by the person's assistant, it is
 * recorded under Microsoft SharePoint by its address, with a summary, when, and
 * what it feeds — and never the file's text, the token, or a sharing link.
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

const TOKEN = 'eyJ0eXAi.THE-SECRET-TOKEN';
const BODY = 'Release 2.4 ships the new export screen on 3 November';
const ADDRESS = 'https://contoso.sharepoint.com/sites/Team/Shared%20Documents/Release%20notes.md';
const SHARE = 'https://contoso.sharepoint.com/:t:/s/Team/EaBcDeFgHiJkLmNoPqRsTuVwXyZ?e=Xy12Ab';
let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const as = fn => runWithActor(manager, fn);
const written = () => readdirSync(join(dir, 'sources')).map(f => readFileSync(join(dir, 'sources', f), 'utf-8')).join('\n');

const graph = () => vi.fn(async (url) => {
  const u = decodeURIComponent(String(url));
  if (u.includes('/content')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(BODY, 'utf8'), json: async () => ({}) };
  const body = u.includes('/root:/')
    ? { id: 'item1', name: 'Release notes.md', file: { mimeType: 'text/markdown' }, size: BODY.length, webUrl: ADDRESS, lastModifiedDateTime: '2026-10-01T00:00:00Z', parentReference: { driveId: 'drive1', path: '/drive/root:/Shared Documents' } }
    : { id: 'site1' };
  return { ok: true, status: 200, json: async () => body };
});

let realFetch;
beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  globalThis.fetch = graph();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-m365-src-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'release', number: 1, name: 'Release' }], nextKey: { workstream: 2, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('release', makeWorkstream('release'), dir);
  proposeDiff.mockResolvedValue({ summary: 'Release 2.4 date set', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Ship 2.4 on 3 November' } }] });
});
afterEach(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

const importFile = () => as(() => importDocuments({
  paths: [`${ADDRESS}?web=1`], from: 'm365',
  env: { M365_ACCESS_TOKEN: TOKEN }, workstreamId: 'release', teamctxDir: dir, cwd: dir,
}));

describe('a SharePoint file brought in by teamctx import', () => {
  it('is recorded under Microsoft SharePoint by its address, with its name, a summary and when', async () => {
    const r = await importFile();
    expect(r.results).toHaveLength(1);
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({
      connector: 'm365', title: 'Release notes.md', link: ADDRESS,
      feeds: [{ workstream: 'release', contribution: r.results[0].contributionId, summary: 'Release 2.4 date set', via: 'import' }],
    });
  });

  it('never writes the file text or the token', async () => {
    await importFile();
    const files = written();
    expect(files).not.toContain(TOKEN);
    expect(files).not.toContain(BODY);
  });
});

describe('a SharePoint file passed by the person’s assistant', () => {
  it('lands on the same reference as the import when it brings the address, without a Microsoft call', async () => {
    await importFile();
    globalThis.fetch.mockClear();
    const r = await as(() => contributeCore({
      text: 'From the release notes: 2.4 on 3 November.', workstreamId: 'release', teamctxDir: dir, source: 'mcp',
      sources: [{ connector: 'SharePoint', title: 'Release notes.md', link: `${ADDRESS}#dates`, summary: '2.4 ships 3 November' }],
    }));
    const refs = Object.values(readSourceRefs(dir));
    expect(refs).toHaveLength(1);
    expect(refs[0].feeds.at(-1)).toMatchObject({ contribution: r.id, summary: '2.4 ships 3 November', via: 'assistant' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps one brought with only a sharing link by its name, and never writes the link', async () => {
    await as(() => contributeCore({
      text: 'From the release notes: 2.4 on 3 November.', workstreamId: 'release', teamctxDir: dir, source: 'mcp',
      sources: [{ connector: 'OneDrive', title: 'Release notes.md', link: SHARE, summary: '2.4 ships 3 November' }],
    }));
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({ connector: 'm365', title: 'Release notes.md', link: null });
    expect(written()).not.toContain('EaBcDeFgHiJkLmNoPqRsTuVwXyZ');
  });
});
