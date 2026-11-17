/**
 * The MCP surface for archiving (#320): task_archive retires a picked-up task
 * for a manager and un-archives it, task_rm refuses a picked-up task and names
 * archive, and a non-manager cannot archive.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream } from '../src/storage.js';
import { addTask, saveOutput, getTask } from '../cli/commands/task.core.js';
import { makeHandlers, TOOLS } from './server.js';

vi.mock('../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
let root; let dir; let task;
const call = (actor, fn) => runWithActor(actor, fn);
const parse = (r) => JSON.parse(r.content[0].text);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'teamctx-archive-mcp-'));
  dir = join(root, '.teamctx');
  mkdirSync(dir, { recursive: true });
  writeConfig(makeConfig({
    autoPush: false, members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }], nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await call(manager, () => addTask({ title: 'Draft the post', owner: member.name, workstream: 'sales', teamctxDir: dir })));
  await call(member, () => saveOutput({ id: task.id, body: 'the draft', teamctxDir: dir }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('task_archive', () => {
  it('is advertised, with an unarchive option', () => {
    const tool = TOOLS.find(t => t.name === 'task_archive');
    expect(tool).toBeTruthy();
    expect(tool.inputSchema.properties.unarchive).toBeTruthy();
  });

  it('archives a picked-up task for a manager, keeping its number', async () => {
    const r = parse(await call(manager, () => makeHandlers(root).task_archive({ id: task.id })));
    expect(r.task.status).toBe('archived');
    expect(r.task.key).toBe('1.1');
    expect(r.reportBack).toMatch(/archived/i);
    expect(getTask({ id: task.id, teamctxDir: dir }).status).toBe('archived');
  });

  it('un-archives with unarchive:true', async () => {
    await call(manager, () => makeHandlers(root).task_archive({ id: task.id }));
    const r = parse(await call(manager, () => makeHandlers(root).task_archive({ id: task.id, unarchive: true })));
    expect(r.task.status).toBe('open');
    expect(r.reportBack).toMatch(/un-archived/i);
  });

  it('refuses a non-manager', async () => {
    await expect(call(member, () => makeHandlers(root).task_archive({ id: task.id })))
      .rejects.toThrow(/[Oo]nly a manager/);
    expect(getTask({ id: task.id, teamctxDir: dir }).status).toBe('open');
  });

  it('does not reopen a task that was never archived when asked to un-archive', async () => {
    // The task is open (not archived); unarchive must be a no-op, not a reopen.
    const r = parse(await call(manager, () => makeHandlers(root).task_archive({ id: task.id, unarchive: true })));
    expect(r.unchanged).toBe(true);
    expect(r.reportBack).toMatch(/not archived/i);
    expect(getTask({ id: task.id, teamctxDir: dir }).status).toBe('open');
  });
});

describe('task_rm on a picked-up task', () => {
  it('refuses and names archive', async () => {
    await expect(call(manager, () => makeHandlers(root).task_rm({ id: task.id })))
      .rejects.toThrow(/[Aa]rchive/);
    expect(getTask({ id: task.id, teamctxDir: dir })).toBeTruthy(); // not deleted
  });
});
