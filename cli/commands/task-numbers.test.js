import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream, makeTask } from '../../src/test-fixtures/model.js';
import { writeConfig, readConfig, writeProject, readProject, writeWorkstream, readWorkstream, writeTask, deleteTask, listTasks, readTask, withCounters, listQueue } from '../../src/storage.js';
import { contributeCore } from './contribute.core.js';
import { approveReview, rejectReview } from './review.core.js';
import { addTask, compileTask } from './task.core.js';
import { proposeDiff, callClaude } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({ ...(await original()), proposeDiff: vi.fn(), callClaude: vi.fn(async ({ prompt }) => prompt) }));

let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const asManager = fn => runWithActor(manager, fn);
const decision = text => ({ type: 'addRecord', record: { type: 'decision', text } });
const task = title => ({ type: 'addTask', title });
const contribute = opts => asManager(() => contributeCore({ text: 'A decision', teamctxDir: dir, apply: true, ...opts }));

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-numbers-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'sales', number: 1, name: 'Sales' }, { id: 'ops', number: 2, name: 'Ops' }], nextKey: { workstream: 3, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  writeWorkstream('ops', makeWorkstream('ops'), dir);
  proposeDiff.mockResolvedValue({ summary: 'A task', operations: [task('Ship it')] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('task numbers through real storage and command paths', () => {
  it('gives a task its workstream\'s number and the next task number in it', async () => {
    const a = await asManager(() => addTask({ title: 'First', workstream: 'sales', teamctxDir: dir }));
    const b = await asManager(() => addTask({ title: 'Second', workstream: 'sales', teamctxDir: dir }));
    const c = await asManager(() => addTask({ title: 'Elsewhere', workstream: 'ops', teamctxDir: dir }));
    expect([a.task.key, b.task.key, c.task.key]).toEqual(['1.1', '1.2', '2.1']);
    expect(readConfig(dir).nextKey).toEqual({ workstream: 3, tasks: { sales: 3, ops: 2 } });
  });

  it('refuses a task outside any workstream, and numbers nothing', async () => {
    await expect(asManager(() => addTask({ title: 'Loose', workstream: null, teamctxDir: dir }))).rejects.toThrow(/belongs to a workstream/);
    expect(listTasks({}, dir)).toEqual([]);
    expect(readConfig(dir).nextKey).toEqual({ workstream: 3, tasks: {} });
  });

  it('drops a task a contribution proposes for the project itself, and says why', async () => {
    const result = await contribute();
    expect(result.mode).toBe('no-op');
    expect(readProject(dir).tasks).toEqual([]);
    expect(result.dropped.map(d => d.reason).join(' ')).toMatch(/belongs to a workstream/);
  });

  it('uses one sequence across both creation paths and never reuses a deleted number', async () => {
    const added = await asManager(() => addTask({ title: 'New task', workstream: 'sales', teamctxDir: dir }));
    expect(added.task.key).toBe('1.1');
    deleteTask('1.1', dir);
    const viaContribution = await contribute({ workstreamId: 'sales' });
    expect(viaContribution.tasks.map(t => t.key)).toEqual(['1.2']);
    expect(listTasks({}, dir).map(t => t.key)).toEqual(['1.2']);
    expect(readTask('1.2', dir).task.title).toBe('Ship it');
  });

  it('gives records no number on any path', async () => {
    proposeDiff.mockResolvedValue({ summary: 'A decision', operations: [decision('Ship it')] });
    const result = await contribute({ workstreamId: 'sales' });
    expect(result.tasks).toEqual([]);
    expect(readWorkstream('sales', dir).records[0]).not.toHaveProperty('key');
    expect(readConfig(dir).nextKey).toEqual({ workstream: 3, tasks: {} });
  });

  it('numbers a queued item at once, and the task it becomes keeps that number', async () => {
    const queued = await contribute({ workstreamId: 'sales', apply: false });
    expect(queued.mode).toBe('queued');
    expect(queued.number).toBe('1.1');
    expect(listQueue(dir)[0].number).toBe('1.1');
    // A task made while it waits takes the next one, not the item's.
    const meanwhile = await asManager(() => addTask({ title: 'Made meanwhile', workstream: 'sales', teamctxDir: dir }));
    expect(meanwhile.task.key).toBe('1.2');
    await asManager(() => approveReview({ id: queued.id, teamctxDir: dir }));
    expect(readTask('1.1', dir).task.title).toBe('Ship it');
    expect(listTasks({}, dir).map(t => t.key).sort()).toEqual(['1.1', '1.2']);
    expect(readConfig(dir).nextKey.tasks.sales).toBe(3);
  });

  it('can be approved or rejected by the number it waits under', async () => {
    const first = await contribute({ workstreamId: 'sales', apply: false });
    const second = await contribute({ workstreamId: 'sales', apply: false });
    expect([first.number, second.number]).toEqual(['1.1', '1.2']);
    await asManager(() => rejectReview({ id: '1.1', reason: 'not now', teamctxDir: dir }));
    await asManager(() => approveReview({ id: '1.2', teamctxDir: dir }));
    expect(listTasks({}, dir).map(t => t.key)).toEqual(['1.2']);
    expect(listQueue(dir)).toEqual([]);
  });

  it('refuses a number that names two waiting items, rather than picking one', async () => {
    const existing = await asManager(() => addTask({ title: 'Existing', workstream: 'sales', teamctxDir: dir }));
    proposeDiff.mockResolvedValue({ summary: 'Retitle', operations: [{ type: 'editTask', id: existing.task.id, title: 'First rewording' }] });
    await contribute({ workstreamId: 'sales', apply: false });
    proposeDiff.mockResolvedValue({ summary: 'Retitle', operations: [{ type: 'editTask', id: existing.task.id, title: 'Second rewording' }] });
    await contribute({ workstreamId: 'sales', apply: false });
    // Both are about task 1.1, so both wait under 1.1.
    expect(listQueue(dir).map(q => q.number)).toEqual(['1.1', '1.1']);
    await expect(asManager(() => approveReview({ id: '1.1', teamctxDir: dir }))).rejects.toThrow(/names 2 waiting items/);
    await expect(asManager(() => rejectReview({ id: '1.1', teamctxDir: dir }))).rejects.toThrow(/Use the id of the one you mean/);
    expect(listQueue(dir)).toHaveLength(2);
    const [first] = listQueue(dir);
    await asManager(() => approveReview({ id: first.id, teamctxDir: dir }));
    expect(listQueue(dir)).toHaveLength(1);
  });

  it('does not let a hand-edited queue number set the number of the task it creates', async () => {
    const queued = await contribute({ workstreamId: 'sales', apply: false });
    const file = join(dir, 'queue', `${queued.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), number: '2.40' }));
    await asManager(() => approveReview({ id: queued.id, teamctxDir: dir }));
    expect(listTasks({}, dir).map(t => t.key)).toEqual(['1.2']);
  });

  it('never reuses the number of a rejected item', async () => {
    const queued = await contribute({ workstreamId: 'sales', apply: false });
    await asManager(() => rejectReview({ id: queued.id, teamctxDir: dir }));
    const next = await asManager(() => addTask({ title: 'After', workstream: 'sales', teamctxDir: dir }));
    expect(next.task.key).toBe('1.2');
  });

  it('numbers an item about one existing task as that task, and spends nothing', async () => {
    const existing = await asManager(() => addTask({ title: 'Existing', workstream: 'sales', teamctxDir: dir }));
    proposeDiff.mockResolvedValue({ summary: 'Retitle', operations: [{ type: 'editTask', id: existing.task.id, title: 'Existing, reworded' }] });
    const before = readConfig(dir).nextKey;
    const queued = await contribute({ workstreamId: 'sales', apply: false });
    expect(queued.number).toBe('1.1');
    expect(readConfig(dir).nextKey).toEqual(before);
  });

  it('uses current counters and preserves a write made during the AI call', async () => {
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    proposeDiff.mockImplementationOnce(async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { summary: 'Later', operations: [task('Delayed task')] };
    });
    const pending = contribute({ workstreamId: 'sales' });
    await entered;
    await contribute({ workstreamId: 'sales' });
    release();
    await pending;
    expect(readWorkstream('sales', dir).tasks.map(t => [t.key, t.title])).toEqual([['1.1', 'Ship it'], ['1.2', 'Delayed task']]);
    expect(readConfig(dir).nextKey.tasks.sales).toBe(3);
  });

  it('puts the number in the compiled prompt, and compiles it once', async () => {
    const added = await asManager(() => addTask({ title: 'Compile me', workstream: 'sales', teamctxDir: dir }));
    const compiled = await asManager(() => compileTask({ id: '1.1', teamctxDir: dir }));
    expect(compiled.task.id).toBe(added.task.id);
    expect(callClaude.mock.calls[0][0].prompt).toContain('Task number: 1.1');
    expect(callClaude.mock.calls[0][0].prompt).not.toMatch(/\b[TDRAX]-\d/);
    expect((await asManager(() => compileTask({ id: '1.1', teamctxDir: dir }))).alreadyCompiled).toBe(true);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it('refuses a competing local writer and releases its lock after an error', () => {
    mkdirSync(join(dir, '.local'), { recursive: true });
    writeFileSync(join(dir, '.local', 'counters.lock'), '');
    expect(() => writeTask(makeTask({ workstream: 'sales' }), dir)).toThrow(/Another context write/);
    rmSync(join(dir, '.local', 'counters.lock'));
    expect(() => withCounters(dir, () => { throw new Error('failed'); })).toThrow('failed');
    expect(() => writeTask(makeTask({ workstream: 'sales' }), dir)).not.toThrow();
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
  const lockPath = () => join(ctx, '.local', 'counters.lock');
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
    withCounters(ctx, () => {});
    expect(gitignore()).toContain('.teamctx/.local/');
  });

  it('leaves an existing .gitignore alone apart from the one entry', () => {
    writeFileSync(join(project, '.gitignore'), 'node_modules');
    withCounters(ctx, () => {});
    withCounters(ctx, () => {});
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
    expect(() => withCounters(ctx, () => {})).not.toThrow();
  });

  it('is still respected while it is warm', () => {
    // The whole point of it: a lock written a moment ago belongs to a process
    // that is still working.
    mkdirSync(join(ctx, '.local'), { recursive: true });
    writeFileSync(lockPath(), '');
    expect(() => withCounters(ctx, () => {})).toThrow(/Another context write/);
  });

  it('is released on the way out, so the next write is not blocked', () => {
    withCounters(ctx, () => {});
    expect(() => readFileSync(lockPath(), 'utf-8')).toThrow();
  });
});
