import { describe, it, expect } from 'vitest';
import {
  RECORD_TYPES, LABELS, validateRecord, isActive, isExpired,
  assertCurrentFormat, LegacyFormatError, workstreamTree, ancestorsOf,
  descendantsOf, numberWorkstreams, depthOf, emptyProject,
} from './model.js';
import { makeRecord, makeConfig } from './test-fixtures/model.js';

describe('record types and labels', () => {
  it('has exactly the four types the MVP governs, each with a plain label', () => {
    expect(RECORD_TYPES).toEqual(['decision', 'assumption', 'rule', 'exception']);
    for (const t of RECORD_TYPES) expect(LABELS[t]).toMatch(/:$/);
    expect(LABELS.exception).toBe('Allowed:');
  });
});

describe('validateRecord', () => {
  it('accepts a minimal decision', () => {
    expect(validateRecord(makeRecord({ type: 'decision' })).ok).toBe(true);
  });
  it('requires owner and reviewBy on an assumption', () => {
    const r = validateRecord(makeRecord({ type: 'assumption', owner: null, reviewBy: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/owner/);
    expect(r.errors.join(' ')).toMatch(/reviewBy/);
  });
  it('requires bends and expiresAt on an exception', () => {
    const r = validateRecord(makeRecord({ type: 'exception', links: { bends: null }, expiresAt: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/bends/);
    expect(r.errors.join(' ')).toMatch(/expiresAt/);
  });
  it('rejects an unknown or retired type and a malformed date', () => {
    expect(validateRecord(makeRecord({ type: 'fact' })).ok).toBe(false);
    for (const t of ['why', 'question', 'risk']) expect(validateRecord(makeRecord({ type: t })).ok).toBe(false);
    expect(validateRecord(makeRecord({ type: 'assumption', owner: { key: 'k', name: 'n' }, reviewBy: 'next week' })).ok).toBe(false);
  });
});

describe('activity', () => {
  it('an exception past expiresAt is expired and not active', () => {
    const r = makeRecord({ type: 'exception', expiresAt: '2026-01-01', links: { bends: 'rec-r' } });
    expect(isExpired(r, '2026-01-02')).toBe(true);
    expect(isActive(r, '2026-01-02')).toBe(false);
    expect(isActive(r, '2026-01-01')).toBe(true);
  });
  it('replaced, broken and closed records are not active', () => {
    for (const status of ['replaced', 'broken', 'closed']) {
      expect(isActive(makeRecord({ status }), '2026-01-01')).toBe(false);
    }
  });
});

describe('format', () => {
  it('rejects the old Why/What/How shape with the exact message', () => {
    expect(() => assertCurrentFormat({ name: 'x', whys: [] })).toThrow(LegacyFormatError);
    expect(() => assertCurrentFormat({ name: 'x', whys: [] })).toThrow(/Remove the .teamctx folder, then run `teamctx init`/);
  });
  it('accepts the new shape', () => {
    expect(assertCurrentFormat(emptyProject('p'))).toEqual(emptyProject('p'));
  });
});

describe('structure', () => {
  const config = makeConfig({ workstreams: [
    { id: 'sales', number: 1, name: 'Sales', parent: null, order: 1 },
    { id: 'outreach', number: 2, name: 'Outreach', parent: 'sales', order: 1 },
    { id: 'offer', number: 3, name: 'Offer', parent: 'sales', order: 2 },
    { id: 'expansion', number: 4, name: 'Expansion', parent: null, order: 2 },
  ] });
  it('builds roots in order with children', () => {
    const t = workstreamTree(config);
    expect(t.map(w => w.id)).toEqual(['sales', 'expansion']);
    expect(t[0].children.map(w => w.id)).toEqual(['outreach', 'offer']);
  });
  it('numbers workstreams flat, as stored: nesting is the indent, never the number', () => {
    const n = numberWorkstreams(config);
    expect(n.get('sales')).toBe('1');
    expect(n.get('offer')).toBe('3');
    expect(n.get('expansion')).toBe('4');
    expect(depthOf(config, 'sales')).toBe(0);
    expect(depthOf(config, 'offer')).toBe(1);
  });
  it('does not make up a number for a workstream that was never given one', () => {
    const n = numberWorkstreams(makeConfig({ workstreams: [{ id: 'old', name: 'Old', order: 1 }] }));
    expect(n.has('old')).toBe(false);
  });
  it('walks ancestors and descendants', () => {
    expect(ancestorsOf(config, 'offer')).toEqual(['sales']);
    expect(descendantsOf(config, 'sales').sort()).toEqual(['offer', 'outreach']);
    expect(descendantsOf(config, 'expansion')).toEqual([]);
  });
  it('treats an unknown or self parent as a root instead of looping', () => {
    const bad = makeConfig({ workstreams: [
      { id: 'a', name: 'A', parent: 'a', order: 1 },
      { id: 'b', name: 'B', parent: 'ghost', order: 2 },
    ] });
    expect(workstreamTree(bad).map(w => w.id)).toEqual(['a', 'b']);
    expect(ancestorsOf(bad, 'a')).toEqual([]);
  });
});
