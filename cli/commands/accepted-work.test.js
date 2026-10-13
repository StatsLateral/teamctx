/**
 * Accepting work submitted for a task writes to the context: the acceptance, plus
 * only the facts and task changes the manager picked.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import {
  writeConfig, writeProject, writeWorkstream, listQueue, readApprovals,
  readTree, readTask, listChanges,
} from '../../src/storage.js';
import { addTask, saveOutput, submitTask, removeTask } from './task.core.js';
import { approveReview } from './review.core.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({
  ...(await original()),
  proposeDiff: vi.fn(async () => { throw new Error('the AI must not be asked about a task submission'); }),
  callClaude: vi.fn(async () => { throw new Error('the AI must not be asked about a task submission'); }),
}));

let dir;
let task;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const save = (actor, args) => as(actor, () => saveOutput({ id: task.id, teamctxDir: dir, ...args }));
const submit = (actor, args = {}) => as(actor, () => submitTask({ id: task.id, teamctxDir: dir, source: 'mcp', ...args }));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-accepted-'));
  writeConfig(makeConfig({
    autoPush: false,
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await as(manager, () => addTask({ title: 'Draft the post', workstream: 'sales', teamctxDir: dir })));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));


describe('accepting a task submission', () => {
  it('writes an acceptance record to the workstream, naming the output', async () => {
    const o = (await save(member, { body: 'v1', title: 'Draft 1' })).output;
    const r = await submit(member);
    await as(manager, () => approveReview({ id: r.id, teamctxDir: dir }));
    const rec = readTree('sales', dir).records.find(x => x.text.startsWith('Task'));
    expect(rec).toMatchObject({
      type: 'decision', text: `Task ${task.key} accepted: Draft the post`,
      attachedTo: { kind: 'task', id: task.id }, sourceContributionIds: [r.id],
    });
    expect(rec.detail).toContain('Draft 1');
    expect(rec.detail).toContain(o.id);
  });

  it('leaves the task done and closed, with its title unchanged', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    await as(manager, () => approveReview({ id: r.id, teamctxDir: dir }));
    expect(readTask(task.id, dir).task).toMatchObject({ status: 'done', title: 'Draft the post' });
  });

  it('records the approval against the task and the outputs, and one change entry', async () => {
    const o = (await save(member, { body: 'v1' })).output;
    const r = await submit(member);
    await as(manager, () => approveReview({ id: r.id, teamctxDir: dir }));
    expect(readApprovals(dir)[r.id]).toMatchObject({ forTask: task.id, outputs: [o.id] });
    const entries = listChanges({}, dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: r.id, tree: 'sales' });
    expect(entries[0].touched.tasks).toContain(task.id);
  });

  it('applies only the facts and task changes the manager picked', async () => {
    await save(member, { body: 'v1' });
    const other = (await as(manager, () => addTask({ title: 'Publish the post', workstream: 'sales', teamctxDir: dir }))).task;
    const r = await submit(member);
    await as(manager, () => approveReview({
      id: r.id, teamctxDir: dir,
      facts: [{ type: 'decision', text: 'Posts go out on Fridays' }],
      taskChanges: [{ type: 'editTask', id: other.id, title: 'Publish the post on Friday' }],
    }));
    const tree = readTree('sales', dir);
    expect(tree.records.map(x => x.text)).toContain('Posts go out on Fridays');
    expect(tree.tasks.find(t => t.id === other.id).title).toBe('Publish the post on Friday');
  });

  it('adds nothing the manager did not pick', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    await as(manager, () => approveReview({ id: r.id, teamctxDir: dir }));
    expect(readTree('sales', dir).records).toHaveLength(1);
  });

  it('adds a follow-on task the manager picked, without asking again whether to include it', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    await as(manager, () => approveReview({ id: r.id, teamctxDir: dir, askAboutTasks: true, taskChanges: [{ type: 'addTask', title: 'Publish the post' }] }));
    expect(readTree('sales', dir).tasks.map(t => t.title)).toContain('Publish the post');
  });

  it('still accepts when a picked fact is invalid, and says what was dropped and why', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    const out = await as(manager, () => approveReview({
      id: r.id, teamctxDir: dir,
      facts: [{ type: 'assumption', text: 'Buyers read on Fridays' }],
    }));
    expect(readTask(task.id, dir).task.status).toBe('done');
    expect(out.dropped).toEqual([expect.objectContaining({ reason: expect.stringMatching(/owner|review/i) })]);
  });

  it('writes a change entry for only what was applied, not for a picked fact that was dropped', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    await as(manager, () => approveReview({
      id: r.id, teamctxDir: dir,
      facts: [
        { type: 'decision', text: 'Posts go out on Fridays' },
        { type: 'assumption', text: 'Buyers read on Fridays' },
      ],
    }));
    const [entry] = listChanges({}, dir);
    const written = readTree('sales', dir).records;
    expect(written.map(x => x.text)).toContain('Posts go out on Fridays');
    expect(written.map(x => x.text)).not.toContain('Buyers read on Fridays');
    expect(entry.summary.join('\n')).toContain('Posts go out on Fridays');
    expect(entry.summary.join('\n')).not.toContain('Buyers read on Fridays');
    expect(entry.touched.records.sort()).toEqual(written.map(x => x.id).sort());
  });

  it('drops a change aimed at the task being accepted, or at one already accepted', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    const out = await as(manager, () => approveReview({
      id: r.id, teamctxDir: dir,
      taskChanges: [{ type: 'editTask', id: task.id, title: 'Something else' }, { type: 'removeTask', id: task.id }],
    }));
    expect(readTask(task.id, dir).task.title).toBe('Draft the post');
    expect(out.dropped.map(d => d.reason)).toEqual([
      expect.stringMatching(/accepted/i), expect.stringMatching(/accepted/i),
    ]);
  });

  it('writes the acceptance record once when two submissions for the task are accepted in turn', async () => {
    await save(member, { body: 'v1' });
    const first = await submit(member);
    await save(member, { body: 'v2' });
    const second = await submit(member);
    await as(manager, () => approveReview({ id: first.id, teamctxDir: dir }));
    await as(manager, () => approveReview({ id: second.id, teamctxDir: dir }));
    expect(readTree('sales', dir).records.filter(x => x.text.startsWith('Task'))).toHaveLength(1);
    expect(readTask(task.id, dir).task.status).toBe('done');
    expect(readApprovals(dir)[second.id]).toMatchObject({ forTask: task.id });
  });

  it('refuses, leaving the item waiting, when the task has gone', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    await as(manager, () => removeTask({ id: task.id, teamctxDir: dir }));
    await expect(as(manager, () => approveReview({ id: r.id, teamctxDir: dir }))).rejects.toThrow(/no longer/i);
    expect(listQueue(dir)).toHaveLength(1);
  });

  it('is still the manager\'s alone', async () => {
    await save(member, { body: 'v1' });
    const r = await submit(member);
    await expect(as(member, () => approveReview({ id: r.id, teamctxDir: dir }))).rejects.toThrow();
  });
});
