import { describe, expect, it } from 'vitest';
import { applyOps } from './ops.js';

const baseWs = {
  id: 'ws1',
  name: 'Test',
  whys: [
    {
      id: 'why1',
      text: 'ship by Q3',
      sourceContributionIds: ['c0'],
      summary: 'initial',
      whats: [
        {
          id: 'what1',
          text: 'build onboarding',
          sourceContributionIds: ['c0'],
          summary: 'from c0',
          hows: [
            { id: 'how1', text: 'wire sign-up form', sourceContributionIds: ['c0'], summary: 'from c0' },
          ],
        },
      ],
    },
  ],
};

const newCid = 'c1';

describe('applyOps', () => {
  it('addWhy appends a new top-level Why', () => {
    const ops = [{ type: 'addWhy', text: 'reduce churn', summary: 'added' }];
    const next = applyOps(baseWs, ops, newCid);
    expect(next.whys).toHaveLength(2);
    expect(next.whys[1].text).toBe('reduce churn');
    expect(next.whys[1].whats).toEqual([]);
    expect(next.whys[1].sourceContributionIds).toEqual([newCid]);
  });

  it('addWhy with nested whats and hows creates the full subtree', () => {
    const ops = [{
      type: 'addWhy', text: 'expand internationally', summary: 'new goal',
      whats: [{ text: 'localize UI', summary: 'child', hows: [{ text: 'extract strings', summary: 'grandchild' }] }],
    }];
    const next = applyOps(baseWs, ops, newCid);
    expect(next.whys[1].whats[0].text).toBe('localize UI');
    expect(next.whys[1].whats[0].hows[0].text).toBe('extract strings');
  });

  it('addWhat nests under the right Why', () => {
    const ops = [{ type: 'addWhat', parentWhyId: 'why1', text: 'build dashboard', summary: 'added' }];
    const next = applyOps(baseWs, ops, newCid);
    expect(next.whys[0].whats).toHaveLength(2);
    expect(next.whys[0].whats[1].text).toBe('build dashboard');
  });

  it('addWhat with unknown parentWhyId silently no-ops', () => {
    const next = applyOps(baseWs, [{ type: 'addWhat', parentWhyId: 'ghost', text: 'x', summary: '' }], newCid);
    expect(next.whys[0].whats).toHaveLength(1);
  });

  it('addHow nests under the right What', () => {
    const ops = [{ type: 'addHow', parentWhatId: 'what1', text: 'write tests', summary: 'added' }];
    const next = applyOps(baseWs, ops, newCid);
    expect(next.whys[0].whats[0].hows).toHaveLength(2);
    expect(next.whys[0].whats[0].hows[1].text).toBe('write tests');
  });

  it('addHow with unknown parentWhatId silently no-ops', () => {
    const next = applyOps(baseWs, [{ type: 'addHow', parentWhatId: 'ghost', text: 'x', summary: '' }], newCid);
    expect(next.whys[0].whats[0].hows).toHaveLength(1);
  });

  it('editStatement updates text, summary, and appends contributionId', () => {
    const ops = [{ type: 'editStatement', id: 'why1', text: 'ship by end of Q3', summary: 'tighter' }];
    const next = applyOps(baseWs, ops, newCid);
    expect(next.whys[0].text).toBe('ship by end of Q3');
    expect(next.whys[0].sourceContributionIds).toEqual(['c0', newCid]);
  });

  it('editStatement updates a deeply nested How', () => {
    const ops = [{ type: 'editStatement', id: 'how1', text: 'wire and validate sign-up form', summary: 'updated' }];
    const next = applyOps(baseWs, ops, newCid);
    expect(next.whys[0].whats[0].hows[0].text).toBe('wire and validate sign-up form');
  });

  it('editStatement with unknown id silently no-ops', () => {
    const next = applyOps(baseWs, [{ type: 'editStatement', id: 'ghost', text: 'x', summary: 'y' }], newCid);
    expect(next).toEqual(baseWs);
  });

  it('deleteStatement removes a How', () => {
    const next = applyOps(baseWs, [{ type: 'deleteStatement', id: 'how1', summary: 'obsolete' }], newCid);
    expect(next.whys[0].whats[0].hows).toEqual([]);
  });

  it('deleteStatement on a What removes What and children', () => {
    const next = applyOps(baseWs, [{ type: 'deleteStatement', id: 'what1', summary: 'obsolete' }], newCid);
    expect(next.whys[0].whats).toEqual([]);
  });

  it('deleteStatement on a Why removes Why and descendants', () => {
    const next = applyOps(baseWs, [{ type: 'deleteStatement', id: 'why1', summary: 'obsolete' }], newCid);
    expect(next.whys).toEqual([]);
  });

  it('applies ops in order: adds first, then edits, then deletes', () => {
    const ops = [
      { type: 'deleteStatement', id: 'what1', summary: 'del' },
      { type: 'editStatement', id: 'what1', text: 'improved onboarding', summary: 'edited' },
      { type: 'addWhat', parentWhyId: 'why1', text: 'build dashboard', summary: 'added' },
    ];
    const next = applyOps(baseWs, ops, newCid);
    expect(next.whys[0].whats).toHaveLength(1);
    expect(next.whys[0].whats[0].text).toBe('build dashboard');
  });

  it('returns a fresh tree with no shared references', () => {
    const ops = [{ type: 'addWhy', text: 'x', summary: 'y' }];
    const next = applyOps(baseWs, ops, newCid);
    expect(next).not.toBe(baseWs);
    expect(next.whys).not.toBe(baseWs.whys);
  });
});
