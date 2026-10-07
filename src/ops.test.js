import { describe, it, expect } from 'vitest';
import { applyOps, touchedBy, OP_TYPES } from './ops.js';
import { makeProject, makeRecord, makeWorkstream } from './test-fixtures/model.js';

const C = 'c-1';
// Tasks live in a workstream, and take their number from its number.
const food = (over = {}) => makeWorkstream('food', over);
const FOOD = { workstreamNumber: 3 };

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
    let { tree } = applyOps(food(), [{ type: 'addTask', title: 'Bake cake' }], C, FOOD);
    const id = tree.tasks[0].id;
    ({ tree } = applyOps(tree, [{ type: 'editTask', id, title: 'Bake the cake' }], 'c-2'));
    expect(tree.tasks[0]).toMatchObject({ title: 'Bake the cake', status: 'open', owner: null, key: '3.1' });
    ({ tree } = applyOps(tree, [{ type: 'removeTask', id }], 'c-3'));
    expect(tree.tasks).toEqual([]);
  });

  it('applies in order setGoal → adds → edits → evidence → status → removals', () => {
    // Evidence before status reads as a person would say it; it does not change
    // the result, since evidence is kept only beside a break and lands on a
    // broken assumption as readily as an active one.
    expect(OP_TYPES).toEqual(['setGoal', 'addRecord', 'editRecord', 'addEvidence', 'setRecordStatus', 'addTask', 'editTask', 'removeTask']);
  });
});

