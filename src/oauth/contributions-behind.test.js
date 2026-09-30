/**
 * Which contributions travel with a tree.
 *
 * The page needs two things about each statement: who wrote it, for the drawer,
 * and what kind of source it came from, for the dot. It does not need the text
 * somebody submitted, and it must not carry the contributions behind a tree the
 * reader is not on — sending them and not drawing them is not scoping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ contributions: [] }));
vi.mock('../storage.js', async (orig) => ({
  ...(await orig()),
  readContributions: () => store.contributions,
}));

const { contributionsBehind } = await import('./project-view.js');

const why = (id, ids) => ({ id, text: id, sourceContributionIds: ids, whats: [] });

beforeEach(() => {
  store.contributions = [
    { id: 'c1', author: 'Priya', source: 'mcp', text: 'the whole submission' },
    { id: 'c2', author: 'Dev', source: 'cli', text: 'another one' },
    { id: 'c3', author: 'Nobody', source: 'cli', text: 'referenced by nothing' },
  ];
});

describe('the contributions behind a set of trees', () => {
  it('takes the ones its statements point at, and no others', () => {
    const out = contributionsBehind([{ whys: [why('a', ['c1'])] }]);
    expect(Object.keys(out)).toEqual(['c1']);
  });

  it('leaves behind the ones belonging to a tree it was not given', () => {
    // The out-of-scope tree is not passed in, so nothing of it comes back.
    const out = contributionsBehind([{ whys: [why('a', ['c1'])] }]);
    expect(JSON.stringify(out)).not.toContain('Dev');
    expect(JSON.stringify(out)).not.toContain('Nobody');
  });

  it('carries only the name and the kind, not what was written', () => {
    const out = contributionsBehind([{ whys: [why('a', ['c1'])] }]);
    expect(out.c1).toEqual({ id: 'c1', author: 'Priya', source: 'mcp' });
    expect(JSON.stringify(out)).not.toContain('the whole submission');
  });

  it('reaches every tier, not only the top one', () => {
    const tree = {
      whys: [{
        id: 'w', text: 'w', sourceContributionIds: ['c1'],
        whats: [{ id: 'a', text: 'a', sourceContributionIds: ['c2'], hows: [{ id: 'h', text: 'h', sourceContributionIds: ['c3'] }] }],
      }],
    };
    expect(Object.keys(contributionsBehind([tree])).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('asks for nothing when no statement points anywhere', () => {
    expect(contributionsBehind([{ whys: [{ id: 'a', text: 'a', whats: [] }] }])).toEqual({});
  });
});
