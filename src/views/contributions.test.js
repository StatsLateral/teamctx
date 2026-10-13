import { describe, it, expect } from 'vitest';
import { groupContributions, contributionsPage } from './contributions.js';
import { isReturnable } from '../view-url.js';

const c = (id, at, author, text = 'x') => ({ id, at, author, text, where: 'Acme', status: 'logged', source: 'mcp' });
const list = [
  c('1', '2026-10-10T09:00:00Z', 'Maya'),
  c('2', '2026-10-12T08:00:00Z', 'Dev'),
  c('3', '2026-10-12T15:00:00Z', 'Maya'),
  c('4', '2026-10-11T12:00:00Z', 'Dev'),
];

describe('grouping contributions', () => {
  it('by date: days newest first, items newest first within each', () => {
    const g = groupContributions(list, 'date');
    expect(g.map(x => x.title)).toEqual(['2026-10-12', '2026-10-11', '2026-10-10']);
    expect(g[0].items.map(x => x.id)).toEqual(['3', '2']);
  });

  it('by contributor: whoever contributed last comes first', () => {
    const g = groupContributions(list, 'person');
    expect(g.map(x => x.title)).toEqual(['Maya', 'Dev']);
    expect(g[1].items.map(x => x.at)).toEqual(['2026-10-12T08:00:00Z', '2026-10-11T12:00:00Z']);
  });

  it('puts an undated one in a group of its own', () => {
    expect(groupContributions([c('9', null, 'Maya')], 'date')[0].title).toBe('Undated');
  });
});

describe('the contributions page', () => {
  const view = { project: 'Acme', owner: 'acme', repo: 'gtm', contributions: [c('1', '2026-10-12T08:00:00Z', 'Maya', '<b>hi</b>')] };

  it('escapes what people typed', () => {
    expect(contributionsPage({ user: { login: 'm' }, view })).not.toContain('<b>hi</b>');
  });

  it('marks which grouping is on', () => {
    expect(contributionsPage({ user: { login: 'm' }, view, by: 'person' })).toMatch(/group=person"\s+aria-current="true"/);
  });

  it('folds a long contribution behind its start', () => {
    const long = { ...view, contributions: [c('1', '2026-10-12T08:00:00Z', 'Maya', 'a'.repeat(500))] };
    expect(contributionsPage({ user: { login: 'm' }, view: long })).toContain('<details>');
  });
});

describe('returning to the page after sign-in', () => {
  it('allows the page and its two groupings only', () => {
    expect(isReturnable('/project/acme/gtm/contributions?group=person')).toBe(true);
    expect(isReturnable('/project/acme/gtm/contributions?group=evil')).toBe(false);
    expect(isReturnable('/project/acme/gtm/other')).toBe(false);
  });
});