describe('touchedBy', () => {
  it('lists the goal, then records, then tasks this contribution wrote', () => {
    const { tree } = applyOps(food(), [
      { type: 'addTask', title: 'T' },
      { type: 'addRecord', record: { type: 'decision', text: 'W', attachedTo: { kind: 'workstream', id: 'food' } } },
    ], C, FOOD);
    const ids = touchedBy({ ...tree, goal: { sourceContributionIds: [C] } }, C);
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
    const { tree, dropped } = applyOps(food(), [
      { type: 'addRecord', record: { type: 'decision', text: 'x', links: { restsOn: 'rec-abc' }, attachedTo: { kind: 'workstream', id: 'food' } } },
      { type: 'addRecord', record: { type: 'decision', text: 'y', links: 'abc', attachedTo: { kind: 'workstream', id: 'food' } } },
      { type: 'addRecord', record: { type: 'decision', text: { not: 'text' }, attachedTo: { kind: 'workstream', id: 'food' } } },
      { type: 'addTask', title: 'kept' },
    ], 'c-1', FOOD);
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
 * Numbers are minted as tasks land, and only as tasks land.
 *
 * The counters live in `config.json` while the tasks go into a tree, so they
 * travel in and out rather than being written here. That is what makes the
 * queued path work without a special case: a contribution on its way to review
 * has its tree thrown away, the counters go with it, and a contribution that is
 * rejected never spends a number. Records have no number at all.
 */
describe('the number a task is minted with', () => {
  const add = (type, text, over = {}) => ({
    type: 'addRecord',
    record: {
      type, text, ...(type === 'assumption' ? { owner: { name: 'O' }, reviewBy: '2026-12-01' } : {}), ...over,
    },
  });

  it('is the workstream number, a dot, and the next task in that workstream', () => {
    const { tree, nextKey } = applyOps(food(), [
      { type: 'addTask', title: 'one' }, { type: 'addTask', title: 'two' },
    ], C, FOOD);
    expect(tree.tasks.map(t => t.key)).toEqual(['3.1', '3.2']);
    expect(nextKey.tasks).toEqual({ food: 3 });
  });

  it('carries on from the counters it was given, not from what is in the tree', () => {
    // The tree may have had tasks deleted out of it. The counters are the
    // record of what has been handed out.
    const { tree } = applyOps(food(), [{ type: 'addTask', title: 'next one' }], C, { ...FOOD, nextKey: { workstream: 9, tasks: { food: 7 } } });
    expect(tree.tasks[0].key).toBe('3.7');
  });

  it('counts each workstream on its own', () => {
    const a = applyOps(food(), [{ type: 'addTask', title: 'a' }], C, FOOD);
    const b = applyOps(makeWorkstream('drink'), [{ type: 'addTask', title: 'b' }], C, { workstreamNumber: 4, nextKey: a.nextKey });
    expect(b.tree.tasks[0].key).toBe('4.1');
    expect(b.nextKey.tasks).toEqual({ food: 2, drink: 2 });
  });

  it('is not given to a task in the project itself: every task belongs to a workstream', () => {
    const { tree, dropped, nextKey } = applyOps(makeProject(), [{ type: 'addTask', title: 'loose' }], C, FOOD);
    expect(tree.tasks).toEqual([]);
    expect(dropped[0].reason).toMatch(/workstream/);
    expect(nextKey.tasks).toEqual({});
  });

  it('is not invented for a workstream that has no number', () => {
    const { tree, dropped } = applyOps(food(), [{ type: 'addTask', title: 'x' }], C);
    expect(tree.tasks).toEqual([]);
    expect(dropped[0].reason).toMatch(/no number/);
  });

  it('is the one a queued item was given, for the first task it adds', () => {
    // "Approve 1.6" then becomes "task 1.6". Only the first: a second task in the
    // same item takes the next number in the workstream.
    const { tree, nextKey } = applyOps(food(), [
      { type: 'addTask', title: 'first' }, { type: 'addTask', title: 'second' },
    ], C, { ...FOOD, reservedKey: '3.6', nextKey: { workstream: 4, tasks: { food: 7 } } });
    expect(tree.tasks.map(t => t.key)).toEqual(['3.6', '3.7']);
    expect(nextKey.tasks.food).toBe(8);
  });

  it.each([
    ['one in another workstream', '9.1'],
    ['one that was never handed out', '3.50'],
    ['one that is not a number at all', '<script>'],
    ['one already on a task that is here', '3.2'],
  ])('is not taken from a queued item that carries %s', (_, forged) => {
    // The number is read back from a file somebody else could have edited, so a
    // forged one must not become a task's number: a fresh one is minted instead.
    const ws = food({ tasks: [{ id: 'task-x', key: '3.2', title: 'Already here', status: 'open' }] });
    const { tree, nextKey } = applyOps(ws, [{ type: 'addTask', title: 'new' }], C, {
      ...FOOD, reservedKey: forged, nextKey: { workstream: 4, tasks: { food: 5 } },
    });
    expect(tree.tasks.find(t => t.title === 'new').key).toBe('3.5');
    expect(nextKey.tasks.food).toBe(6);
  });

  it('is not spent by a task that is dropped', () => {
    const { nextKey } = applyOps(food(), [{ type: 'addTask', title: '   ' }, { type: 'addTask', title: 'real' }], C, FOOD);
    expect(nextKey.tasks.food).toBe(2);
  });

  it('is left alone by a contribution that does nothing', () => {
    const { nextKey } = applyOps(food(), [], C, { ...FOOD, nextKey: { workstream: 4, tasks: { food: 4 } } });
    expect(nextKey).toEqual({ workstream: 4, tasks: { food: 4 } });
  });

  it('does not change the counters object it was given', () => {
    // The caller holds this and decides whether it is written. Mutating it would
    // spend a number on a contribution that then went to the queue instead.
    const counters = { workstream: 2, tasks: { food: 1 } };
    applyOps(food(), [{ type: 'addTask', title: 'x' }], C, { ...FOOD, nextKey: counters });
    expect(counters).toEqual({ workstream: 2, tasks: { food: 1 } });
  });
});

describe('a record', () => {
  it('has an internal id and no number', () => {
    const { tree } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'decision', text: 'x' } },
      { type: 'addRecord', record: { type: 'rule', text: 'y' } },
    ], C);
    expect(tree.records).toHaveLength(2);
    for (const r of tree.records) {
      expect(r.id).toMatch(/^rec-/);
      expect(r).not.toHaveProperty('key');
    }
  });

  it('spends no counter, whatever it is', () => {
    const { nextKey } = applyOps(food(), [
      { type: 'addRecord', record: { type: 'decision', text: 'x' } },
      { type: 'addRecord', record: { type: 'rule', text: 'y' } },
    ], C, FOOD);
    expect(nextKey).toEqual({ workstream: 1, tasks: {} });
  });
});

/**
 * A dropped operation is identifiable by where it sat, not by being the same
 * object.
 *
 * `resolveTaskRef` hands back a **copy** when a record attaches to a task added
 * in the same contribution. Callers matched what was dropped against what they
 * sent by comparing the operation objects, and a copy is never identical — so a
 * dropped operation read as a kept one. It was reported to the person, written
 * into the queue item, and dropped again on approval.
 */
