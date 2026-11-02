import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, listChanges } from '../../src/storage.js';
import * as storage from '../../src/storage.js';
import { contributeCore } from './contribute.core.js';
import { approveReview } from './review.core.js';
import { addTask } from './task.core.js';
import { proposeDiff } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({ ...(await original()), proposeDiff: vi.fn(), callClaude: vi.fn(async ({ prompt }) => prompt) }));

let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-changelog-'));
  writeConfig(makeConfig({
    autoPush: false,
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  proposeDiff.mockResolvedValue({
    summary: 'A decision',
    operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Ship on Friday' } }],
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the change log', () => {
  it('gets an entry when a manager approves a queued contribution', async () => {
    const queued = await as(member, () => contributeCore({ text: 'x', teamctxDir: dir, workstreamId: 'sales' }));
    expect(queued.mode).toBe('queued');
    expect(listChanges({}, dir)).toEqual([]);
    await as(manager, () => approveReview({ id: queued.id, teamctxDir: dir }));
    const [e] = listChanges({}, dir);
    expect(e).toMatchObject({ id: queued.id, tree: 'sales', by: { key: 'git:manager@x', name: 'Manager' } });
    expect(e.summary).toEqual(['Add: We decided: Ship on Friday']);
    expect(e.touched.records).toHaveLength(1);
  });

  it('gets an entry when a manager applies a contribution directly, for the project as much as a workstream', async () => {
    const r = await as(manager, () => contributeCore({ text: 'x', teamctxDir: dir, workstreamId: null, apply: true }));
    expect(r.mode).toBe('applied');
    expect(listChanges({}, dir)[0]).toMatchObject({ id: r.id, tree: null, by: { name: 'Manager' } });
  });

  it('gets nothing for a contribution that only waits in the queue', async () => {
    await as(member, () => contributeCore({ text: 'x', teamctxDir: dir, workstreamId: 'sales' }));
    expect(listChanges({}, dir)).toEqual([]);
  });

  it('does not undo an approval when the entry cannot be written, and says so', async () => {
    const queued = await as(member, () => contributeCore({ text: 'x', teamctxDir: dir, workstreamId: 'sales' }));
    const spy = vi.spyOn(storage, 'writeChange').mockImplementation(() => { throw new Error('disk full'); });
    try {
      const r = await as(manager, () => approveReview({ id: queued.id, teamctxDir: dir }));
      expect(r.changeLogWarning).toMatch(/disk full/);
      expect(storage.readTree('sales', dir).records).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('writes the entry for a direct apply from only the operations that were applied', async () => {
    // A task the proposal edits that goes away while the AI is being asked: the
    // check passes against the earlier read, and the apply drops the edit.
    const gone = (await as(manager, () => addTask({ title: 'Old title', workstream: 'sales', teamctxDir: dir }))).task;
    proposeDiff.mockImplementation(async () => {
      const t = storage.readTree('sales', dir);
      storage.writeTree('sales', { ...t, tasks: t.tasks.filter(x => x.id !== gone.id) }, dir);
      return {
        summary: 'Two things',
        operations: [
          { type: 'addRecord', record: { type: 'decision', text: 'Ship on Friday' } },
          { type: 'editTask', id: gone.id, title: 'New title for the gone task' },
        ],
      };
    });
    const r = await as(manager, () => contributeCore({ text: 'x', teamctxDir: dir, workstreamId: 'sales', apply: true }));
    expect(r.mode).toBe('applied');
    expect(r.dropped).toHaveLength(1);
    // The newest: adding the task wrote one first (#207).
    const e = listChanges({}, dir).at(-1);
    const written = storage.readTree('sales', dir).records;
    expect(e.summary.join('\n')).toContain('Ship on Friday');
    expect(e.summary.join('\n')).not.toContain('New title for the gone task');
    expect(e.touched.records).toEqual(written.map(x => x.id));
    expect(e.touched.tasks).not.toContain(gone.id);
  });

  it('does not undo a direct apply when the entry cannot be written, and says so', async () => {
    const spy = vi.spyOn(storage, 'writeChange').mockImplementation(() => { throw new Error('disk full'); });
    try {
      const r = await as(manager, () => contributeCore({ text: 'x', teamctxDir: dir, workstreamId: 'sales', apply: true }));
      expect(r.mode).toBe('applied');
      expect(r.changeLogWarning).toMatch(/disk full/);
      expect(storage.readTree('sales', dir).records).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
});
