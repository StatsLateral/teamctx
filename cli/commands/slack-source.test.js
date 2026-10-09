/**
 * A Slack thread as a connected source (#169), end to end: imported with the
 * shipped Slack importer, or passed by the person's assistant, it is recorded
 * under Slack with its link, a summary, when, and what it feeds — and never the
 * messages or the token.
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

const TOKEN = 'xoxp-THE-SECRET-TOKEN';
const MESSAGE = 'we agreed to price by seat, not by team';
let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const as = fn => runWithActor(manager, fn);
const written = () => readdirSync(join(dir, 'sources')).map(f => readFileSync(join(dir, 'sources', f), 'utf-8')).join('\n');

const slackApi = () => vi.fn(async (url) => {
  const method = String(url).split('/api/')[1];
  const body = {
    'auth.test': { url: 'https://acme.slack.com/' },
    'users.list': { members: [{ id: 'U1', name: 'priya' }] },
    'conversations.replies': { messages: [{ user: 'U1', ts: '1700000000.000100', text: MESSAGE }] },
  }[method] || {};
  return { ok: true, status: 200, json: async () => ({ ok: true, ...body }) };
});

let realFetch;
beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  globalThis.fetch = slackApi();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-slack-src-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'sales', number: 1, name: 'Sales' }], nextKey: { workstream: 2, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  proposeDiff.mockResolvedValue({ summary: 'Seat pricing agreed in Slack', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Price by seat' } }] });
});
afterEach(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

describe('a Slack thread brought in by teamctx import', () => {
  it('is recorded under Slack with its permalink, the thread id, a summary and when', async () => {
    const r = await as(() => importDocuments({
      paths: ['https://acme.slack.com/archives/C0SALES/p1700000000000100'], from: 'slack',
      env: { SLACK_TOKEN: TOKEN }, workstreamId: 'sales', teamctxDir: dir, cwd: dir,
    }));
    expect(r.results).toHaveLength(1);
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({
      connector: 'slack', link: 'https://acme.slack.com/archives/C0SALES/p1700000000000100', itemId: 'slack:C0SALES/p1700000000000100',
      feeds: [{ workstream: 'sales', contribution: r.results[0].contributionId, summary: 'Seat pricing agreed in Slack', via: 'import' }],
    });
    expect(Date.parse(ref.feeds[0].at)).not.toBeNaN();
    // Titled by where and when, not by anybody's message (no channel name here).
    expect(ref.title).toBe('Slack thread, 2023-11-14');
  });

  it('never writes the messages or the token', async () => {
    await as(() => importDocuments({
      paths: ['https://acme.slack.com/archives/C0SALES/p1700000000000100'], from: 'slack',
      env: { SLACK_TOKEN: TOKEN }, workstreamId: 'sales', teamctxDir: dir, cwd: dir,
    }));
    const files = written();
    expect(files).not.toContain(TOKEN);
    expect(files).not.toContain('price by seat, not by team');
  });
});

describe('a Slack thread passed by the person’s assistant', () => {
  it('is recorded under Slack, by whatever name the assistant calls it, without a credential', async () => {
    const r = await as(() => contributeCore({
      text: 'From the pricing thread: price by seat.', workstreamId: 'sales', teamctxDir: dir, source: 'mcp',
      sources: [{ connector: 'Slack', title: '#pricing: seats vs teams', link: 'https://acme.slack.com/archives/C0SALES/p1700000000000100?t=xoxp-LEAK', summary: 'Decided per-seat pricing' }],
    }));
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref).toMatchObject({
      connector: 'slack', title: '#pricing: seats vs teams', link: 'https://acme.slack.com/archives/C0SALES/p1700000000000100?t=xoxp-LEAK',
      feeds: [{ contribution: r.id, summary: 'Decided per-seat pricing', via: 'assistant' }],
    });
    // No Slack call is made on this route: teamctx holds no Slack credential.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
