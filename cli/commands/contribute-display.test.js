import { describe, it, expect } from 'vitest';
import { describeOp } from './contribute.js';

describe('how the terminal shows a proposed change', () => {
  it('says each kind of change in plain words, with the record labels', () => {
    expect(describeOp({ type: 'setGoal', text: 'Ship by Q3' })).toBe('+ Goal: Ship by Q3');
    expect(describeOp({ type: 'addRecord', record: { type: 'rule', text: 'No nuts' } })).toBe('+ Rule: No nuts');
    expect(describeOp({ type: 'addRecord', record: { type: 'exception', text: 'Frosting on the adults cake' } })).toBe('+ Allowed: Frosting on the adults cake');
    expect(describeOp({ type: 'addTask', title: 'Bake the cake' })).toBe('+ Task: Bake the cake');
    expect(describeOp({ type: 'editRecord', id: 'r1', changes: { text: 'No nuts at all' } })).toBe('~ Edit r1: No nuts at all');
    expect(describeOp({ type: 'setRecordStatus', id: 'a1', status: 'broken' })).toBe('~ Mark a1 broken');
    expect(describeOp({ type: 'removeTask', id: 't1' })).toBe('- Remove task t1');
  });
  it('never prints a type name or the old tree words', () => {
    const out = describeOp({ type: 'addRecord', record: { type: 'assumption', text: '20 guests' } });
    expect(out).toBe("+ We're assuming: 20 guests");
    expect(out).not.toMatch(/Why:|What:|How:|assumption/);
  });
});
