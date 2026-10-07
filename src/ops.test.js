import { describe, it, expect } from 'vitest';
import { applyOps, touchedBy, OP_TYPES } from './ops.js';
import { makeProject, makeRecord } from './test-fixtures/model.js';

const C = 'c-1';

describe('applyOps', () => {
  it('sets the goal and records provenance', () => {
    const { tree } = applyOps(makeProject(), [{ type: 'setGoal', text: 'Win 3 clients by Q4' }], C);
    expect(tree.goal).toMatchObject({ text: 'Win 3 clients by Q4', sourceContributionIds: [C] });
  });

  it('adds a record with a minted id and active status', () => {
    const { tree, dropped } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'decision', text: 'Fixed price', attachedTo: { kind: 'project' } } },
    ], C);
    expect(dropped).toEqual([]);
    expect(tree.records[0]).toMatchObject({ type: 'decision', status: 'active', sourceContributionIds: [C] });
    expect(tree.records[0].id).toMatch(/^rec-/);
  });

  it('lets an exception bend a rule added in the same contribution', () => {
    const { tree, dropped } = applyOps(makeProject(), [
      { type: 'addRecord', ref: 'r1', record: { type: 'rule', text: 'No nuts', attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'exception', text: 'Adults cake may have frosting', expiresAt: '2026-12-31', links: { bends: 'r1' }, attachedTo: { kind: 'project' } } },
    ], C);
    expect(dropped).toEqual([]);
    const rule = tree.records.find(r => r.type === 'rule');
    expect(tree.records.find(r => r.type === 'exception').links.bends).toBe(rule.id);
  });

  it('drops malformed proposals with a reason instead of writing them', () => {
    const { tree, dropped } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'assumption', text: '20 guests', attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'exception', text: 'x', expiresAt: '2026-12-31', links: { bends: 'rec-missing' }, attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'fact', text: 'x', attachedTo: { kind: 'project' } } },
      { type: 'addWhy', text: 'old op' },
    ], C);
    expect(tree.records).toEqual([]);
    expect(dropped.map(d => d.reason).join(' | ')).toMatch(/owner|reviewBy/);
    expect(dropped.map(d => d.reason).join(' | ')).toMatch(/bends/);
    expect(dropped).toHaveLength(4);
  });

  it('refuses an exception that bends something other than a rule', () => {
    const dec = makeRecord({ id: 'rec-d', type: 'decision' });
    const { dropped } = applyOps(makeProject({ records: [dec] }), [
      { type: 'addRecord', record: { type: 'exception', text: 'x', expiresAt: '2026-12-31', links: { bends: 'rec-d' }, attachedTo: { kind: 'project' } } },
    ], C);
    expect(dropped[0].reason).toMatch(/must bend a rule/);
  });

  it('edits, changes status, and marks the older record replaced', () => {
    const old = makeRecord({ id: 'rec-old', type: 'decision', text: 'Old' });
    const { tree } = applyOps(makeProject({ records: [old] }), [
      { type: 'addRecord', record: { type: 'decision', text: 'New', links: { replaces: 'rec-old' }, attachedTo: { kind: 'project' } } },
      { type: 'editRecord', id: 'rec-old', changes: { detail: 'superseded' } },
    ], C);
    expect(tree.records.find(r => r.id === 'rec-old')).toMatchObject({ status: 'replaced', detail: 'superseded' });
  });

  it('sets status broken and closed', () => {
    const a = makeRecord({ id: 'rec-a', type: 'assumption' });
    const { tree } = applyOps(makeProject({ records: [a] }), [{ type: 'setRecordStatus', id: 'rec-a', status: 'broken' }], C);
    expect(tree.records[0].status).toBe('broken');
  });

  it('adds, edits and removes tasks', () => {
    let { tree } = applyOps(makeProject(), [{ type: 'addTask', title: 'Bake cake' }], C);
    const id = tree.tasks[0].id;
    ({ tree } = applyOps(tree, [{ type: 'editTask', id, title: 'Bake the cake' }], 'c-2'));
    expect(tree.tasks[0]).toMatchObject({ title: 'Bake the cake', status: 'open', owner: null });
    ({ tree } = applyOps(tree, [{ type: 'removeTask', id }], 'c-3'));
    expect(tree.tasks).toEqual([]);
  });

  it('applies in order setGoal → adds → edits → status → removals', () => {
    expect(OP_TYPES).toEqual(['setGoal', 'addRecord', 'editRecord', 'setRecordStatus', 'addTask', 'editTask', 'removeTask']);
  });
});

