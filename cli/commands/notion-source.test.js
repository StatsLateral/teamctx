/**
 * A Notion page as a connected source (#170), end to end: imported with the
 * shipped Notion importer, or passed by the person's assistant, it is recorded
 * once under Notion with its link, a summary, when, and what it feeds — and
 * never the page's text or the token.
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

const TOKEN = 'ntn_THE-SECRET-TOKEN';
const BODY = 'launch only once billing has been signed off';
const PAGE = '1a2b3c4d5e6f47788899aabbccddeeff';
let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const as = fn => runWithActor(manager, fn);
const written = () => readdirSync(join(dir, 'sources')).map(f => readFileSync(join(dir, 'sources', f), 'utf-8')).join('\n');

const notionApi = () => vi.fn(async (url) => {
  const u = String(url);
  const body = u.includes('/children')
    ? { object: 'list', results: [{ object: 'block', id: 'b1', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', plain_text: BODY }] }, has_children: false }], has_more: false }
    : { object: 'page', id: PAGE, url: `https://www.notion.so/Launch-checklist-${PAGE}`, properties: { Name: { type: 'title', title: [{ type: 'text', plain_text: 'Launch checklist' }] } } };
  return { ok: true, status: 200, json: async () => body };
});

let realFetch;
beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  globalThis.fetch = notionApi();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-notion-src-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'launch', number: 1, name: 'Launch' }], nextKey: { workstream: 2, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('launch', makeWorkstream('launch'), dir);
  proposeDiff.mockResolvedValue({ summary: 'Launch waits for billing sign-off', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Launch after billing sign-off' } }] });
});
afterEach(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

const importPage = () => as(() => importDocuments({
  paths: [`https://www.notion.so/acme/Launch-checklist-${PAGE}?pvs=4`], from: 'notion',
  env: { NOTION_TOKEN: TOKEN }, workstreamId: 'launch', teamctxDir: dir, cwd: dir,
}));

describe('a Notion page brought in by teamctx import', () => {
  it('is recorded under Notion with its link, the page id, its title, a summary and when', async () => {
    const r = await importPage();
    expect(r.results).toHaveLength(1);
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({
      connector: 'notion', title: 'Launch checklist', link: `https://www.notion.so/${PAGE}`, itemId: `notion:${PAGE.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')}`,
      feeds: [{ workstream: 'launch', contribution: r.results[0].contributionId, summary: 'Launch waits for billing sign-off', via: 'import' }],
    });
    expect(Date.parse(ref.feeds[0].at)).not.toBeNaN();
  });

  it('never writes the page text or the token', async () => {
    await importPage();
    const files = written();
    expect(files).not.toContain(TOKEN);
    expect(files).not.toContain(BODY);
  });
});

describe('a Notion page passed by the person’s assistant', () => {
  it('lands on the same reference as the import, without a Notion call', async () => {
    await importPage();
    globalThis.fetch.mockClear();
    const r = await as(() => contributeCore({
      text: 'From the launch page: billing sign-off first.', workstreamId: 'launch', teamctxDir: dir, source: 'mcp',
      sources: [{ connector: 'Notion', title: 'Launch checklist', link: `https://www.notion.so/Launch-checklist-${PAGE}#0f1e2d3c4b5a69788796a5b4c3d2e1f0`, summary: 'Billing sign-off before launch' }],
    }));
    const refs = Object.values(readSourceRefs(dir));
    expect(refs).toHaveLength(1);
    expect(refs[0].feeds.at(-1)).toMatchObject({ contribution: r.id, summary: 'Billing sign-off before launch', via: 'assistant' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
