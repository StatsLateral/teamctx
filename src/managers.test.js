/**
 * The rules for changing who manages a project.
 *
 * One primary manager, whose project key the project runs on, and co-managers
 * who approve exactly as the primary does.
 */
import { describe, it, expect } from 'vitest';
import {
  managerKeyFor, emailOfKey, managersOf, withManagers,
  planAdd, planRemove, planTransfer, ManagerChangeError,
} from './managers.js';
import { canApprove } from './review.js';

const PRIMARY = { key: 'git:maya@example.com', email: 'maya@example.com', name: 'Maya' };
const project = (over = {}) => ({ project: 'Ledger', managerKey: 'git:maya@example.com', ...over });

describe('how a manager is written', () => {
  it('is always an email, as git:<email>', () => {
    expect(managerKeyFor('Priya@Example.com')).toBe('git:priya@example.com');
  });

  it('accepts one already written as git:', () => {
    expect(managerKeyFor('git:priya@example.com')).toBe('git:priya@example.com');
  });

  it('refuses a username, since a clone has no login to compare', () => {
    expect(() => managerKeyFor('priyar')).toThrow(/not an email address/);
  });

  it('refuses a GitHub id, since a Google sign-in has none', () => {
    expect(() => managerKeyFor('github:12345')).toThrow(ManagerChangeError);
  });

  it('is recognised from a clone, GitHub and Google alike', () => {
    const config = { managerKey: managerKeyFor('priya@example.com') };
    const clone = { key: 'git:priya@example.com' };
    const github = { key: 'github:99', login: 'priyar', email: 'priya@example.com' };
    const google = { key: 'git:priya@example.com', email: 'priya@example.com', source: 'google' };
    [clone, github, google].forEach(actor => expect(canApprove(config, { actor })).toBe(true));
  });

  it('reads the address back out of a key', () => {
    expect(emailOfKey('git:a@b.com')).toBe('a@b.com');
    expect(emailOfKey('github:1')).toBe(null);
  });
});

describe('primary and co-managers', () => {
  it('treats an existing single managerKey as the primary, with no co-managers', () => {
    expect(managersOf(project())).toEqual({ primary: 'git:maya@example.com', coManagers: [] });
  });

  it('never stores the primary twice', () => {
    const next = withManagers({}, { primary: 'git:a@b.com', coManagers: ['git:a@b.com', 'git:c@d.com'] });
    expect(next).toEqual({ managerKey: 'git:a@b.com', managerKeys: ['git:c@d.com'] });
  });
});

describe('adding a co-manager', () => {
  it('puts them on the gate beside the primary', () => {
    const { next } = planAdd(project(), 'priya@example.com');
    expect(managersOf(next)).toEqual({ primary: 'git:maya@example.com', coManagers: ['git:priya@example.com'] });
  });

  it('lets the new co-manager approve', () => {
    const { next } = planAdd(project(), 'priya@example.com');
    expect(canApprove(next, { actor: { key: 'git:priya@example.com' } })).toBe(true);
  });

  it('says so rather than adding someone twice', () => {
    expect(() => planAdd(project(), 'maya@example.com')).toThrow(/already a manager/);
  });

  it('refuses beside a display-name gate, which is repair\'s job', () => {
    expect(() => planAdd({ managerKey: 'name:Maya' }, 'priya@example.com')).toThrow(/Repair it first/);
  });

  it('promotes nobody to primary, so no key check runs for a co-manager', () => {
    expect(planAdd(project(), 'priya@example.com').promotes).toBeUndefined();
  });
});

describe('removing a co-manager', () => {
  const withPriya = () => project({ managerKeys: ['git:priya@example.com'] });

  it('takes them off the gate', () => {
    const { next } = planRemove(withPriya(), 'priya@example.com');
    expect(managersOf(next).coManagers).toEqual([]);
  });

  it('never removes the primary, which would leave the gate open or the project keyless', () => {
    expect(() => planRemove(withPriya(), 'maya@example.com')).toThrow(/primary manager and cannot simply be removed/);
  });

  it('refuses someone who is not a manager', () => {
    expect(() => planRemove(withPriya(), 'dev@example.com')).toThrow(/not a manager/);
  });

  it('names who is leaving, so a step-out check knows whom to look at', () => {
    expect(planRemove(withPriya(), 'priya@example.com').leaves).toBe('git:priya@example.com');
  });

  it('cannot leave the gate empty, since the primary always remains', () => {
    const { next } = planRemove(withPriya(), 'priya@example.com');
    expect(canApprove(next, { actor: { key: 'git:stranger@example.com' } })).toBe(false);
  });
});

describe('transferring the primary role', () => {
  it('makes the named person primary and keeps the old primary as a co-manager', () => {
    const { next } = planTransfer(project(), 'priya@example.com', { actor: PRIMARY });
    expect(managersOf(next)).toEqual({ primary: 'git:priya@example.com', coManagers: ['git:maya@example.com'] });
  });

  it('removes the old primary entirely when they step down', () => {
    const r = planTransfer(project(), 'priya@example.com', { actor: PRIMARY, stepDown: true });
    expect(managersOf(r.next)).toEqual({ primary: 'git:priya@example.com', coManagers: [] });
    expect(r.leaves).toBe('git:maya@example.com');
  });

  it('does not duplicate someone who was already a co-manager', () => {
    const config = project({ managerKeys: ['git:priya@example.com'] });
    const { next } = planTransfer(config, 'priya@example.com', { actor: PRIMARY });
    expect(managersOf(next)).toEqual({ primary: 'git:priya@example.com', coManagers: ['git:maya@example.com'] });
  });

  it('can only be done by the primary, or it would be a takeover', () => {
    const config = project({ managerKeys: ['git:priya@example.com'] });
    const coManager = { key: 'git:priya@example.com', email: 'priya@example.com' };
    expect(() => planTransfer(config, 'priya@example.com', { actor: coManager }))
      .toThrow(/Only the primary manager/);
  });

  it('recognises the primary when they arrive through GitHub', () => {
    const github = { key: 'github:7', login: 'maya', email: 'maya@example.com' };
    expect(() => planTransfer(project(), 'priya@example.com', { actor: github })).not.toThrow();
  });

  it('refuses a transfer to whoever is already primary', () => {
    expect(() => planTransfer(project(), 'maya@example.com', { actor: PRIMARY })).toThrow(/already the primary/);
  });

  it('refuses a transfer to a username', () => {
    expect(() => planTransfer(project(), 'priyar', { actor: PRIMARY })).toThrow(/not an email address/);
  });
});
