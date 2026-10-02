import { describe, it, expect } from 'vitest';
import { digestProject } from './tree-digest.js';

const dec = (text) => ({ id: text, type: 'decision', text, status: 'active' });

describe('digestProject', () => {
  it('reads back the goal, why it matters, what was settled and the parts of the work', () => {
    const d = digestProject({
      project: { goal: { text: 'Ship the ledger by March', why: 'Audit season' }, records: [dec('Reconcile daily')], tasks: [] },
      workstreams: [{ id: 'rec', name: 'Reconciliation', number: '1', records: [dec('Daily')], tasks: [{ id: 't', title: 'Import feed' }] }],
    });
    expect(d.goal).toBe('Ship the ledger by March');
    expect(d.why).toBe('Audit season');
    expect(d.settled).toEqual(['Reconcile daily']);
    expect(d.workstreams).toEqual([{ number: '1', name: 'Reconciliation', tasks: 1, records: 1 }]);
    expect(d.counts).toEqual({ decision: 2, tasks: 1 });
    expect(d.more).toBe(false);
  });

  it('counts everything but lists a trimmed set, and says more was left out', () => {
    const d = digestProject({ project: { goal: null, records: Array.from({ length: 10 }, (_, i) => dec(`d${i}`)), tasks: [] } });
    expect(d.settled).toHaveLength(8);
    expect(d.counts.decision).toBe(10);
    expect(d.more).toBe(true);
  });

  it('leaves out records that are no longer active', () => {
    const d = digestProject({ project: { records: [{ ...dec('old'), status: 'replaced' }], tasks: [] } });
    expect(d.settled).toEqual([]);
    expect(d.counts.decision).toBeUndefined();
  });

  it('trims long text', () => {
    const d = digestProject({ project: { goal: { text: 'x'.repeat(400) }, records: [], tasks: [] } });
    expect(d.goal.length).toBeLessThanOrEqual(160);
  });
});
