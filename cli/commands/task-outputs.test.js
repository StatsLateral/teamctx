/**
 * Working outputs on a task (#197): what a person produces on a task is kept
 * word for word, one append-only file each, and handed back to whoever picks
 * the task up next.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, listOutputs, writeRejected } from '../../src/storage.js';
import { addTask, getTask, saveOutput, MAX_OUTPUT_CHARS } from './task.core.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

let dir;
let task;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const save = (actor, args) => as(actor, () => saveOutput({ id: task.id, teamctxDir: dir, ...args }));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-outputs-'));
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

describe('saving a working output', () => {
  it('keeps the body word for word, with who made it, the prompt and the notes', async () => {
    const { output } = await save(member, {
      body: 'Line one.\n\nLine two, with "quotes" & symbols.', title: 'First draft',
      prompt: 'Write a short post', notes: 'Could be trimmed', source: 'mcp',
    });
    expect(output).toMatchObject({
      task: task.id, title: 'First draft', body: 'Line one.\n\nLine two, with "quotes" & symbols.',
      prompt: 'Write a short post', notes: 'Could be trimmed', state: 'working', basedOn: null,
      source: 'mcp', author: { key: 'git:priya@x', name: 'Priya' },
    });
    expect(output.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(Date.parse(output.at)).not.toBeNaN();
    expect(listOutputs(task.id, dir)).toEqual([output]);
  });

  it('keeps every output, each in its own file, and never changes an earlier one', async () => {
    const first = (await save(member, { body: 'v1' })).output;
    const second = (await save(manager, { body: 'v2', basedOn: first.id })).output;
    expect(second.basedOn).toBe(first.id);
    expect(listOutputs(task.id, dir).map(o => o.body)).toEqual(['v1', 'v2']);
    expect(readdirSync(join(dir, 'outputs', task.id))).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, 'outputs', task.id, `${first.id}.json`), 'utf-8'))).toEqual(first);
  });

  it('makes a title from the first line when none is given', async () => {
    const { output } = await save(member, { body: 'Partnering is a choice.\nMore text.' });
    expect(output.title).toBe('Partnering is a choice.');
  });

  it('does not commit anything to the task or the context', async () => {
    const before = getTask({ id: task.id, teamctxDir: dir });
    await save(member, { body: 'v1' });
    const after = getTask({ id: task.id, teamctxDir: dir });
    expect(after.title).toBe(before.title);
    expect(after.status).toBe('open');
  });

  it('refuses an empty body, and one over the limit, instead of cutting it short', async () => {
    await expect(save(member, { body: '   ' })).rejects.toThrow(/empty/i);
    await expect(save(member, { body: 'x'.repeat(MAX_OUTPUT_CHARS + 1) })).rejects.toThrow(/too long/i);
    expect(listOutputs(task.id, dir)).toEqual([]);
  });

  it('refuses a basedOn that is not an output of this task', async () => {
    await expect(save(member, { body: 'v2', basedOn: 'nope' })).rejects.toThrow(/no output/i);
  });

  it('refuses a task that does not exist', async () => {
    await expect(as(member, () => saveOutput({ id: 'missing', body: 'x', teamctxDir: dir }))).rejects.toThrow();
  });
});

describe('picking a task up', () => {
  it('has no outputs to show when none were saved', () => {
    expect(getTask({ id: task.id, teamctxDir: dir }).outputs).toBeNull();
  });

  it('gives the latest in full and the earlier ones as a list', async () => {
    const a = (await save(member, { body: 'v1', title: 'One' })).output;
    await save(manager, { body: 'v2', title: 'Two', basedOn: a.id });
    const { outputs } = getTask({ id: task.id, teamctxDir: dir });
    expect(outputs.latest).toMatchObject({ title: 'Two', body: 'v2' });
    expect(outputs.earlier).toEqual([{ id: a.id, title: 'One', author: { key: 'git:priya@x', name: 'Priya' }, at: a.at, state: 'working' }]);
    expect(outputs.earlier[0]).not.toHaveProperty('body');
  });

  it('opens an earlier output in full when asked for it by id', async () => {
    const a = (await save(member, { body: 'v1' })).output;
    await save(manager, { body: 'v2' });
    expect(getTask({ id: task.id, output: a.id, teamctxDir: dir }).output).toMatchObject({ id: a.id, body: 'v1' });
  });

  it('says so when the output asked for is not on this task', () => {
    expect(() => getTask({ id: task.id, output: 'nope', teamctxDir: dir })).toThrow(/no output/i);
  });
});

describe('the feedback on an output that was sent back', () => {
  const asker = (over) => ({ keys: [], isManager: false, ...over });
  let output;
  beforeEach(async () => {
    ({ output } = await save(member, { body: 'A draft', title: 'Draft 1', source: 'mcp' }));
    writeRejected({ id: 'r1', forTask: task.id, outputs: [output.id], reason: 'Fix three points', rejectedAt: '2026-10-15T20:02:00Z' }, dir);
  });
  const feedback = (reader) => getTask({ id: task.id, teamctxDir: dir, reader }).outputs.latest.feedback;

  it('goes to the person who wrote it, a manager, and whoever the task is assigned to', () => {
    expect(feedback(asker({ keys: [member.key] }))?.reason).toBe('Fix three points');
    expect(feedback(asker({ isManager: true }))?.reason).toBe('Fix three points');
    expect(feedback(asker({ keys: [manager.key] }))?.reason).toBe('Fix three points');
  });
  it('goes to nobody else, and to a caller that cannot say who it is', () => {
    // A name is not an identity: sharing the owner's name does not make anyone the assignee.
    expect(feedback({ keys: ['git:other@x'], name: task.owner, isManager: false })).toBeUndefined();
    expect(feedback(asker({ keys: ['git:other@x'] }))).toBeUndefined();
    expect(feedback(undefined)).toBeUndefined();
  });
});
