/**
 * `task_rm` on an accepted task (#202): it takes a reason, and the reply says
 * the history is kept and names anything else the acceptance recorded.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runWithActor } from '../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream } from '../src/storage.js';
import { addTask, saveOutput, submitTask } from '../cli/commands/task.core.js';
import { approveReview } from '../cli/commands/review.core.js';
import { makeHandlers, TOOLS } from './server.js';

vi.mock('../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
let root;
let task;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'teamctx-taskrm-'));
  const dir = join(root, '.teamctx');
  mkdirSync(dir, { recursive: true });
  writeConfig(makeConfig({
    autoPush: false, members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }], nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await runWithActor(manager, () => addTask({ title: 'Draft the post', workstream: 'sales', teamctxDir: dir })));
  await runWithActor(member, () => saveOutput({ id: task.id, body: 'the draft', teamctxDir: dir }));
  const r = await runWithActor(member, () => submitTask({ id: task.id, teamctxDir: dir }));
  await runWithActor(manager, () => approveReview({ id: r.id, teamctxDir: dir, facts: [{ type: 'decision', text: 'Posts go out on Tuesdays' }] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('task_rm on an accepted task', () => {
  it('takes a reason', () => {
    expect(TOOLS.find(t => t.name === 'task_rm').inputSchema.properties.reason).toBeTruthy();
  });

  it('removes it for a manager, says the history is kept, and names what still stands', async () => {
    const r = JSON.parse((await runWithActor(manager, () => makeHandlers(root).task_rm({ id: task.id, reason: 'Superseded' }))).content[0].text);
    expect(r.accepted).toBe(true);
    expect(r.reportBack).toContain('Its accepted work and approval are kept in the history.');
    expect(r.reportBack).toContain('"Posts go out on Tuesdays"');
  });
});

describe('teamctx task rm', () => {
  it('has --reason', async () => {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'task', 'rm', '--help']);
    expect(stdout).toMatch(/--reason <text>/);
  }, 20000);
});
