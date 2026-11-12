import { describe, it, expect } from 'vitest';
import { recordTrail } from './record-history.js';

const contribs = {
  'c-1': { author: 'Ada', ts: '2026-01-01T00:00:00Z' },
  'c-2': { author: 'Bea', ts: '2026-02-01T00:00:00Z' },
  'c-3': { author: 'Cy', ts: '2026-03-01T00:00:00Z' },
};

describe('recordTrail (#265)', () => {
  it('reads a record that was never edited as a single current version', () => {
    const record = { id: 'r1', type: 'decision', status: 'active', text: 'Only', detail: '', links: {}, createdBy: 'c-1', createdAt: '2026-01-01' };
    const t = recordTrail({ record, contributions: contribs });
    expect(t.versions).toHaveLength(1);
    expect(t.versions[0]).toMatchObject({ text: 'Only', by: 'Ada', current: true });
    expect(t.replaces).toBeNull();
    expect(t.replacedBy).toBeNull();
  });

  it('lists versions oldest to newest with the author of each', () => {
    const record = {
      id: 'r1', type: 'decision', status: 'active', text: 'Third', detail: '', links: {},
      createdBy: 'c-1', createdAt: '2026-01-01', updatedAt: '2026-03-01',
      history: [
        { text: 'First', detail: '', at: '2026-01-01', byContribution: 'c-2' },
        { text: 'Second', detail: '', at: '2026-02-01', byContribution: 'c-3' },
      ],
    };
    const t = recordTrail({ record, contributions: contribs });
    expect(t.versions.map(v => v.text)).toEqual(['First', 'Second', 'Third']);
    // v0 by its creator, v1 by the edit that produced it, current by the last edit.
    expect(t.versions.map(v => v.by)).toEqual(['Ada', 'Bea', 'Cy']);
    expect(t.versions[2].current).toBe(true);
  });

  it('dates each version from the transition into it, not the record updatedAt (#265)', () => {
    const record = {
      id: 'r1', type: 'decision', status: 'active', text: 'Third', detail: '', links: {},
      createdBy: 'c-1', createdAt: '2026-01-01', updatedAt: '2026-09-09', // bumped by an unrelated metadata edit
      history: [
        { text: 'First', detail: '', at: '2026-02-02', byContribution: 'c-2' },
        { text: 'Second', detail: '', at: '2026-03-03', byContribution: 'c-3' },
      ],
    };
    const t = recordTrail({ record, contributions: contribs });
    // v0 written at creation; each later version at the edit that produced it;
    // the current one at the last edit — never the unrelated updatedAt bump.
    expect(t.versions.map(v => v.at)).toEqual(['2026-01-01', '2026-02-02', '2026-03-03']);
  });

  it('names the record it replaced and the one that replaced it', () => {
    const records = [
      { id: 'old', type: 'decision', status: 'replaced', text: 'Old text' },
      { id: 'new', type: 'decision', status: 'active', text: 'New text' },
    ];
    const record = { id: 'mid', type: 'decision', status: 'replaced', text: 'Mid', links: { replaces: 'old' }, replacedBy: 'new', createdBy: 'c-2' };
    const t = recordTrail({ record, records, contributions: contribs });
    expect(t.replaces).toMatchObject({ id: 'old', text: 'Old text', status: 'replaced' });
    expect(t.replacedBy).toMatchObject({ id: 'new', text: 'New text', status: 'active' });
  });

  it('hides a name the reader may not see, rather than guessing', () => {
    const record = { id: 'r1', type: 'decision', status: 'active', text: 'X', links: {}, createdBy: 'c-1', createdAt: '2026-01-01' };
    const t = recordTrail({ record, contributions: contribs, canSee: (n) => n !== 'Ada' });
    expect(t.versions[0].by).toBeNull();
    expect(t.created.by).toBeNull();
  });

  it('surfaces the approval when there is one', () => {
    const record = { id: 'r1', type: 'decision', status: 'active', text: 'X', links: {}, createdBy: 'c-1', createdAt: '2026-01-01', approvedBy: { name: 'Mo' } };
    const t = recordTrail({ record, contributions: contribs, approvals: { 'c-1': { approvedBy: { name: 'Mo' }, approvedAt: '2026-01-02' } } });
    expect(t.approved).toMatchObject({ by: 'Mo', at: '2026-01-02' });
  });

  it('returns null for a missing record', () => {
    expect(recordTrail({ record: null })).toBeNull();
  });
});
