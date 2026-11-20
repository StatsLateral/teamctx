/**
 * A compiled prompt is framed for a role, and the role is an input to it.
 *
 * `compileTask` skips the AI call when the context fingerprint is unchanged.
 * The fingerprint left the role out, so a prompt compiled for one role came
 * back for another, labelled as the one that was asked for. Runs the real
 * cache path against real storage; only the AI call is faked, and it echoes
 * the prompt so the test can see which role the text was framed for.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream } from '../../src/storage.js';
import { addTask, compileTask } from './task.core.js';
import { callClaude } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({
  ...(await original()),
  callClaude: vi.fn(async ({ prompt }) => prompt),
}));

const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const GROWTH = { slug: 'growth', name: 'Growth', responsibilities: 'acquire new customers' };
const SUPPORT = { slug: 'support', name: 'Support', responsibilities: 'keep customers happy' };

let dir;
let task;
const compile = (opts = {}) => compileTask({ id: task.id, teamctxDir: dir, ...opts });
const withRoles = roles => writeConfig(makeConfig({
  autoPush: false,
  project: 'Ledger',
  roles,
  workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
  nextKey: { workstream: 2, tasks: {} },
}), dir);

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-compile-role-'));
  withRoles([GROWTH, SUPPORT]);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await runWithActor(manager, () => addTask({ title: 'Draft the post', workstream: 'sales', teamctxDir: dir })));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a compiled prompt and the role it was framed for', () => {
  it('is reused when the same role asks again (the cache still works)', async () => {
    await compile({ role: 'growth' });
    const again = await compile({ role: 'growth' });
    expect(again.alreadyCompiled).toBe(true);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  it('is rebuilt for a different role, not served from the first role', async () => {
    await compile({ role: 'growth' });
    const other = await compile({ role: 'support' });
    expect(other.alreadyCompiled).toBe(false);
    expect(other.markdown).toContain('Framed for role: Support');
    expect(other.markdown).not.toContain('Framed for role: Growth');
  });

  it('is rebuilt when asked for with no role after being framed for one', async () => {
    await compile({ role: 'growth' });
    const plain = await compile();
    expect(plain.alreadyCompiled).toBe(false);
    expect(plain.markdown).not.toContain('Framed for role: Growth');
  });

  it('is rebuilt when the role it was framed for has been edited', async () => {
    await compile({ role: 'growth' });
    withRoles([{ ...GROWTH, responsibilities: 'run the partner programme' }, SUPPORT]);
    const edited = await compile({ role: 'growth' });
    expect(edited.alreadyCompiled).toBe(false);
    expect(edited.markdown).toContain('run the partner programme');
  });
});
