import { describe, it, expect } from 'vitest';
import { makeConfig } from './test-fixtures/model.js';
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

  it('matches a key the caller has proved is theirs', () => {
    // The gate in front of the page admits somebody on a key they have proved
    // they own — a Google sign-in whose address GitHub verified for that
    // account. If this did not look at the same keys, the gate would let them in
    // and this would not find them, and a member nobody can find is a member
    // with no scope at all: every workstream, which is the opposite of the point.
    const byId = { key: 'github:7', workstreams: ['ops'] };
    expect(scopeFor(project([byId]), {
      key: 'git:ravi@example.com', email: 'ravi@example.com', keys: ['github:7'],
    })).toEqual(['ops']);
  });

  it('does not match a key somebody else has proved', () => {
    const byId = { key: 'github:7', workstreams: ['ops'] };
    expect(scopeFor(project([byId]), {
      key: 'git:stranger@example.com', email: 'stranger@example.com', keys: ['github:8'],
    })).toBe(null);
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

describe('the project itself against a scope', () => {
  // A scope narrows which workstreams a member reaches. The project tree is
  // not one of them — it is the base their own workstream inherits, so a
  // member refused it would be reading half their own context.
  it('admits project level for a scoped member', () => {
    expect(inScope(['eng'], null)).toBe(true);
  });


  it('does not refuse it', () => {
    expect(() => assertInScope(['eng'], null)).not.toThrow();
  });

  it('still refuses a workstream that is genuinely outside', () => {
    expect(() => assertInScope(['eng'], 'finance')).toThrow(/no workstream "finance"/);
  });

  it('does not make it the place a scoped member lands', () => {
    // Readable is not the same as where their work should go by default.
    expect(defaultWorkstream(['eng'], null)).toBe('eng');
  });
});

/**
 * The creator's own roster entry does not scope them.
 *
 * `init` now puts the person who made the project on `members`, so that
 * `list_members` does not show an empty project to the one person who had
 * certainly joined it. That entry carries `workstreams: []`, and an entry with
 * no workstreams on it has to keep meaning project-wide — otherwise the change
 * that was meant to make a manager visible would be the change that locked them
 * out of their own project.
 */
describe('a manager who is now on their own roster', () => {
  const creator = { key: 'github:7', name: 'Maya', login: 'maya', workstreams: [] };

  it('reads as project-wide, not as no workstreams at all', () => {
    expect(memberWorkstreams(creator)).toBe(null);
  });

  it('keeps the whole project in scope even when read as an ordinary member', () => {
    // Belt and braces: `scopeFor` short-circuits on `isManager`, so this is the
    // answer if that shortcut ever stops being taken.
    const config = { members: [creator] };
    expect(scopeFor(config, { key: 'github:7' })).toBe(null);
  });

  it('is in scope for every workstream, the same as before the entry existed', () => {
    const config = { members: [creator] };
    const scope = scopeFor(config, { key: 'github:7' });
    expect(inScope(scope, 'billing')).toBe(true);
    expect(inScope(scope, 'anything-at-all')).toBe(true);
  });

  it('answers the same on a project from before, which has no entry for them', () => {
    // No migration: an older project simply has nobody matching, and a caller
    // with no roster entry has always meant project-wide.
    expect(scopeFor({ members: [] }, { key: 'github:7' })).toBe(null);
  });

  it('still scopes a member who does have workstreams listed', () => {
    // So the test above is not passing because scoping stopped working.
    const config = { members: [creator, { key: 'github:9', workstreams: ['billing'] }] };
    expect(scopeFor(config, { key: 'github:9' })).toEqual(['billing']);
    expect(inScope(scopeFor(config, { key: 'github:9' }), 'shipping')).toBe(false);
  });
});


describe('nested scope', () => {
  const config = makeConfig({
    workstreams: [
      { id: 'sales', name: 'Sales', parent: null, order: 1 },
      { id: 'outreach', name: 'Outreach', parent: 'sales', order: 1 },
      { id: 'expansion', name: 'Expansion', parent: null, order: 2 },
      { id: 'renewals', name: 'Renewals', parent: 'expansion', order: 1 },
    ],
    members: [{ key: 'git:m@x', email: 'm@x', name: 'M', workstreams: ['sales'] }],
  });
  const actor = { key: 'git:m@x', email: 'm@x' };

  it('reaches every workstream below the one they are on', () => {
    expect(inScope(scopeFor(config, actor), 'outreach')).toBe(true);
  });
  it('never reaches a sibling or its children', () => {
    const scope = scopeFor(config, actor);
    expect(inScope(scope, 'expansion')).toBe(false);
    expect(inScope(scope, 'renewals')).toBe(false);
  });
  it('a manager is unscoped', () => {
    expect(scopeFor(config, actor, { isManager: true })).toBeNull();
  });
});
