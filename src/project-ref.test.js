import { describe, it, expect } from 'vitest';
import { parseProjectRef } from './project-ref.js';

describe('the repository somebody means', () => {
  it('takes the name as typed', () => {
    expect(parseProjectRef('acme/ledger')).toEqual({ owner: 'acme', repo: 'ledger' });
  });

  it('forgives the whitespace and the angle brackets a paste brings with it', () => {
    expect(parseProjectRef('  acme/ledger  ')).toEqual({ owner: 'acme', repo: 'ledger' });
    expect(parseProjectRef('<https://github.com/acme/ledger>')).toEqual({ owner: 'acme', repo: 'ledger' });
  });

  it('keeps the case it was given, because GitHub does not care and people do', () => {
    expect(parseProjectRef('Acme/Ledger')).toEqual({ owner: 'Acme', repo: 'Ledger' });
  });

  it('reads the connector URL a manager hands out', () => {
    // The thing most people actually have: it is what they were sent.
    expect(parseProjectRef('https://ctx.example.com/api/mcp/acme/ledger'))
      .toEqual({ owner: 'acme', repo: 'ledger' });
  });

  it('reads a link to a page in the project, query and all', () => {
    expect(parseProjectRef('https://ctx.example.com/project/acme/ledger?ws=product&item=w1'))
      .toEqual({ owner: 'acme', repo: 'ledger' });
  });

  it('reads the repository on GitHub, however deep the link goes', () => {
    for (const url of [
      'https://github.com/acme/ledger',
      'https://github.com/acme/ledger/',
      'https://github.com/acme/ledger.git',
      'https://github.com/acme/ledger/tree/main/docs',
      'https://www.github.com/acme/ledger',
      'git@github.com:acme/ledger.git',
      'github.com/acme/ledger',
    ]) expect(parseProjectRef(url), url).toEqual({ owner: 'acme', repo: 'ledger' });
  });

  it('will not take the last two segments of a URL on faith', () => {
    // A link that names no repository anywhere this recognises is a link to
    // something else. Guessing turns a wrong paste into a confident 404 for a
    // repository nobody meant.
    expect(parseProjectRef('https://example.com/acme/ledger')).toBeNull();
    expect(parseProjectRef('https://ctx.example.com/settings')).toBeNull();
  });

  it('refuses what is not a reference at all', () => {
    for (const bad of ['', '   ', null, undefined, 'acme', 'acme/ledger/extra',
      'https://x.example.com/api/mcp/acme', 'not a url at all']) {
      expect(parseProjectRef(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses names GitHub itself could not have', () => {
    // A typo stops here rather than becoming a request for an impossible repo.
    expect(parseProjectRef('-acme/ledger')).toBeNull();
    expect(parseProjectRef('ac me/ledger')).toBeNull();
    expect(parseProjectRef('acme/..')).toBeNull();
    expect(parseProjectRef('acme/led ger')).toBeNull();
    expect(parseProjectRef(`${'a'.repeat(40)}/ledger`)).toBeNull();
  });
});
