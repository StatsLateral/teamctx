import { describe, it, expect } from 'vitest';
import { freshness, freshnessLine, withFreshness } from './freshness.js';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');

describe('freshness', () => {
  it('takes the date from the newest approval', () => {
    const approvals = {
      a: { id: 'a', approvedAt: '2026-09-01T10:00:00.000Z' },
      b: { id: 'b', approvedAt: '2026-10-02T10:00:00.000Z' },
      c: { id: 'c', approvedAt: '2026-09-20T10:00:00.000Z' },
    };
    expect(freshness('x', { approvals, queue: [] }).lastApprovedAt).toBe('2026-10-02T10:00:00.000Z');
  });

  it('has no date when nothing was recorded, and does not guess', () => {
    expect(freshness('x', { approvals: {}, queue: [] }).lastApprovedAt).toBeNull();
    expect(freshness('x', { approvals: { a: { id: 'a' }, b: { id: 'b', approvedAt: 'soon' } }, queue: [] }).lastApprovedAt).toBeNull();
  });

  it('counts what is waiting', () => {
    expect(freshness('x', { approvals: {}, queue: [{ id: 1 }, { id: 2 }, { id: 3 }] }).waiting).toBe(3);
  });
});

describe('freshnessLine', () => {
  it('reads in days and counts', () => {
    expect(freshnessLine({ lastApprovedAt: '2026-10-02T12:00:00.000Z', waiting: 3 }, NOW)).toBe('Context last approved 12 days ago; 3 items waiting');
  });
  it('says "not recorded" without a date', () => {
    expect(freshnessLine({ lastApprovedAt: null, waiting: 1 }, NOW)).toBe('Context last approved: not recorded; 1 item waiting');
  });
  it('says so when nothing is waiting', () => {
    expect(freshnessLine({ lastApprovedAt: '2026-10-14T01:00:00.000Z', waiting: 0 }, NOW)).toBe('Context last approved today; nothing waiting');
  });
});

describe('withFreshness', () => {
  it('puts the line under the title of a role file', () => {
    // No approvals or queue on disk for this path.
    const out = withFreshness('# Designer Context — Acme\n*Last updated: 2026-10-01*\n\n## Your Role\n', '/nonexistent-teamctx-dir', { now: NOW });
    expect(out.split('\n').slice(0, 3)).toEqual([
      '# Designer Context — Acme',
      '*Context last approved: not recorded; nothing waiting*',
      '*Last updated: 2026-10-01*',
    ]);
  });
});
