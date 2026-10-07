import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream, makeRecord, makeTask } from '../../src/test-fixtures/model.js';
import { writeConfig, readConfig, writeProject, readProject, writeWorkstream, readWorkstream, writeTask, deleteTask, listTasks, readTask, withRecordKeys, listQueue } from '../../src/storage.js';
import { contributeCore } from './contribute.core.js';
import { approveReview } from './review.core.js';
import { addTask, setTaskStatus, compileTask } from './task.core.js';
import { proposeDiff, callClaude } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({ ...(await original()), proposeDiff: vi.fn(), callClaude: vi.fn(async ({ prompt }) => prompt) }));

let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const asManager = fn => runWithActor(manager, fn);
const decision = text => ({ type: 'addRecord', record: { type: 'decision', text } });
const contribute = opts => asManager(() => contributeCore({ text: 'A decision', teamctxDir: dir, apply: true, ...opts }));

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-keys-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'sales', name: 'Sales' }] }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  proposeDiff.mockResolvedValue({ summary: 'A decision', operations: [decision('Ship it')] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('stable keys through real storage and command paths', () => {
  it('backfills every tree before a new record lands, then leaves it unchanged', async () => {
    writeProject(makeProject({ records: [makeRecord({ id: 'later', createdAt: '2026-10-03' })] }), dir);
    writeWorkstream('sales', makeWorkstream('sales', { records: [makeRecord({ id: 'earlier', createdAt: '2026-10-01' })] }), dir);
    expect(readProject(dir).records[0].key).toBeUndefined();
    const result = await contribute();
    expect(readWorkstream('sales', dir).records[0].key).toBe('D-1');
    expect(readProject(dir).records.map(r => r.key)).toEqual(['D-2', 'D-3']);
    expect(result.keys).toEqual([{ id: readProject(dir).records[1].id, key: 'D-3' }]);
    const before = ['project.json', 'config.json', 'workstreams/sales.json'].map(p => readFileSync(join(dir, p), 'utf8'));
    withRecordKeys(dir, () => {});
    expect(['project.json', 'config.json', 'workstreams/sales.json'].map(p => readFileSync(join(dir, p), 'utf8'))).toEqual(before);
  });

  it('queues without backfill or reservations and allocates on approval', async () => {
    writeProject(makeProject({ records: [makeRecord({ id: 'old' })] }), dir);
    const queued = await contribute({ apply: false });
    expect(queued.mode).toBe('queued');
    expect(readConfig(dir).nextKey).toBeUndefined();
    expect(readProject(dir).records[0].key).toBeUndefined();
    expect(listQueue(dir)[0].operations[0].record.key).toBeUndefined();
    await contribute({ workstreamId: 'sales' });
    await asManager(() => approveReview({ id: queued.id, teamctxDir: dir }));
    expect(readProject(dir).records.map(r => r.key)).toEqual(['D-1', 'D-3']);
    expect(readConfig(dir).nextKey.D).toBe(4);
  });

  it('uses current counters and preserves a write made during the AI call', async () => {
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    proposeDiff.mockImplementationOnce(async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { summary: 'Later', operations: [decision('Delayed decision')] };
    });
    const pending = contribute();
    await entered;
    await contribute();
    release();
    await pending;
    expect(readProject(dir).records.map(r => [r.key, r.text])).toEqual([['D-1', 'Ship it'], ['D-2', 'Delayed decision']]);
    expect(readConfig(dir).nextKey.D).toBe(3);
  });

  it('uses one task sequence across both creation paths and never reuses deletions', async () => {
    writeProject(makeProject({ tasks: [makeTask({ id: 'old' })] }), dir);
    const added = await asManager(() => addTask({ title: 'New task', teamctxDir: dir }));
    expect(added.task.key).toBe('T-2');
    deleteTask('T-2', dir);
    proposeDiff.mockResolvedValue({ summary: 'Task', operations: [{ type: 'addTask', title: 'Via contribution' }] });
    await contribute({ workstreamId: 'sales' });
    expect(listTasks({}, dir).map(t => t.key)).toEqual(['T-1', 'T-3']);
    expect(readTask('T-3', dir).task.title).toBe('Via contribution');
  });

  it('a status write backfills old tasks and returns the stored key', async () => {
    writeProject(makeProject({ tasks: [makeTask({ id: 'old' })] }), dir);
    const done = await asManager(() => setTaskStatus({ id: 'old', status: 'done', teamctxDir: dir }));
    expect(done.task.key).toBe('T-1');
    expect(readTask('T-1', dir).task.status).toBe('done');
  });

  it('backfills before compiling so the model sees task and record keys on the first run', async () => {
    writeProject(makeProject({ tasks: [makeTask({ id: 'old' })], records: [makeRecord({ text: 'Ship soon' })] }), dir);
    const compiled = await asManager(() => compileTask({ id: 'old', teamctxDir: dir }));
    expect(compiled.task.key).toBe('T-1');
    expect(callClaude.mock.calls[0][0].prompt).toContain('Task key: T-1');
    expect(callClaude.mock.calls[0][0].prompt).toContain('D-1 We decided: Ship soon');
    expect((await asManager(() => compileTask({ id: 'T-1', teamctxDir: dir }))).alreadyCompiled).toBe(true);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it('recovers counters from stored keys while retaining higher reserved numbers', () => {
    writeProject(makeProject({ tasks: [makeTask({ key: 'T-8' })] }), dir);
    writeTask(makeTask({ id: 'new' }), dir);
    expect(readTask('new', dir).task.key).toBe('T-9');
    writeConfig({ ...readConfig(dir), nextKey: { T: 20 } }, dir);
    writeTask(makeTask({ id: 'newer' }), dir);
    expect(readTask('newer', dir).task.key).toBe('T-20');
  });

  it('refuses a competing local writer and releases its lock after an error', () => {
    mkdirSync(join(dir, '.local'), { recursive: true });
    writeFileSync(join(dir, '.local', 'record-keys.lock'), '');
    expect(() => writeTask(makeTask(), dir)).toThrow(/Another context write/);
    rmSync(join(dir, '.local', 'record-keys.lock'));
    expect(() => withRecordKeys(dir, () => { throw new Error('failed'); })).toThrow('failed');
    expect(() => writeTask(makeTask(), dir)).not.toThrow();
  });
});

/**
 * The lock must not outlive the process that took it, and must never be
 * committed.
 *
 * `commitContext` stages the whole of `.teamctx/`, and `.teamctx/.local/` only
 * reaches .gitignore the first time somebody writes a *preference* — so in a
 * clone where nobody has run `teamctx config name`, a lock left behind by a
 * killed process is picked up by the next command that commits at all, and
 * pushed. Everyone who pulls is then locked out of every key-allocating path
 * until the deletion is committed too.
 *
 * Its own fixture, shaped the way a real project is: a project directory with
 * `.teamctx` inside it. The suite above uses the temp directory itself as the
 * teamctx directory, which puts `dirname` outside the project entirely.
 */
describe('the lock a context write holds', () => {
  let project;
  let ctx;
  const lockPath = () => join(ctx, '.local', 'record-keys.lock');
  const gitignore = () => {
    try { return readFileSync(join(project, '.gitignore'), 'utf-8'); } catch { return null; }
  };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'teamctx-lock-'));
    ctx = join(project, '.teamctx');
    mkdirSync(ctx, { recursive: true });
    writeConfig(makeConfig({ autoPush: false, workstreams: [] }), ctx);
    writeProject(makeProject({ goal: { text: 'Existing project' } }), ctx);
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('is kept out of the repository before it is ever created', () => {
    expect(gitignore()).toBeNull();
    withRecordKeys(ctx, () => {});
    expect(gitignore()).toContain('.teamctx/.local/');
  });

  it('leaves an existing .gitignore alone apart from the one entry', () => {
    writeFileSync(join(project, '.gitignore'), 'node_modules');
    withRecordKeys(ctx, () => {});
    withRecordKeys(ctx, () => {});
    expect(gitignore()).toContain('node_modules');
    expect(gitignore().match(/\.teamctx\/\.local\//g)).toHaveLength(1);
  });

  it('is taken over when its process is plainly gone', () => {
    // A process killed between taking the lock and releasing it leaves this
    // behind. Telling somebody to delete a file before they can do their work
    // is a worse answer than noticing the lock is cold.
    mkdirSync(join(ctx, '.local'), { recursive: true });
    writeFileSync(lockPath(), '');
    const cold = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(lockPath(), cold, cold);
    expect(() => withRecordKeys(ctx, () => {})).not.toThrow();
  });

  it('is still respected while it is warm', () => {
    // The whole point of it: a lock written a moment ago belongs to a process
    // that is still working.
    mkdirSync(join(ctx, '.local'), { recursive: true });
    writeFileSync(lockPath(), '');
    expect(() => withRecordKeys(ctx, () => {})).toThrow(/Another context write/);
  });

  it('is released on the way out, so the next write is not blocked', () => {
    withRecordKeys(ctx, () => {});
    expect(() => readFileSync(lockPath(), 'utf-8')).toThrow();
  });
});
