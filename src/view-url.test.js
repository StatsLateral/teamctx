/**
 * Links from a chat back to the page.
 *
 * Two things are worth being strict about: what a link may point at, and what
 * the sign-in flow may be talked into sending somebody back to. The first keeps
 * links from rotting; the second is the one place a value off a query string
 * decides a redirect.
 */
import { describe, it, expect } from 'vitest';
import { buildViewUrl, parseViewParams, isReturnable, isViewId, ViewUrlError } from './view-url.js';

const BASE = 'https://team.example.app';

describe('building a link', () => {
  it('points at the project when there is nothing more to say', () => {
    expect(buildViewUrl({ base: BASE, owner: 'acme', repo: 'ledger' }))
      .toBe('https://team.example.app/project/acme/ledger');
  });

  it('names the part of the work, the item, the task or the review', () => {
    expect(buildViewUrl({ base: BASE, owner: 'acme', repo: 'ledger', ws: 'product', item: 'w1' }))
      .toBe('https://team.example.app/project/acme/ledger?ws=product&item=w1');
    expect(buildViewUrl({ base: BASE, owner: 'acme', repo: 'ledger', task: 'pricing-page' }))
      .toContain('task=pricing-page');
    expect(buildViewUrl({ base: BASE, owner: 'acme', repo: 'ledger', review: 'c-9' }))
      .toContain('review=c-9');
  });

  it('leaves out the workstream for project level, which has no id', () => {
    // `null` is the project itself everywhere in teamctx, and it is not a name.
    expect(buildViewUrl({ base: BASE, owner: 'acme', repo: 'ledger', ws: null }))
      .not.toContain('ws=');
  });

  it('keeps the link when an id is not usable, rather than dropping both', () => {
    // A link to the part of the work is still worth having.
    const url = buildViewUrl({ base: BASE, owner: 'acme', repo: 'ledger', ws: 'product', item: 'not a valid id!' });
    expect(url).toContain('ws=product');
    expect(url).not.toContain('item=');
  });

  it('survives a base with a trailing slash, or a path under it', () => {
    expect(buildViewUrl({ base: 'https://team.example.app/', owner: 'a', repo: 'b' }))
      .toBe('https://team.example.app/project/a/b');
  });

  it('refuses to invent a link for a project with no deployment', () => {
    expect(() => buildViewUrl({ base: '', owner: 'a', repo: 'b' })).toThrow(ViewUrlError);
  });

  it('refuses an owner or repo it would have to escape', () => {
    expect(() => buildViewUrl({ base: BASE, owner: '../..', repo: 'b' })).toThrow(ViewUrlError);
  });
});

describe('reading one back', () => {
  it('round-trips what it wrote', () => {
    const url = new URL(buildViewUrl({ base: BASE, owner: 'a', repo: 'b', ws: 'product', item: 'w1' }));
    expect(parseViewParams(Object.fromEntries(url.searchParams))).toEqual({ ws: 'product', item: 'w1' });
  });

  it('drops anything it would not have written', () => {
    expect(parseViewParams({ ws: 'product', nonsense: 'x', item: '<script>' }))
      .toEqual({ ws: 'product' });
  });

  it('takes the first of a repeated parameter rather than an array', () => {
    expect(parseViewParams({ ws: ['product', 'tech'] })).toEqual({ ws: 'product' });
  });

  it('knows an id from something wearing one', () => {
    expect(isViewId('go-to-market')).toBe(true);
    expect(isViewId('c-1790689235875-85j3p')).toBe(true);
    expect(isViewId('')).toBe(false);
    expect(isViewId('../secret')).toBe(false);
    expect(isViewId('a b')).toBe(false);
    expect(isViewId('x'.repeat(200))).toBe(false);
  });
});

describe('what sign-in may send somebody back to', () => {
  it('takes the pages a link can name', () => {
    for (const path of ['/settings', '/settings/new-project', '/projects',
                        '/project/acme/ledger',
                        '/project/acme/ledger?ws=product',
                        '/project/acme/ledger?ws=product&item=w1',
                        '/project/acme/ledger?task=pricing-page',
                        '/project/acme/ledger?review=c-9',
                        '/project/acme/ledger?ws=product&view=list']) {
      expect(isReturnable(path), path).toBe(true);
    }
  });

  it('refuses anywhere that is not this site', () => {
    for (const path of ['https://evil.example/steal', '//evil.example', '/\\evil.example',
                        'javascript:alert(1)', '', '/project/acme/ledger#frag']) {
      expect(isReturnable(path), path).toBe(false);
    }
  });

  it('refuses a parameter it does not know, or a value it would not have written', () => {
    for (const path of ['/project/acme/ledger?next=/evil',
                        '/project/acme/ledger?ws=../../etc',
                        '/project/acme/ledger?item=<script>',
                        '/project/acme/ledger?view=everything']) {
      expect(isReturnable(path), path).toBe(false);
    }
  });

  it('refuses a page that is not one of ours', () => {
    expect(isReturnable('/api/project/acme/ledger')).toBe(false);
    expect(isReturnable('/project/acme')).toBe(false);
  });
});
