import { describe, it, expect } from 'vitest';
import { cleanExternal, addExternal, removeExternal, systemOf, ExternalLinkError, MAX_EXTERNAL_PER_TASK } from './external-links.js';

describe('systemOf', () => {
  it('names the tool from the address, and falls back to other', () => {
    expect(systemOf('https://app.asana.com/0/1/2')).toBe('asana');
    expect(systemOf('https://acme.atlassian.net/browse/PROJ-1')).toBe('jira');
    expect(systemOf('https://linear.app/acme/issue/A-1')).toBe('linear');
    expect(systemOf('https://tracker.example.com/1')).toBe('other');
    expect(systemOf('not a link')).toBe('other');
  });
});

describe('cleanExternal', () => {
  it('keeps the tool, the address and the ticket reference', () => {
    expect(cleanExternal({ url: 'https://app.asana.com/0/1/2', ref: '1200' })).toEqual({ system: 'asana', url: 'https://app.asana.com/0/1/2', ref: '1200' });
  });

  it('takes a tool that was named, lower-cased', () => {
    expect(cleanExternal({ system: 'Jira', url: 'https://tracker.example.com/1' }).system).toBe('jira');
  });

  it('refuses an address that is not https', () => {
    expect(() => cleanExternal({ url: 'http://app.asana.com/0/1/2' })).toThrow(ExternalLinkError);
    expect(() => cleanExternal({ url: 'javascript:alert(1)' })).toThrow(/https/);
    expect(() => cleanExternal({ url: '' })).toThrow(/https/);
  });

  it('refuses a tool or a reference that could carry anything else', () => {
    expect(() => cleanExternal({ system: 'as ana!', url: 'https://app.asana.com/0/1/2' })).toThrow(/lower-case word/);
    expect(() => cleanExternal({ url: 'https://app.asana.com/0/1/2', ref: 'x y <script>' })).toThrow(/id or key/);
  });

  it('drops a user, a password and a credential in the query', () => {
    expect(cleanExternal({ url: 'https://bob:pw@app.asana.com/0/1/2?token=abc&x=1' }).url).toBe('https://app.asana.com/0/1/2?x=1');
  });
});

describe('addExternal and removeExternal', () => {
  const link = (n) => ({ system: 'asana', url: `https://app.asana.com/0/1/${n}` });

  it('replaces the same address rather than repeating it', () => {
    const list = addExternal([link(1)], { ...link(1), ref: 'new' });
    expect(list).toEqual([{ ...link(1), ref: 'new' }]);
  });

  it('refuses a sixth', () => {
    let list = [];
    for (let n = 1; n <= MAX_EXTERNAL_PER_TASK; n++) list = addExternal(list, link(n));
    expect(() => addExternal(list, link(99))).toThrow(/at most 5/);
  });

  it('removes by address and tolerates a missing list', () => {
    expect(removeExternal([link(1), link(2)], link(1).url)).toEqual([link(2)]);
    expect(removeExternal(undefined, link(1).url)).toEqual([]);
  });
});
