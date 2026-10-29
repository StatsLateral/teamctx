/**
 * A Google Drive file as a connected source (#171), end to end: imported with the
 * shipped Drive importer, or passed by the person's assistant, it is recorded
 * once under Google Drive with its link, a summary, when, and what it feeds —
 * and never the file's text or the token.
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

const TOKEN = 'ya29.THE-SECRET-TOKEN';
const BODY = 'Hall A seats 120, Hall B seats 100; both have projectors';
const DOC = '1DocumentIdBbbbbbbbbbbbbbbbbbbbb';
let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const as = fn => runWithActor(manager, fn);
const written = () => readdirSync(join(dir, 'sources')).map(f => readFileSync(join(dir, 'sources', f), 'utf-8')).join('\n');

const driveApi = () => vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('/export')) return { ok: true, status: 200, text: async () => BODY, json: async () => ({}) };
  const meta = { id: DOC, name: 'Hall floor plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T00:00:00.000Z', webViewLink: `https://docs.google.com/document/d/${DOC}/edit?usp=drivesdk` };
  return { ok: true, status: 200, json: async () => meta, text: async () => JSON.stringify(meta) };
});

let realFetch;
beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  globalThis.fetch = driveApi();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-gdrive-src-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'venue', number: 1, name: 'Venue' }], nextKey: { workstream: 2, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('venue', makeWorkstream('venue'), dir);
  proposeDiff.mockResolvedValue({ summary: 'Two halls, both with projectors', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Use Halls A and B' } }] });
});
afterEach(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

const importFile = () => as(() => importDocuments({
  paths: [`https://docs.google.com/document/d/${DOC}/edit?usp=sharing`], from: 'gdrive',
  env: { GDRIVE_ACCESS_TOKEN: TOKEN }, workstreamId: 'venue', teamctxDir: dir, cwd: dir,
}));

describe('a Drive file brought in by teamctx import', () => {
  it('is recorded under Google Drive with its link, the file id, its name, a summary and when', async () => {
    const r = await importFile();
    expect(r.results).toHaveLength(1);
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({
      connector: 'gdrive', title: 'Hall floor plan', link: `https://drive.google.com/file/d/${DOC}/view`, itemId: `gdrive:${DOC}`,
      feeds: [{ workstream: 'venue', contribution: r.results[0].contributionId, summary: 'Two halls, both with projectors', via: 'import' }],
    });
    expect(Date.parse(ref.feeds[0].at)).not.toBeNaN();
  });

  it('never writes the file text or the token', async () => {
    await importFile();
    const files = written();
    expect(files).not.toContain(TOKEN);
    expect(files).not.toContain(BODY);
  });
});

describe('a Drive file passed by the person’s assistant', () => {
  it('lands on the same reference as the import, without a Drive call', async () => {
    await importFile();
    globalThis.fetch.mockClear();
    const r = await as(() => contributeCore({
      text: 'From the floor plan: two halls.', workstreamId: 'venue', teamctxDir: dir, source: 'mcp',
      sources: [{ connector: 'Google Drive', title: 'Hall floor plan', link: `https://drive.google.com/file/d/${DOC}/view?usp=drive_link`, summary: 'Two halls with projectors' }],
    }));
    const refs = Object.values(readSourceRefs(dir));
    expect(refs).toHaveLength(1);
    expect(refs[0].feeds.at(-1)).toMatchObject({ contribution: r.id, summary: 'Two halls with projectors', via: 'assistant' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
