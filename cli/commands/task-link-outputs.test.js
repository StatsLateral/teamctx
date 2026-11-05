/**
 * Links as task outputs (#245): a link to a cloud file is saved as an output,
 * and recorded as a connected source against the task when the work is
 * submitted — nothing copied, no credential stored.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, listOutputs, readSourceRefs } from '../../src/storage.js';
import { addTask, saveLinkOutput, submitTask } from './task.core.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

let dir;
let task;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const link = (actor, args) => as(actor, () => saveLinkOutput({ id: task.id, teamctxDir: dir, ...args }));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-linkout-'));
  writeConfig(makeConfig({
    autoPush: false,
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await as(manager, () => addTask({ title: 'Build the deck', workstream: 'sales', teamctxDir: dir })));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('saving a link output', () => {
  it('records kind, the normalised link, the name and the version — no body', async () => {
    const { output } = await link(member, {
      connector: 'gdrive', url: 'https://docs.google.com/presentation/d/XYZ789_abcd/edit?usp=sharing',
      title: 'Pitch deck', version: 'rev-9', notes: 'final-ish', source: 'cli',
    });
    expect(output).toMatchObject({
      task: task.id, kind: 'link', title: 'Pitch deck', state: 'working', notes: 'final-ish',
      author: { key: member.key, name: 'Priya' },
      link: { connector: 'gdrive', title: 'Pitch deck', url: 'https://drive.google.com/file/d/XYZ789_abcd/view', version: 'rev-9' },
    });
    expect(output.body).toBeUndefined();
    expect(listOutputs(task.id, dir)).toHaveLength(1);
  });

  it('does not store a credential-bearing parameter', async () => {
    const { output } = await link(member, { connector: 'gdrive', url: 'https://drive.google.com/file/d/ID1/view?access_token=SEKRIT', title: 'T' });
    expect(JSON.stringify(output)).not.toContain('SEKRIT');
  });

  it('refuses a link output with nothing to point at', async () => {
    await expect(link(member, { connector: 'gdrive', url: 'nonsense' })).rejects.toThrow(/link or a name/);
  });
});

describe('submitting a link output records a connected source', () => {
  it('appears as a source against the task, keyed to the submission', async () => {
    const { output } = await link(member, {
      connector: 'gdrive', url: 'https://drive.google.com/file/d/DECK1/view', title: 'Pitch deck', version: 'rev-9',
    });
    const res = await as(member, () => submitTask({ id: task.id, outputs: [output.id], teamctxDir: dir, projectDir: dir }));
    const refs = Object.values(readSourceRefs(dir));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ connector: 'gdrive', title: 'Pitch deck', link: 'https://drive.google.com/file/d/DECK1/view' });
    // The feed ties it to this submission and this task, so it surfaces in the
    // drawer once the submission is seen (waiting, then approved).
    expect(refs[0].feeds[0]).toMatchObject({ contribution: res.id, task: task.id, workstream: 'sales' });
  });

  it('does not record a source for a plain text submission', async () => {
    const { saveOutput } = await import('./task.core.js');
    const o = await as(member, () => saveOutput({ id: task.id, body: 'just text', teamctxDir: dir, projectDir: dir }));
    await as(member, () => submitTask({ id: task.id, outputs: [o.output.id], teamctxDir: dir, projectDir: dir }));
    expect(Object.values(readSourceRefs(dir))).toHaveLength(0);
  });
});
