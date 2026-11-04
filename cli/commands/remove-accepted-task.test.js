/**
 * A manager can take an accepted task out of the plan, with a reason (#202).
 *
 * It leaves the plan, not the history: the outputs, the approval and the logs
 * stay, its acceptance record is closed, and whatever else was recorded when it
 * was accepted is named for the manager to decide about.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import {
  writeConfig, writeProject, writeWorkstream, readApprovals, readContributions, readTree, listOutputs, listChanges, listTasks, readTreeMd, writeTree,
} from '../../src/storage.js';
import { addTask, saveOutput, submitTask, removeTask } from './task.core.js';
import { approveReview } from './review.core.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

let dir;
let task;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'teamctx-rm-accepted-'));
  writeConfig(makeConfig({
    autoPush: false,
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await as(manager, () => addTask({ title: 'Draft the post', workstream: 'sales', teamctxDir: dir })));
  await as(member, () => saveOutput({ id: task.id, body: 'the draft', teamctxDir: dir }));
  const r = await as(member, () => submitTask({ id: task.id, teamctxDir: dir }));
  await as(manager, () => approveReview({
    id: r.id, teamctxDir: dir, facts: [{ type: 'decision', text: 'Posts go out on Tuesdays' }],
  }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const remove = (actor, reason) => as(actor, () => removeTask({ id: task.id, reason, teamctxDir: dir }));

describe('removing an accepted task', () => {
  it('is refused to anybody but a manager', async () => {
    await expect(remove(member, 'superseded')).rejects.toThrow(/Only a manager can remove it/);
    expect(listTasks({}, dir).map(t => t.id)).toContain(task.id);
  });

  it('needs a reason', async () => {
    await expect(remove(manager, '   ')).rejects.toThrow(/needs a reason/);
    await expect(remove(manager, 'x'.repeat(501))).rejects.toThrow(/too long/);
    expect(listTasks({}, dir).map(t => t.id)).toContain(task.id);
  });

  it('takes it out of the plan and closes its acceptance record', async () => {
    const r = await remove(manager, 'Accepted by mistake: this was the old brief');
    expect(r).toMatchObject({ id: task.id, accepted: true, reason: 'Accepted by mistake: this was the old brief' });
    expect(listTasks({}, dir).map(t => t.id)).not.toContain(task.id);
    const tree = readTree('sales', dir);
    const acceptance = tree.records.find(x => x.text?.startsWith(`Task ${task.key} accepted`));
    expect(acceptance.status).toBe('closed');
    expect(r.closed).toEqual([acceptance.id]);
  });

  it('keeps the history: the outputs, the approval, and who removed it and why', async () => {
    await remove(manager, 'Superseded by the launch plan');
    expect(listOutputs(task.id, dir)).toHaveLength(1);
    expect(Object.values(readApprovals(dir)).some(a => a.forTask === task.id)).toBe(true);
    const logged = readContributions(dir).find(c => c.removedTask === task.id);
    expect(logged).toMatchObject({ author: 'Manager', text: `Removed accepted task ${task.key} ("Draft the post"): Superseded by the launch plan` });
    const change = listChanges({}, dir).find(e => e.id === logged.id);
    expect(change.touched.tasks).toContain(task.id);
  });

  it('names what else the acceptance recorded, and leaves it standing', async () => {
    const r = await remove(manager, 'Superseded');
    expect(r.stillActive).toEqual([expect.objectContaining({ kind: 'record', type: 'decision', text: 'Posts go out on Tuesdays' })]);
    expect(readTree('sales', dir).records.find(x => x.text === 'Posts go out on Tuesdays').status).toBe('active');
  });
});

describe('what removing it does not let through', () => {
  it('a claimed actor is not a credential', async () => {
    await expect(as(member, () => removeTask({ id: task.id, reason: 'x', actor: manager, teamctxDir: dir }))).rejects.toThrow(/Only a manager/);
  });

  it('a new task with the same title does not take over its id, approval or outputs', async () => {
    await remove(manager, 'Accepted by mistake');
    const { task: again } = await as(manager, () => addTask({ title: 'Draft the post', workstream: 'sales', teamctxDir: dir }));
    expect(again.id).not.toBe(task.id);
    expect(listOutputs(again.id, dir)).toHaveLength(0);
    await expect(as(member, () => saveOutput({ id: again.id, body: 'fresh start', teamctxDir: dir }))).resolves.toBeTruthy();
  });

  it('the rendered context no longer shows it, or its acceptance', async () => {
    expect(readTreeMd('sales', dir)).toContain('Draft the post');
    await remove(manager, 'Superseded');
    expect(readTreeMd('sales', dir)).not.toContain('Draft the post');
  });

  it('names a record still attached to it, which now points at nothing', async () => {
    const tree = readTree('sales', dir);
    writeTree('sales', { ...tree, records: [...tree.records, { ...tree.records[0], id: 'r-note', text: 'Use the brand voice', createdBy: 'c-other', sourceContributionIds: ['c-other'], attachedTo: { kind: 'task', id: task.id }, status: 'active' }] }, dir);
    const r = await remove(manager, 'Superseded');
    expect(r.stillActive.map(x => x.text)).toContain('Use the brand voice');
  });
});

describe('removing a task that was never accepted', () => {
  it('works as before, with no reason', async () => {
    const { task: other } = await as(manager, () => addTask({ title: 'Book the venue', workstream: 'sales', teamctxDir: dir }));
    const r = await as(member, () => removeTask({ id: other.id, teamctxDir: dir }));
    expect(r.id).toBe(other.id);
    expect(r.accepted).toBeUndefined();
  });
});
