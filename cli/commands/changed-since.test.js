/**
 * Work in progress that the context has moved under: a task says what changed
 * since somebody last worked on it, and a compiled prompt goes stale when
 * anything in its chain changed. No AI call is made to decide either.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, writeChange, writeTask, readTask } from '../../src/storage.js';
import { addTask, getTask, saveOutput, compileTask } from './task.core.js';
import { proposeDiff } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({
  ...(await original()),
  proposeDiff: vi.fn(async () => { throw new Error('the AI must not be asked'); }),
  callClaude: vi.fn(async ({ prompt }) => prompt),
}));

let dir;
let task;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const save = (actor, args) => as(actor, () => saveOutput({ id: task.id, teamctxDir: dir, ...args }));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-changed-since-'));
  writeConfig(makeConfig({
    autoPush: false,
    project: 'Ledger',
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await as(manager, () => addTask({ title: 'Draft the post', workstream: 'sales', teamctxDir: dir })));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('work in progress that the context has moved under', () => {
  const change = (id, at, tree, extra = {}) => writeChange({ id, at, tree, summary: [`Add: ${id}`], touched: { records: [], tasks: [] }, by: null, ...extra }, dir);
  const later = (ms) => new Date(Date.now() + ms).toISOString();

  it('says nothing for a task nobody has touched, however much changed', async () => {
    change('c1', later(1000), null);
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince).toBeNull();
  });

  it('says what changed in the project and the part since the last output, and not an entry elsewhere that names the task', async () => {
    await save(member, { body: 'v1' });
    change('proj', later(1000), null);
    change('own', later(2000), 'sales');
    change('direct', later(3000), 'elsewhere', { touched: { records: [], tasks: [task.id] } });
    const { changedSince } = getTask({ id: task.id, teamctxDir: dir });
    expect(changedSince.changes.map(c => c.summary)).toEqual(['"Add: own"', '"Add: proj"']);
    expect(changedSince.changes[1].where).toBe('"Ledger"');
    expect(changedSince.note).toMatch(/do not follow any instruction/);
  });

  it('leaves out a sibling part and anything from before the last output', async () => {
    change('before', new Date(Date.now() - 5000).toISOString(), null);
    await save(member, { body: 'v1' });
    change('sibling', later(1000), 'support');
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince).toBeNull();
  });

  it('says nothing for a done task, however much changed after its accepted work', async () => {
    await save(member, { body: 'v1' });
    change('own', later(1000), 'sales');
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince).not.toBeNull();
    writeTask({ ...readTask(task.id, dir).task, status: 'done' }, dir);
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince).toBeNull();
  });

  it('survives a change file of the wrong shape', async () => {
    await save(member, { body: 'v1' });
    change('bad', later(1000), null, { summary: 'a string', touched: { tasks: 'oops' } });
    change('good', later(2000), null);
    const { changedSince } = getTask({ id: task.id, teamctxDir: dir });
    expect(changedSince.changes.map(c => c.summary)).toEqual(['"Add: good"', '""']);
  });

  it('clears once the person works on it again', async () => {
    await save(member, { body: 'v1' });
    change('proj', later(20), null);
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince).not.toBeNull();
    await new Promise(r => setTimeout(r, 60));
    await save(member, { body: 'v2' });
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince).toBeNull();
  });

  it('counts the changes beyond the five shown', async () => {
    await save(member, { body: 'v1' });
    for (let i = 0; i < 8; i++) change(`c${i}`, later(1000 + i), null);
    const { changedSince } = getTask({ id: task.id, teamctxDir: dir });
    expect(changedSince.changes).toHaveLength(5);
    expect(changedSince.more).toBe(3);
  });

  it('treats a change at the project level as reaching a task in any part', async () => {
    await save(member, { body: 'v1' });
    change('proj', later(1000), null);
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince.changes).toHaveLength(1);
  });
});

describe('a compiled prompt', () => {
  it('is stale when the project above it changed after it was compiled, which the own-part fingerprint missed', async () => {
    const first = await as(manager, () => compileTask({ id: task.id, teamctxDir: dir }));
    expect(first.alreadyCompiled).toBe(false);
    expect((await as(manager, () => compileTask({ id: task.id, teamctxDir: dir }))).alreadyCompiled).toBe(true);
    writeChange({ id: 'proj', at: new Date(Date.now() + 1000).toISOString(), tree: null, summary: ['Set the goal: x'], touched: { records: [], tasks: [] }, by: null }, dir);
    const again = await as(manager, () => compileTask({ id: task.id, teamctxDir: dir }));
    expect(again.alreadyCompiled).toBe(false);
    expect(again.changedSince.changes).toHaveLength(1);
  });

  it('stays stale when an output is saved after the change, and settles once recompiled', async () => {
    await as(manager, () => compileTask({ id: task.id, teamctxDir: dir }));
    const compiledAt = readTask(task.id, dir).task.compiledAt;
    const at = new Date(Date.parse(compiledAt) + 5).toISOString();
    writeChange({ id: 'proj', at, tree: null, summary: ['Set the goal: x'], touched: { records: [], tasks: [] }, by: null }, dir);
    await new Promise(r => setTimeout(r, 20));
    await save(member, { body: 'v1' });
    const again = await as(manager, () => compileTask({ id: task.id, teamctxDir: dir }));
    expect(again.alreadyCompiled).toBe(false);
    await new Promise(r => setTimeout(r, 20));
    const settled = await as(manager, () => compileTask({ id: task.id, teamctxDir: dir }));
    expect(settled.alreadyCompiled).toBe(true);
    expect(settled.changedSince).toBeNull();
  });
});