describe('touchedBy', () => {
  it('lists the goal, then records, then tasks this contribution wrote', () => {
    const { tree } = applyOps(makeProject(), [
      { type: 'addTask', title: 'T' },
      { type: 'setGoal', text: 'G' },
      { type: 'addRecord', record: { type: 'decision', text: 'W', attachedTo: { kind: 'project' } } },
    ], C);
    const ids = touchedBy(tree, C);
    expect(ids[0]).toBe('goal');
    expect(ids[1]).toMatch(/^rec-/);
    expect(ids[2]).toBe(tree.tasks[0].id);
  });
});

describe('touchedBy ordering', () => {
  it('lists what this contribution created before what it only changed', () => {
    const old = makeRecord({ id: 'rec-old', type: 'decision', text: 'Old' });
    const { tree } = applyOps(makeProject({ records: [old] }), [
      { type: 'addRecord', record: { type: 'decision', text: 'New', links: { replaces: 'rec-old' }, attachedTo: { kind: 'project' } } },
    ], 'c-9');
    const ids = touchedBy(tree, 'c-9');
    expect(ids[0]).not.toBe('rec-old');
    expect(ids).toContain('rec-old');
  });
});

describe('what a new record may replace', () => {
  it('only an active record of the same type', () => {
    const dec = makeRecord({ id: 'rec-d', type: 'decision' });
    const { tree, dropped } = applyOps(makeProject({ records: [dec] }), [
      { type: 'addRecord', record: { type: 'rule', text: 'x', links: { replaces: 'rec-d' }, attachedTo: { kind: 'project' } } },
    ], 'c-1');
    expect(dropped[0].reason).toMatch(/replace/);
    expect(tree.records.find(r => r.id === 'rec-d').status).toBe('active');
  });
});

describe('malformed proposals never crash a contribution', () => {
  it('drops a record whose links are the wrong shape, and keeps the rest', () => {
    const { tree, dropped } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'decision', text: 'x', links: { restsOn: 'rec-abc' }, attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'decision', text: 'y', links: 'abc', attachedTo: { kind: 'project' } } },
      { type: 'addRecord', record: { type: 'decision', text: { not: 'text' }, attachedTo: { kind: 'project' } } },
      { type: 'addTask', title: 'kept' },
    ], 'c-1');
    expect(dropped).toHaveLength(3);
    expect(tree.tasks.map(t => t.title)).toEqual(['kept']);
  });
});

describe('edits pass the same checks as additions', () => {
  const rule = () => makeRecord({ id: 'rec-r', type: 'rule', text: 'No nuts' });
  const dec = () => makeRecord({ id: 'rec-d', type: 'decision', text: 'Banana cake' });
  const exc = () => makeRecord({ id: 'rec-e', type: 'exception', text: 'Frosting', expiresAt: '2026-12-31', links: { bends: 'rec-r' } });
  it('an exception cannot be re-pointed at something that is not a rule', () => {
    const { dropped } = applyOps(makeProject({ records: [rule(), dec(), exc()] }), [
      { type: 'editRecord', id: 'rec-e', changes: { links: { bends: 'rec-d' } } },
      { type: 'editRecord', id: 'rec-e', changes: { links: { bends: 'nope' } } },
    ], 'c-1');
    expect(dropped).toHaveLength(2);
  });
  it('a record cannot be attached to a task that is not here', () => {
    const { dropped } = applyOps(makeProject({ records: [dec()] }), [
      { type: 'editRecord', id: 'rec-d', changes: { attachedTo: { kind: 'task', id: 'task-zzz' } } },
    ], 'c-1');
    expect(dropped[0].reason).toMatch(/attachedTo/);
  });
});

describe('where a record is written decides where it is attached', () => {
  it('defaults a record in a workstream to that workstream, and refuses a task that is not there', () => {
    const ws = { id: 'food', name: 'Food', records: [], tasks: [] };
    const { tree, dropped } = applyOps(ws, [
      { type: 'addRecord', record: { type: 'decision', text: 'Banana cake' } },
      { type: 'addRecord', record: { type: 'decision', text: 'x', attachedTo: { kind: 'task', id: 'task-nope' } } },
    ], 'c-1', { target: 'food' });
    expect(tree.records[0].attachedTo).toEqual({ kind: 'workstream', id: 'food' });
    expect(dropped[0].reason).toMatch(/attachedTo/);
  });
  it('a goal can only be set on the project', () => {
    const ws = { id: 'food', name: 'Food', records: [], tasks: [] };
    const { tree, dropped } = applyOps(ws, [{ type: 'setGoal', text: 'G' }], 'c-1', { target: 'food' });
    expect(tree.goal).toBeUndefined();
    expect(dropped[0].reason).toMatch(/goal/);
  });
});

