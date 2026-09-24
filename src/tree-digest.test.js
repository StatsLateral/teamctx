import { describe, it, expect } from 'vitest';
import { digestTree } from './tree-digest.js';

const tree = (whys) => ({ id: null, name: 'Ledger', whys });

describe('what a project\'s context now holds', () => {
  it('reads back as goals, with what each requires and how', () => {
    const d = digestTree(tree([
      { id: 'w1', text: 'Ship the ledger by March', whats: [
        { id: 'a1', text: 'Reconcile daily', hows: [{ id: 'h1', text: 'Import the bank feed' }] },
      ] },
    ]));
    expect(d.whys).toEqual([
      { text: 'Ship the ledger by March', whats: [{ text: 'Reconcile daily', hows: ['Import the bank feed'] }] },
    ]);
    expect(d.totals).toEqual({ whys: 1, whats: 1, hows: 1 });
    expect(d.more).toBe(false);
  });

  it('counts everything, including what it leaves out', () => {
    const d = digestTree(tree(Array.from({ length: 12 }, (_, i) => ({ text: `Goal ${i}`, whats: [{ text: 'a', hows: [] }] }))));
    expect(d.whys).toHaveLength(8);
    expect(d.totals.whys).toBe(12);
    expect(d.totals.whats).toBe(12);
    expect(d.more).toBe(true);
  });

  it('says there is more when a goal\'s own detail is trimmed', () => {
    const d = digestTree(tree([{ text: 'Goal', whats: Array.from({ length: 6 }, () => ({ text: 'need', hows: [] })) }]));
    expect(d.whys[0].whats).toHaveLength(4);
    expect(d.more).toBe(true);
  });

  it('shortens anything long enough to be a paragraph', () => {
    const d = digestTree(tree([{ text: `${'x'.repeat(400)} end`, whats: [] }]));
    expect(d.whys[0].text).toHaveLength(160);
    expect(d.whys[0].text.endsWith('…')).toBe(true);
  });

  it('flattens the whitespace a pasted conversation brings with it', () => {
    const d = digestTree(tree([{ text: '  Ship\n\n  the ledger  ', whats: [] }]));
    expect(d.whys[0].text).toBe('Ship the ledger');
  });

  it('answers for an empty tree, and for no tree at all', () => {
    expect(digestTree(tree([]))).toEqual({ whys: [], totals: { whys: 0, whats: 0, hows: 0 }, more: false });
    expect(digestTree(null).totals.whys).toBe(0);
  });
});
