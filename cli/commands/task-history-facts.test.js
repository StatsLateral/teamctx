/**
 * The facts a task's history is built from, written where they happen (#143).
 *
 * Through real storage and the real command paths: approving, applying,
 * rejecting, and marking a task done or open again each leave behind who did
 * it and when.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, readApprovals, listQueue, listTasks } from '../../src/storage.js';
import { contributeCore } from './contribute.core.js';
import { approveReview, rejectReview } from './review.core.js';
import { addTask, setTaskStatus } from './task.core.js';
import { proposeDiff } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({ ...(await original()), proposeDiff: vi.fn(), callClaude: vi.fn(async ({ prompt }) => prompt) }));

let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const contribute = (actor, opts) => as(actor, () => contributeCore({ text: 'A task', teamctxDir: dir, workstreamId: 'sales', ...opts }));

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-history-'));
  writeConfig(makeConfig({
    autoPush: false,
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  proposeDiff.mockResolvedValue({ summary: 'A task', operations: [{ type: 'addTask', title: 'Ship it' }] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('who approved a contribution, and when', () => {
  it('is recorded when the manager approves it from the queue', async () => {
    const queued = await contribute(member, {});
    expect(queued.mode).toBe('queued');
    await as(manager, () => approveReview({ id: queued.id, teamctxDir: dir }));
    const a = readApprovals(dir)[queued.id];
    expect(a).toMatchObject({ id: queued.id, author: 'Priya', workstream: 'sales', approvedBy: { key: 'git:manager@x', name: 'Manager' } });
    expect(Date.parse(a.approvedAt)).not.toBeNaN();
  });

  it('is recorded as the manager when the manager applies it directly', async () => {
    const applied = await contribute(manager, { apply: true });
    expect(applied.mode).toBe('applied');
    expect(readApprovals(dir)[applied.id].approvedBy).toEqual({ key: 'git:manager@x', name: 'Manager' });
  });

  it('names nobody when it went in under the review policy', async () => {
    writeConfig(makeConfig({
      autoPush: false, reviewPolicy: 'additive',
      members: [{ key: member.key, name: member.name, email: member.email }],
      workstreams: [{ id: 'sales', number: 1, name: 'Sales' }], nextKey: { workstream: 2, tasks: {} },
    }), dir);
    const applied = await contribute(member, {});
    expect(applied.mode).toBe('applied');
    expect(readApprovals(dir)[applied.id]).toMatchObject({ approvedBy: null, by: 'policy' });
  });

  it('is not recorded for something still waiting, or rejected', async () => {
    const queued = await contribute(member, {});
    expect(readApprovals(dir)).toEqual({});
    await as(manager, () => rejectReview({ id: queued.id, reason: 'not now', teamctxDir: dir }));
    expect(readApprovals(dir)).toEqual({});
    expect(listQueue(dir)).toEqual([]);
  });
});

describe('who added a task directly', () => {
  it('is kept on the task, with when', async () => {
    const { task } = await as(member, () => addTask({ title: 'Ship it', workstream: 'sales', teamctxDir: dir }));
    expect(task.addedBy).toEqual({ key: 'git:priya@x', name: 'Priya' });
    expect(listTasks({}, dir)[0].addedBy.name).toBe('Priya');
    expect(Date.parse(task.addedAt)).not.toBeNaN();
  });
});

describe('who completed or reopened a task, and when', () => {
  it('keeps each change, in order, with who made it', async () => {
    const { task } = await as(manager, () => addTask({ title: 'Ship it', workstream: 'sales', teamctxDir: dir }));
    await as(member, () => setTaskStatus({ id: task.id, status: 'done', teamctxDir: dir }));
    await as(manager, () => setTaskStatus({ id: task.id, status: 'open', teamctxDir: dir }));
    await as(manager, () => setTaskStatus({ id: task.id, status: 'done', teamctxDir: dir }));
    const [stored] = listTasks({}, dir);
    expect(stored.statusLog.map(s => [s.did, s.by.name])).toEqual([['completed', 'Priya'], ['reopened', 'Manager'], ['completed', 'Manager']]);
    expect(stored.statusLog.every(s => !Number.isNaN(Date.parse(s.at)))).toBe(true);
    expect(stored.doneBy).toEqual({ key: 'git:manager@x', name: 'Manager' });
    expect(stored.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('writes nothing when the status does not change', async () => {
    const { task } = await as(manager, () => addTask({ title: 'Ship it', workstream: 'sales', teamctxDir: dir }));
    await as(manager, () => setTaskStatus({ id: task.id, status: 'open', teamctxDir: dir }));
    expect(listTasks({}, dir)[0].statusLog).toBeUndefined();
  });
});

describe('who rejected a contribution', () => {
  it('keeps the rejecter’s key beside their name', async () => {
    const queued = await contribute(member, {});
    await as(manager, () => rejectReview({ id: queued.id, reason: 'not now', teamctxDir: dir }));
    const kept = JSON.parse(readFileSync(join(dir, 'rejected', `${queued.id}.json`), 'utf-8'));
    expect(kept).toMatchObject({ rejectedBy: 'Manager', rejectedByKey: 'git:manager@x', reason: 'not now' });
  });
});
