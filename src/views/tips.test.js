import { describe, it, expect } from 'vitest';
import { tipsPage } from './tips.js';
import { buildTipsUrl, isReturnable } from '../view-url.js';

describe('the Tips & Tricks page', () => {
  const html = tipsPage({ user: { login: 'maya' }, project: 'acme/gtm', projectUrl: '/project/acme/gtm' });

  it('covers structure, people, agents and how context stays current', () => {
    for (const heading of ['How a project is built', 'Adding and removing people', 'Running agents alongside people', 'How the context stays current', 'Questions']) {
      expect(html).toContain(heading);
    }
  });

  it('leads back to the project it was linked from', () => {
    expect(html).toContain('href="/project/acme/gtm"');
  });

  it('has no way back when it was not linked from a project', () => {
    expect(tipsPage({ user: { login: 'maya' } })).not.toContain('Back to');
  });
});

describe('the Tips & Tricks link', () => {
  it('carries the project it came from', () => {
    expect(buildTipsUrl({ base: 'https://h.test', owner: 'acme', repo: 'gtm' })).toBe('https://h.test/tips?project=acme%2Fgtm');
  });

  it('refuses to be built with no deployment address', () => {
    expect(() => buildTipsUrl({ owner: 'a', repo: 'b' })).toThrow(/no deployment address/);
  });

  it('survives sign-in, and only with a well-formed project', () => {
    expect(isReturnable('/tips')).toBe(true);
    expect(isReturnable('/tips?project=acme/gtm')).toBe(true);
    expect(isReturnable('/tips?project=//evil.test')).toBe(false);
    expect(isReturnable('/tips?other=1')).toBe(false);
  });
});
