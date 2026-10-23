/**
 * A task added or removed directly moves what everyone below it works under,
 * since every prompt lists its part's tasks, so it is logged like any other
 * change (#207). Status and owner are not.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, listChanges, readTask } from '../../src/storage.js';
import { addTask, removeTask, getTask, saveOutput, setTaskStatus, assignTask, compileTask } from './task.core.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({
  ...(await original()),
  callClaude: vi.fn(async ({ prompt }) => prompt),
}));

let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const add = (title, workstream) => as(manager, () => addTask({ title, workstream, teamctxDir: dir }));
const pause = () => new Promise(r => setTimeout(r, 5));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamctx-direct-log-'));
  writeConfig(makeConfig({
    autoPush: false,
    project: 'Ledger',
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [
      { id: 'sales', number: 1, name: 'Sales' },
      { id: 'emea', number: 2, name: 'EMEA', parent: 'sales' },
      { id: 'support', number: 3, name: 'Support' },
    ],
    nextKey: { workstream: 4, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  for (const id of ['sales', 'emea', 'support']) writeWorkstream(id, makeWorkstream(id), dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a task added or removed directly', () => {
  it('writes one entry in the task\'s part, in the approval card\'s words, naming the task and who did it', async () => {
    const { task } = await add('Price the EMEA plan', 'sales');
    const [entry] = listChanges({}, dir);
    expect(listChanges({}, dir)).toHaveLength(1);
    expect(entry).toMatchObject({ tree: 'sales', summary: ['Add a task: Price the EMEA plan'], by: { key: manager.key } });
    expect(entry.touched.tasks).toEqual([task.id]);

    await as(manager, () => removeTask({ id: task.id, teamctxDir: dir }));
    const removed = listChanges({}, dir)[1];
    expect(removed).toMatchObject({ tree: 'sales', summary: ['Remove the task "Price the EMEA plan"'], by: { key: manager.key } });
    expect(removed.touched.tasks).toEqual([task.id]);
  });

  it('flags work in progress in that part and below it, not in a sibling part', async () => {
    const own = (await add('Draft the pitch', 'sales')).task;
    const below = (await add('Translate the pitch', 'emea')).task;
    const sibling = (await add('Answer tickets', 'support')).task;
    for (const t of [own, below, sibling]) await as(member, () => saveOutput({ id: t.id, body: 'v1', teamctxDir: dir }));
    await pause();

    const { task } = await add('Price the EMEA plan', 'sales');
    const said = (t) => getTask({ id: t.id, teamctxDir: dir }).changedSince;
    expect(said(own).changes[0].summary).toBe('"Add a task: Price the EMEA plan"');
    expect(said(below).changes).toHaveLength(1);
    expect(said(sibling)).toBeNull();

    await pause();
    await as(member, () => saveOutput({ id: own.id, body: 'v2', teamctxDir: dir }));
    await pause();
    await as(manager, () => removeTask({ id: task.id, teamctxDir: dir }));
    expect(said(own).changes[0].summary).toBe(`"Remove the task 'Price the EMEA plan'"`);
  });

  it('does not flag the added task with its own entry', async () => {
    const { task } = await add('Price the EMEA plan', 'sales');
    await pause();
    await as(manager, () => compileTask({ id: task.id, teamctxDir: dir }));
    expect(getTask({ id: task.id, teamctxDir: dir }).changedSince).toBeNull();
  });

  it('leaves the change in place and says so when the entry cannot be written', async () => {
    writeFileSync(join(dir, 'changes'), 'not a folder');
    const added = await add('Price the EMEA plan', 'sales');
    expect(added.changeLogWarning).toMatch(/could not be written/);
    expect(readTask(added.task.id, dir).task.title).toBe('Price the EMEA plan');
    const removed = await as(manager, () => removeTask({ id: added.task.id, teamctxDir: dir }));
    expect(removed.changeLogWarning).toMatch(/could not be written/);
  });
});

describe('status and owner changes', () => {
  it('write no entry', async () => {
    const { task } = await add('Price the EMEA plan', 'sales');
    const before = listChanges({}, dir).length;
    await as(manager, () => assignTask({ id: task.id, owner: 'Priya', teamctxDir: dir }));
    await as(manager, () => setTaskStatus({ id: task.id, status: 'done', teamctxDir: dir }));
    await as(manager, () => setTaskStatus({ id: task.id, status: 'open', teamctxDir: dir }));
    expect(listChanges({}, dir)).toHaveLength(before);
  });
});