describe('finding a dropped operation again', () => {
  it('says where it sat in what the caller sent', () => {
    const { dropped } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'decision', text: 'fine' } },
      { type: 'addRecord', record: { type: 'decision', text: '' } },
    ], C);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].index).toBe(1);
  });

  it('says so for one that was copied on the way through', () => {
    // The case that broke it: the record attaches to a task added alongside it,
    // so `resolveTaskRef` replaces the operation with a copy — and this one
    // fails validation afterwards, with an exception bending nothing.
    const { dropped } = applyOps(food(), [
      { type: 'addTask', ref: 'T', title: 'Build it' },
      {
        type: 'addRecord',
        record: {
          type: 'exception', text: 'just this once', expiresAt: '2026-12-31',
          attachedTo: { kind: 'task', id: 'T' }, links: { bends: 'rec-nope' },
        },
      },
    ], C, FOOD);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].index).toBe(1);
  });

  it('numbers every operation from the list as sent, not from its own group', () => {
    // Records are applied in two passes, exceptions after the rest, so a group
    // index would not match what the caller holds.
    const { dropped } = applyOps(makeProject(), [
      { type: 'addRecord', record: { type: 'exception', text: 'x', expiresAt: '2026-12-31', links: { bends: 'rec-nope' } } },
      { type: 'addRecord', record: { type: 'decision', text: 'kept' } },
      { type: 'addRecord', record: { type: 'decision', text: '' } },
    ], C);
    expect(dropped.map(d => d.index).sort()).toEqual([0, 2]);
  });

  it('answers -1 for something that was never in the list', () => {
    const { dropped } = applyOps(makeProject(), [{ type: 'nonsense' }], C);
    expect(dropped[0].index).toBe(0);
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

/**
 * Evidence that an assumption may no longer hold.
 *
 * The distiller supplies the quote; who, where from and when are stamped from
 * the contribution before this runs. Evidence is kept only beside a proposed
 * break of the same assumption — #122 defines it as evidence *against*, and a
 * live run showed the model attaching supporting observations and bare mentions
 * as evidence too.
 */
describe('evidence against an assumption', () => {
  const assumption = (over = {}) => makeRecord({
    id: 'a1', type: 'assumption', text: 'Buyers need SSO before a pilot',
    owner: { key: 'k', name: 'O' }, reviewBy: '2026-12-01', ...over,
  });
  const evidence = (over = {}) => ({
    type: 'addEvidence', id: 'a1',
    evidence: { text: 'The last three prospects piloted without SSO', source: 'mcp', at: '2026-10-06T09:00:00.000Z', by: 'Priya', ...over },
  });
  const breakIt = { type: 'setRecordStatus', id: 'a1', status: 'broken' };

  it('is appended with the break it argues for, with everything stamped on it', () => {
    const { tree, dropped } = applyOps(makeProject({ records: [assumption()] }), [evidence(), breakIt], C);
    expect(dropped).toEqual([]);
    expect(tree.records[0].status).toBe('broken');
    expect(tree.records[0].evidence).toEqual([{
      text: 'The last three prospects piloted without SSO', source: 'mcp', at: '2026-10-06T09:00:00.000Z', by: 'Priya',
    }]);
    expect(tree.records[0].sourceContributionIds).toContain(C);
  });

  it('lands alongside the break in either order', () => {
    for (const ops of [[evidence(), breakIt], [breakIt, evidence()]]) {
      const { tree, dropped } = applyOps(makeProject({ records: [assumption()] }), ops, C);
      expect(dropped).toEqual([]);
      expect(tree.records[0].evidence).toHaveLength(1);
    }
  });

  it('is dropped with no break of that assumption beside it', () => {
    // "We are interviewing senior engineers this week", attached as evidence on
    // its own, in the live run. It argues against nothing.
    const { tree, dropped } = applyOps(makeProject({ records: [assumption()] }), [evidence()], C);
    expect(dropped[0].reason).toMatch(/only with a proposed break/);
    expect(tree.records[0].evidence).toBeUndefined();
    expect(tree.records[0].status).toBe('active');
  });

  it('is dropped beside a close rather than a break', () => {
    // "Two candidates accepted offers" — supporting evidence — came back as
    // evidence plus a proposal to close the assumption as validated. Closing
    // may be the manager's call; it is not evidence against anything.
    const { tree, dropped } = applyOps(makeProject({ records: [assumption()] }), [
      evidence(), { type: 'setRecordStatus', id: 'a1', status: 'closed' },
    ], C);
    expect(dropped.map(d => d.reason)).toEqual([expect.stringMatching(/only with a proposed break/)]);
    expect(tree.records[0].status).toBe('closed');
    expect(tree.records[0].evidence).toBeUndefined();
  });

  it('is dropped beside a break of a different assumption', () => {
    const other = makeRecord({ id: 'a2', type: 'assumption', text: 'other', owner: { key: 'k', name: 'O' }, reviewBy: '2026-12-01' });
    const { dropped } = applyOps(makeProject({ records: [assumption(), other] }), [
      evidence(), { type: 'setRecordStatus', id: 'a2', status: 'broken' },
    ], C);
    expect(dropped[0].reason).toMatch(/only with a proposed break/);
  });

  it('adds to what is already there rather than replacing it', () => {
    const before = assumption({ evidence: [{ text: 'earlier', source: 'cli', at: null, by: 'Dev' }] });
    const { tree } = applyOps(makeProject({ records: [before] }), [evidence(), breakIt], C);
    expect(tree.records[0].evidence.map(e => e.text)).toEqual(['earlier', 'The last three prospects piloted without SSO']);
  });

  it('still lands on an assumption somebody else broke while it waited', () => {
    // The queued item carries its own break, so on approval the pair is intact
    // even though the assumption is already broken. Losing the evidence because
    // the other break got there first would throw away what the manager approved.
    const { tree, dropped } = applyOps(makeProject({ records: [assumption({ status: 'broken' })] }), [evidence(), breakIt], C);
    expect(dropped).toEqual([]);
    expect(tree.records[0].evidence).toHaveLength(1);
  });

  it('is refused against an assumption that is history', () => {
    for (const status of ['replaced', 'closed']) {
      const { dropped } = applyOps(makeProject({ records: [assumption({ status })] }), [evidence()], C);
      expect(dropped[0].reason).toMatch(new RegExp(status));
    }
  });

  it('is refused against anything that is not an assumption', () => {
    // A decision does not break; it is replaced. Evidence against one is a
    // contradiction, which #121 handles.
    const d = makeRecord({ id: 'a1', type: 'decision', text: 'Build SSO first' });
    const { dropped } = applyOps(makeProject({ records: [d] }), [evidence()], C);
    expect(dropped[0].reason).toMatch(/against an assumption/);
  });

  it('is refused against a record that is not there', () => {
    const { dropped } = applyOps(makeProject({ records: [assumption()] }), [{ ...evidence(), id: 'nope' }], C);
    expect(dropped[0].reason).toMatch(/no record/);
  });

  it('is refused with no quote, or a quote that is only whitespace', () => {
    for (const e of [{ text: '' }, { text: '   ' }, {}, null]) {
      const { dropped } = applyOps(makeProject({ records: [assumption()] }), [{ type: 'addEvidence', id: 'a1', evidence: e }, breakIt], C);
      expect(dropped[0].reason).toMatch(/evidence text is empty/);
    }
  });

  it('records nothing it was not given rather than inventing it', () => {
    const { tree } = applyOps(makeProject({ records: [assumption()] }), [{ type: 'addEvidence', id: 'a1', evidence: { text: 'x' } }, breakIt], C);
    expect(tree.records[0].evidence[0]).toEqual({ text: 'x', source: null, at: null, by: null });
  });
});

/**
 * An edit that changes nothing is not an edit.
 *
 * Applied, it would stamp the contribution onto the record's provenance and
 * move its date — saying the record was changed by something that left it
 * exactly as it was. A live run showed a model restating both decisions that
 * rested on an assumption it was breaking, word for word.
 */
describe('an edit that changes nothing', () => {
  const decision = () => makeRecord({ id: 'd1', type: 'decision', text: 'Build SSO first', detail: 'why', sourceContributionIds: ['c-0'] });

  it('is dropped, and the record is left untouched', () => {
    const before = decision();
    const { tree, dropped } = applyOps(makeProject({ records: [before] }), [
      { type: 'editRecord', id: 'd1', changes: { text: 'Build SSO first' } },
    ], C);
    expect(dropped[0].reason).toBe('the edit changes nothing');
    expect(tree.records[0]).toEqual(before);
  });

  it('counts links merged back to what they were as no change', () => {
    const before = makeRecord({ id: 'd1', type: 'decision', text: 'x', links: { restsOn: ['a1'] } });
    const { dropped } = applyOps(makeProject({ records: [before] }), [
      { type: 'editRecord', id: 'd1', changes: { links: { restsOn: ['a1'] } } },
    ], C);
    expect(dropped[0].reason).toBe('the edit changes nothing');
  });

  it('still applies an edit that changes anything at all', () => {
    const { tree, dropped } = applyOps(makeProject({ records: [decision()] }), [
      { type: 'editRecord', id: 'd1', changes: { text: 'Build SSO first', detail: 'a new reason' } },
    ], C);
    expect(dropped).toEqual([]);
    expect(tree.records[0].detail).toBe('a new reason');
    expect(tree.records[0].sourceContributionIds).toContain(C);
  });
});
