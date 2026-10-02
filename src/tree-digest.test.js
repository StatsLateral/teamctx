import { describe, it, expect } from 'vitest';
import { digestProject } from './tree-digest.js';

const why = (text) => ({ id: text, type: 'why', text, status: 'active' });

describe('digestProject', () => {
  it('reads back the goal, the whys and the parts of the work, numbered', () => {
    const d = digestProject({
      project: { goal: { text: 'Ship the ledger by March' }, records: [why('Stay audit-ready')], tasks: [] },
      workstreams: [{ id: 'rec', name: 'Reconciliation', number: '1', records: [{ id: 'd', type: 'decision', text: 'Daily', status: 'active' }], tasks: [{ id: 't', title: 'Import feed' }] }],
    });
    expect(d.goal).toBe('Ship the ledger by March');
    expect(d.whys).toEqual(['Stay audit-ready']);
    expect(d.workstreams).toEqual([{ number: '1', name: 'Reconciliation', tasks: 1, records: 1 }]);
    expect(d.counts).toEqual({ why: 1, decision: 1, tasks: 1 });
    expect(d.more).toBe(false);
  });

  it('counts everything but lists a trimmed set, and says more was left out', () => {
    const d = digestProject({ project: { goal: null, records: Array.from({ length: 10 }, (_, i) => why(`w${i}`)), tasks: [] } });
    expect(d.whys).toHaveLength(8);
    expect(d.counts.why).toBe(10);
    expect(d.more).toBe(true);
  });

  it('leaves out records that are no longer active', () => {
    const d = digestProject({ project: { records: [{ ...why('old'), status: 'replaced' }], tasks: [] } });
    expect(d.whys).toEqual([]);
    expect(d.counts.why).toBeUndefined();
  });

  it('trims long text', () => {
    const d = digestProject({ project: { goal: { text: 'x'.repeat(400) }, records: [], tasks: [] } });
    expect(d.goal.length).toBeLessThanOrEqual(160);
  });
});
