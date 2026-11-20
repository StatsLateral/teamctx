/**
 * Delete before pickup, archive after (#320).
 *
 * "Picked up" means an output has been saved. A task nobody worked is deleted
 * and its number is never reused; a task with work on it cannot be deleted, only
 * archived — which keeps its number and outputs, blocks further work, and drops
 * it out of the approved context, while leaving it visible for history.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, readTree, listOutputs } from '../../src/storage.js';
import { serializeToMd } from '../../src/context.js';
import { buildBrief } from './brief.core.js';
import {
  addTask, saveOutput, removeTask, setTaskStatus, submitTask, compileTask,
  getTask, listTasksFiltered, TaskPickedUpError, TaskArchivedError,
} from './task.core.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const add = (title, owner) => as(manager, () => addTask({ title, owner, workstream: 'sales', teamctxDir: dir }));
const archive = (id) => as(manager, () => setTaskStatus({ id, status: 'archived', teamctxDir: dir }));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-archive-'));
  writeConfig(makeConfig({
    autoPush: false,
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('deleting a task before it is picked up', () => {
  it('deletes a task with no saved output and never reuses its number', async () => {
    const { task } = await add('Draft the post');
    expect(task.key).toBe('1.1');
    await as(manager, () => removeTask({ id: task.id, teamctxDir: dir }));
    const { task: next } = await add('Second task');
    expect(next.key).toBe('1.2'); // the freed 1.1 is not handed out again
    expect(listTasksFiltered({ teamctxDir: dir }).tasks.map(t => t.key)).toEqual(['1.2']);
  });

  it('refuses to delete a task that has a saved output, and names archive', async () => {
    const { task } = await add('Draft the post', member.name);
    await as(member, () => saveOutput({ id: task.id, body: 'the draft', teamctxDir: dir }));
    await expect(as(manager, () => removeTask({ id: task.id, teamctxDir: dir })))
      .rejects.toThrow(TaskPickedUpError);
    await expect(as(manager, () => removeTask({ id: task.id, teamctxDir: dir })))
      .rejects.toThrow(/[Aa]rchive/);
    // Still there, with its output, because nothing was deleted.
    expect(getTask({ id: task.id, teamctxDir: dir }).outputs).not.toBeNull();
  });

  it('leaves 1.2 and 1.4–1.7 unchanged when 1.1 and 1.3 are removed', async () => {
    const tasks = [];
    for (let i = 1; i <= 7; i += 1) tasks.push((await add(`Task ${i}`)).task);
    expect(tasks.map(t => t.key)).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7']);
    await as(manager, () => removeTask({ id: tasks[0].id, teamctxDir: dir })); // 1.1
    await as(manager, () => removeTask({ id: tasks[2].id, teamctxDir: dir })); // 1.3
    expect(listTasksFiltered({ teamctxDir: dir }).tasks.map(t => t.key))
      .toEqual(['1.2', '1.4', '1.5', '1.6', '1.7']);
    const { task: fresh } = await add('One more');
    expect(fresh.key).toBe('1.8'); // the next number, not a freed one
  });
});

describe('archiving a task that has been worked', () => {
  let task;
  beforeEach(async () => {
    ({ task } = await add('Draft the post', member.name));
    await as(member, () => saveOutput({ id: task.id, body: 'the draft', teamctxDir: dir }));
    await archive(task.id);
  });

  it('keeps the task number and its outputs, and stamps who archived it', () => {
    const t = getTask({ id: task.id, teamctxDir: dir });
    expect(t.status).toBe('archived');
    expect(t.key).toBe('1.1');
    expect(t.archivedBy).toMatchObject({ name: 'Manager' });
    expect(listOutputs(task.id, dir)).toHaveLength(1);
  });

  it('refuses saving, submitting and compiling on it', async () => {
    await expect(as(member, () => saveOutput({ id: task.id, body: 'more', teamctxDir: dir })))
      .rejects.toThrow(TaskArchivedError);
    await expect(as(member, () => submitTask({ id: task.id, outputs: 'all', teamctxDir: dir })))
      .rejects.toThrow(TaskArchivedError);
    await expect(as(member, () => compileTask({ id: task.id, teamctxDir: dir })))
      .rejects.toThrow(TaskArchivedError);
  });

  it('drops out of the default task list but is still reachable with all', () => {
    expect(listTasksFiltered({ teamctxDir: dir }).tasks.map(t => t.key)).toEqual([]);
    expect(listTasksFiltered({ all: true, teamctxDir: dir }).tasks.map(t => t.key)).toEqual(['1.1']);
    // The task page still opens and reports it archived.
    expect(getTask({ id: task.id, teamctxDir: dir }).status).toBe('archived');
  });

  it('is left out of the approved context and the member brief', async () => {
    const md = serializeToMd(readTree('sales', dir), 'Project');
    expect(md).not.toContain('Draft the post');
    const brief = await as(member, () => buildBrief({ teamctxDir: dir }));
    const keys = [...brief.tasks.open, ...brief.tasks.done].flatMap(g => g.tasks.map(t => t.key));
    expect(keys).not.toContain('1.1');
    expect(brief.context).not.toContain('Draft the post');
  });

  it('un-archives back to open, and returns to the live views', async () => {
    const { task: reopened } = await archiveBackToOpen(task.id);
    expect(reopened.status).toBe('open');
    expect(reopened.archivedAt).toBeNull();
    expect(listTasksFiltered({ teamctxDir: dir }).tasks.map(t => t.key)).toEqual(['1.1']);
    const md = serializeToMd(readTree('sales', dir), 'Project');
    expect(md).toContain('Draft the post');
  });

  it('is never both done and archived — each state clears the other stamp', async () => {
    // Already archived (beforeEach). Marking it done clears the archived stamp.
    const { task: nowDone } = await as(manager, () => setTaskStatus({ id: task.id, status: 'done', teamctxDir: dir }));
    expect(nowDone.status).toBe('done');
    expect(nowDone.archivedAt).toBeNull();
    // Archiving a done task clears the done stamp.
    const { task: reArchived } = await archive(task.id);
    expect(reArchived.status).toBe('archived');
    expect(reArchived.doneAt).toBeNull();
  });
});

function archiveBackToOpen(id) {
  return runWithActor(manager, () => setTaskStatus({ id, status: 'open', teamctxDir: dir }));
}
