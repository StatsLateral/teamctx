import { describe, it, expect } from 'vitest';
import {
  memberWorkstreams, scopeFor, inScope, assertInScope,
  visibleWorkstreams, defaultWorkstream, WorkstreamOutOfScopeError,
} from './member-scope.js';

const ENG = { key: 'git:eng@example.com', email: 'eng@example.com', login: null, workstreams: ['engineering'] };
const WIDE = { key: 'git:wide@example.com', email: 'wide@example.com', login: null };
const project = (members = []) => ({ project: 'p', managerKey: 'git:ada@example.com', members });

describe('reading a scope off a roster entry', () => {
  it('returns the list when there is one', () => {
    expect(memberWorkstreams(ENG)).toEqual(['engineering']);
  });

  it('treats no list as project-wide', () => {
    expect(memberWorkstreams(WIDE)).toBe(null);
    expect(memberWorkstreams(null)).toBe(null);
  });

  it('treats an empty or unreadable list as project-wide, not as nothing', () => {
    // The important direction. A scope that cannot be read must degrade to the
    // behaviour that existed before scopes, never to a member who sees nothing
    // and cannot tell why.
    expect(memberWorkstreams({ workstreams: [] })).toBe(null);
    expect(memberWorkstreams({ workstreams: ['', '  '] })).toBe(null);
    expect(memberWorkstreams({ workstreams: 'engineering' })).toBe(null);
    expect(memberWorkstreams({ workstreams: null })).toBe(null);
  });

  it('drops duplicates and trims', () => {
    expect(memberWorkstreams({ workstreams: [' eng ', 'eng', 'ops'] })).toEqual(['eng', 'ops']);
  });
});

describe('finding the caller on the roster', () => {
  it('matches on the actor key', () => {
    expect(scopeFor(project([ENG]), { key: 'git:eng@example.com' })).toEqual(['engineering']);
  });

  it('matches on a verified email when the key differs', () => {
    // A Google sign-in and a clone are different keys for the same person.
    expect(scopeFor(project([ENG]), { key: 'github:99', email: 'eng@example.com' })).toEqual(['engineering']);
  });

  it('matches a roster email against a git: key', () => {
    expect(scopeFor(project([ENG]), { key: 'git:eng@example.com', email: null })).toEqual(['engineering']);
  });

  it('matches on login', () => {
    const byLogin = { key: 'github:7', login: 'ravi', workstreams: ['ops'] };
    expect(scopeFor(project([byLogin]), { key: 'github:999', login: 'Ravi' })).toEqual(['ops']);
  });

  it('is project-wide for somebody not on the roster', () => {
    // Not a lockout: the roster is not an allowlist, and never has been.
    // Whether a stranger reaches the project at all is decided before this.
    expect(scopeFor(project([ENG]), { key: 'git:nobody@example.com' })).toBe(null);
  });

  it('is project-wide when there is no roster', () => {
    expect(scopeFor(project(), { key: 'git:eng@example.com' })).toBe(null);
    expect(scopeFor({}, { key: 'git:eng@example.com' })).toBe(null);
  });

  it('never scopes the manager', () => {
    // A manager who could not read half the project could not review
    // contributions to that half, which is the one thing only they can do.
    const scoped = { ...ENG, key: 'git:ada@example.com', email: 'ada@example.com' };
    expect(scopeFor(project([scoped]), { key: 'git:ada@example.com' }, { isManager: true })).toBe(null);
  });
});

describe('deciding what a scope admits', () => {
  it('admits everything when there is no scope', () => {
    expect(inScope(null, 'anything')).toBe(true);
    expect(visibleWorkstreams(null, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('admits only what is listed', () => {
    expect(inScope(['eng'], 'eng')).toBe(true);
    expect(inScope(['eng'], 'product')).toBe(false);
  });

  it('filters a listing without reordering it', () => {
    expect(visibleWorkstreams(['b'], ['a', 'b', 'c'])).toEqual(['b']);
    expect(visibleWorkstreams(['c', 'a'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('survives a missing list', () => {
    expect(visibleWorkstreams(['a'], undefined)).toEqual([]);
  });
});

describe('refusing a workstream outside the scope', () => {
  it('refuses the way an unknown workstream is refused', () => {
    // Same wording on purpose: "you may not read X" teaches the member that X
    // exists and what it is called, which is what the scope was hiding.
    const err = new WorkstreamOutOfScopeError('product', ['eng']);
    expect(err.message).toBe('no workstream "product" on this project');
    expect(err.code).toBe('WORKSTREAM_OUT_OF_SCOPE');
  });

  it('throws for one outside and passes one inside', () => {
    expect(() => assertInScope(['eng'], 'product')).toThrow(/no workstream "product"/);
    expect(assertInScope(['eng'], 'eng')).toBe('eng');
  });

  it('lets everything through with no scope', () => {
    expect(assertInScope(null, 'product')).toBe('product');
  });
});

describe('where a scoped member lands by default', () => {
  it('keeps their preference when it is inside the scope', () => {
    expect(defaultWorkstream(['eng', 'ops'], 'ops')).toBe('ops');
  });

  it('falls back to the first they can reach, not the project default', () => {
    // Scopes change and stored preferences do not, so a member can be left
    // pointing at a workstream they are no longer on.
    expect(defaultWorkstream(['eng'], 'main')).toBe('eng');
  });

  it('leaves an unscoped caller alone', () => {
    expect(defaultWorkstream(null, 'main')).toBe('main');
  });
});
