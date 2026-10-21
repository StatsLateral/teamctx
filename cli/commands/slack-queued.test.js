/**
 * Slack hears about an item when it is queued, and only then (#182): one post
 * for a queued contribution or a task's submitted work, none for a contribution
 * applied straight away, and a webhook that fails never fails the contribution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MEMBER = { key: 'github:2002', name: 'Ravi', login: 'ravi', source: 'github' };
const MANAGER = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
let caller = MEMBER;

vi.mock('../../src/context.js', async original => ({
  ...(await original()),
  updateShared: vi.fn(async ({ workstream } = {}) => ({
    workstream: workstream || { id: 'sales', name: 'Sales', records: [], tasks: [] },
    dropped: [],
    summary: 'Price the starter plan at $9',
    operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Starter plan is $9' } }],
    nextKey: { workstream: 2, tasks: {} },
  })),
  generateRoleFile: vi.fn(async () => '# role'),
}));
vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(async () => ({ committed: true })),
  pushContext: vi.fn(async () => {}),
}));

const { runWithActor } = await import('../../src/actor.js');
const { commitContext } = await import('../../src/git.js');
const { contributeCore } = await import('./contribute.core.js');
const { addTask, saveOutput, submitTask } = await import('./task.core.js');
const { writeConfig, writeProject, writeWorkstream } = await import('../../src/storage.js');
const { makeConfig, makeProject, makeWorkstream } = await import('../../src/test-fixtures/model.js');

const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
let dir;
let fetchMock;

beforeEach(() => {
  vi.clearAllMocks();
  caller = MEMBER;
  dir = mkdtempSync(join(tmpdir(), 'teamctx-slack-'));
  writeConfig(makeConfig({
    autoPush: true, reviewPolicy: 'all', deployUrl: 'https://t.example',
    members: [{ key: MEMBER.key, name: MEMBER.name }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Sell it' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  vi.stubEnv('TEAMCTX_SLACK_WEBHOOK', HOOK);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const contribute = (actor, args = {}) => runWithActor(actor, () => contributeCore({
  text: 'We should charge $9 for the starter plan. Long reasoning here.', workstreamId: 'sales', teamctxDir: dir, ...args,
}));
const posts = () => fetchMock.mock.calls.filter(([url]) => url === HOOK);
const written = () => {
  const files = [];
  const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(join(d, e.name)) : files.push(readFileSync(join(d, e.name), 'utf-8'))));
  walk(dir);
  return files.join('\n');
};

describe('a queued contribution', () => {
  it('is posted once, after it is committed, with its summary and not its text', async () => {
    const r = await contribute(MEMBER);
    expect(r.mode).toBe('queued');
    expect(posts()).toHaveLength(1);
    expect(fetchMock.mock.invocationCallOrder[0]).toBeGreaterThan(commitContext.mock.invocationCallOrder.at(-1));
    const { text } = JSON.parse(posts()[0][1].body);
    expect(text).toContain('Price the starter plan at $9');
    expect(text).toContain('from Ravi');
    expect(text).toContain(`review=${r.id}`);
    expect(text).not.toContain('Long reasoning');
  });

  it('is not posted when it is applied', async () => {
    caller = MANAGER;
    const r = await contribute(MANAGER, { apply: true });
    expect(r.mode).toBe('applied');
    expect(posts()).toHaveLength(0);
  });

  it('still queues when Slack fails, and the URL is in no file', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('ECONNRESET'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await contribute(MEMBER);
    expect(r.mode).toBe('queued');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not sent: Slack could not be reached/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    expect(written()).not.toContain('SECRET');
    expect(JSON.stringify(commitContext.mock.calls)).not.toContain('SECRET');
    warn.mockRestore();
  });

  it('is not posted until it is pushed, since the link would open a page without it', async () => {
    const { pushContext } = await import('../../src/git.js');
    pushContext.mockRejectedValueOnce(new Error('no upstream'));
    expect((await contribute(MEMBER)).mode).toBe('queued');
    expect(posts()).toHaveLength(0);
  });

  it('is not posted when the caller says it will tell Slack itself, as an import does', async () => {
    expect((await contribute(MEMBER, { notify: false })).mode).toBe('queued');
    expect(posts()).toHaveLength(0);
  });

  it('is not posted when no webhook is set', async () => {
    vi.stubEnv('TEAMCTX_SLACK_WEBHOOK', '');
    await contribute(MEMBER);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a task\'s submitted work', () => {
  it('is posted once, with the task number', async () => {
    const { task } = await runWithActor(MANAGER, () => addTask({ title: 'Draft the post', workstream: 'sales', teamctxDir: dir }));
    await runWithActor(MEMBER, () => saveOutput({ id: task.id, title: 'First draft', body: 'THE DRAFT ITSELF', teamctxDir: dir }));
    fetchMock.mockClear();
    const r = await runWithActor(MEMBER, () => submitTask({ id: task.id, source: 'mcp', teamctxDir: dir }));
    expect(posts()).toHaveLength(1);
    const { text } = JSON.parse(posts()[0][1].body);
    expect(text).toContain(`*${task.key}* Submitted: First draft`);
    expect(text).toContain(`review=${r.id}`);
    expect(text).not.toContain('THE DRAFT ITSELF');
  });
});
