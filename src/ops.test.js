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
      { type: 'addRecord', record: { type: 'why', text: 'W', attachedTo: { kind: 'project' } } },
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