describe('the goal carries its own reason', () => {
  it('setGoal keeps why it matters', () => {
    const { tree } = applyOps(makeProject(), [{ type: 'setGoal', text: 'Win 3 clients', why: 'Our proof points are strongest there' }], 'c-1');
    expect(tree.goal).toMatchObject({ text: 'Win 3 clients', why: 'Our proof points are strongest there' });
  });
});

/**
 * The two moments that need the time of day.
 *
 * `updatedAt` is a date, which cannot order two changes made in one sitting —
 * and breaking an assumption then re-confirming a decision that rested on it is
 * exactly one sitting. `src/impact.js` compares these two stamps to decide
 * whether a flag has been answered, so the order has to survive.
 */
describe('when something broke, and when it was last looked at', () => {
  const at = '2026-10-05T09:00:00.000Z';
  const assumption = () => makeRecord({
    id: 'a1', type: 'assumption', owner: { key: 'git:o@x', name: 'O' }, reviewBy: '2026-12-01',
  });

  it('stamps brokenAt when an assumption is marked broken', () => {
    const { tree } = applyOps(
      makeProject({ records: [assumption()] }),
      [{ type: 'setRecordStatus', id: 'a1', status: 'broken' }], C, { at },
    );
    expect(tree.records[0].status).toBe('broken');
    expect(tree.records[0].brokenAt).toBe(at);
  });

  it('stamps reviewedAt when an already-active record is set active again', () => {
    // The re-confirmation. It looks like a no-op — the status does not move —
    // and it is how the manager says "I have looked, this still holds" without
    // replacing it.
    const { tree } = applyOps(
      makeProject({ records: [makeRecord({ id: 'd1', type: 'decision' })] }),
      [{ type: 'setRecordStatus', id: 'd1', status: 'active' }], C, { at },
    );
    expect(tree.records[0].status).toBe('active');
    expect(tree.records[0].reviewedAt).toBe(at);
  });

  it('does not call reviving a broken record a re-confirmation', () => {
    // Bringing an assumption back is not somebody having re-read what rested on
    // it, and stamping `reviewedAt` here would clear flags nobody answered.
    const { tree } = applyOps(
      makeProject({ records: [makeRecord({ id: 'a1', type: 'assumption', status: 'broken', reviewBy: '2026-12-01' })] }),
      [{ type: 'setRecordStatus', id: 'a1', status: 'active' }], C, { at },
    );
    expect(tree.records[0].status).toBe('active');
    expect(tree.records[0].reviewedAt).toBeUndefined();
  });

  it('leaves both stamps alone for a status that is neither', () => {
    const { tree } = applyOps(
      makeProject({ records: [makeRecord({ id: 'd1', type: 'decision' })] }),
      [{ type: 'setRecordStatus', id: 'd1', status: 'closed' }], C, { at },
    );
    expect(tree.records[0].brokenAt).toBeUndefined();
    expect(tree.records[0].reviewedAt).toBeUndefined();
  });

  it('keeps the date on updatedAt, which is what gets shown', () => {
    const { tree } = applyOps(
      makeProject({ records: [assumption()] }),
      [{ type: 'setRecordStatus', id: 'a1', status: 'broken' }], C, { at, onDay: '2026-10-05' },
    );
    expect(tree.records[0].updatedAt).toBe('2026-10-05');
  });

  it('records a second break over the first, so a repair can go stale again', () => {
    const broke = applyOps(
      makeProject({ records: [assumption()] }),
      [{ type: 'setRecordStatus', id: 'a1', status: 'broken' }], C, { at },
    ).tree;
    const revived = applyOps(broke, [{ type: 'setRecordStatus', id: 'a1', status: 'active' }], C, { at: '2026-10-06T09:00:00.000Z' }).tree;
    const again = applyOps(revived, [{ type: 'setRecordStatus', id: 'a1', status: 'broken' }], C, { at: '2026-10-07T09:00:00.000Z' }).tree;
    expect(again.records[0].brokenAt).toBe('2026-10-07T09:00:00.000Z');
  });

  it('still refuses a status it does not know, and a record that is not there', () => {
    const base = makeProject({ records: [assumption()] });
    expect(applyOps(base, [{ type: 'setRecordStatus', id: 'a1', status: 'wobbly' }], C, { at }).dropped).toHaveLength(1);
    expect(applyOps(base, [{ type: 'setRecordStatus', id: 'nope', status: 'broken' }], C, { at }).dropped).toHaveLength(1);
  });
});
