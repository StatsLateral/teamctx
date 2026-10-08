import { describe, it, expect } from 'vitest';
import { taskHistory, historyStatus, historyLine, touchesTask } from './task-history.js';

const task = (over = {}) => ({ id: 't1', title: 'Draft the plan', status: 'open', createdAt: '2026-09-30', sourceContributionIds: ['c1'], ...over });
const c1 = { author: 'Maya', source: 'mcp', ts: '2026-09-30T09:00:00.000Z' };
const approvedC1 = { approvedBy: { key: 'git:maya@x', name: 'Maya' }, approvedAt: '2026-09-30T10:00:00.000Z' };
const queued = (over = {}) => ({ id: 'q1', author: 'Content Writer', source: 'mcp', createdAt: '2026-10-06T08:00:00.000Z', operations: [{ type: 'editTask', id: 't1', title: 'Draft the plan again' }], ...over });
const did = (h) => h.events.map(e => e.did + (e.waiting ? ':waiting' : ''));

describe('a task’s history', () => {
  it('lists a submission and its approval, oldest first, and reads Approved', () => {
    const h = taskHistory({ task: task(), contributions: { c1 }, approvals: { c1: approvedC1 } });
    expect(h.events).toEqual([
      { at: c1.ts, by: 'Maya', did: 'submitted', via: 'assistant', contribution: 'c1' },
      { at: approvedC1.approvedAt, by: 'Maya', did: 'approved', contribution: 'c1' },
    ]);
    expect(historyStatus(h)).toBe('Approved');
  });

  it('shows a new submission waiting, after the approved one', () => {
    const h = taskHistory({ task: task(), contributions: { c1 }, approvals: { c1: approvedC1 }, queue: [queued(), queued({ id: 'q2', operations: [{ type: 'editTask', id: 'other' }] })] });
    expect(did(h)).toEqual(['submitted', 'approved', 'submitted:waiting']);
    expect(h.events[2]).toMatchObject({ by: 'Content Writer', contribution: 'q1' });
    expect(historyStatus(h)).toBe('Approved · a new submission is waiting');
  });

  it('shows something only in the queue as not approved, with no approval line', () => {
    const h = taskHistory({ task: null, pending: [queued({ operations: [{ type: 'addTask', title: 'New' }] })] });
    expect(did(h)).toEqual(['submitted:waiting']);
    expect(historyStatus(h)).toBe('Not approved yet');
  });

  it('lists completing, reopening and completing again, with who', () => {
    const statusLog = [
      { did: 'completed', by: { name: 'Alder Health Agent' }, at: '2026-10-01T09:00:00.000Z' },
      { did: 'reopened', by: { name: 'Maya' }, at: '2026-10-02T09:00:00.000Z' },
      { did: 'completed', by: { name: 'Maya' }, at: '2026-10-03T09:00:00.000Z' },
    ];
    const h = taskHistory({ task: task({ status: 'done', doneAt: '2026-10-03', statusLog }), contributions: { c1 }, approvals: { c1: approvedC1 } });
    expect(did(h)).toEqual(['submitted', 'approved', 'completed', 'reopened', 'completed']);
    expect(h.events.slice(2).map(e => e.by)).toEqual(['Alder Health Agent', 'Maya', 'Maya']);
  });

  it('says Added for a task from before any of this was recorded, and invents nothing', () => {
    const h = taskHistory({ task: task({ sourceContributionIds: undefined, createdAt: '2026-09-01' }) });
    expect(h.events).toEqual([{ at: '2026-09-01', by: null, did: 'added', unrecorded: true }]);
    expect(historyStatus(h)).toBe('Added');
  });

  it('says who added a task added directly, with no contribution behind it', () => {
    const h = taskHistory({ task: task({ sourceContributionIds: undefined, addedBy: { key: 'k', name: 'Maya' }, addedAt: '2026-10-08T09:00:00.000Z' }) });
    expect(h.events).toEqual([{ at: '2026-10-08T09:00:00.000Z', by: 'Maya', did: 'added' }]);
    expect(historyLine(h.events[0])).toBe('added it');
    expect(taskHistory({ task: task({ sourceContributionIds: undefined, addedBy: { name: 'Maya' } }), canSee: () => false }).events[0])
      .toMatchObject({ by: null, did: 'added' });
  });

  it('never calls a submission approved when nobody recorded approving it', () => {
    const h = taskHistory({ task: task(), contributions: { c1 } });
    expect(did(h)).toEqual(['submitted']);
    expect(h.status).toBe('added');
  });

  it('shows a completion with no recorded actor as done, by nobody named', () => {
    const h = taskHistory({ task: task({ status: 'done', doneAt: '2026-10-04' }), contributions: { c1 }, approvals: { c1: approvedC1 } });
    expect(h.events.at(-1)).toEqual({ at: '2026-10-04', by: null, did: 'completed', unrecorded: true });
  });

  it('lists a rejected change with who turned it down and why', () => {
    const rejected = [{ ...queued(), rejectedBy: 'Maya', rejectedAt: '2026-10-07T09:00:00.000Z', reason: 'not this quarter' }];
    const h = taskHistory({ task: task(), contributions: { c1 }, approvals: { c1: approvedC1 }, rejected });
    expect(did(h)).toEqual(['submitted', 'approved', 'submitted', 'rejected']);
    expect(historyLine(h.events[3])).toBe('rejected it: not this quarter');
  });

  it('says a contribution went in under the review policy, naming no approver', () => {
    const h = taskHistory({ task: task(), contributions: { c1 }, approvals: { c1: { approvedBy: null, by: 'policy', approvedAt: c1.ts } } });
    expect(h.events[1]).toMatchObject({ did: 'approved', by: null, byPolicy: true });
    expect(historyLine(h.events[1])).toMatch(/without review/);
  });

  it('shows a name the reader may not see as someone', () => {
    const h = taskHistory({ task: task(), contributions: { c1 }, approvals: { c1: approvedC1 }, canSee: n => n !== 'Maya' });
    expect(h.events.map(e => e.by)).toEqual([null, null]);
  });

  it('says an agent submitted as an agent', () => {
    const h = taskHistory({ task: null, pending: [queued()], isAgent: n => n === 'Content Writer' });
    expect(historyLine(h.events[0])).toBe('submitted it as an agent');
  });

  it('only counts edits and removals of this task as being about it', () => {
    expect(touchesTask(queued(), 't1')).toBe(true);
    expect(touchesTask(queued(), 't2')).toBe(false);
    expect(touchesTask({ operations: 'not a list' }, 't1')).toBe(false);
  });
});
