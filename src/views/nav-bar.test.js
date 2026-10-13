import { describe, it, expect } from 'vitest';
import { navBar } from './theme.js';

describe('the nav bar', () => {
  it('offers Tips & Tricks to somebody signed in, and marks it when they are on it', () => {
    const bar = navBar({ user: { login: 'maya' }, current: '/tips' });
    expect(bar).toContain('<a href="/tips" class="on" aria-current="page">Tips &amp; Tricks</a>');
  });

  it('does not offer it to somebody signed out, who would only be sent to sign in', () => {
    expect(navBar({ user: null, current: '/' })).not.toContain('/tips');
  });
});
