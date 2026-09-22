import { describe, it, expect } from 'vitest';
import { projectKeyDecision } from './project-key-decision.js';

const SLUG = 'acme/ledger';
const config = {
  managerKey: 'git:maya@example.com',
  managerKeys: ['git:priya@example.com'],
  members: [{ key: 'git:dev@example.com', name: 'Dev', email: 'dev@example.com', login: null }],
};

describe('who may add a key to a project', () => {
  it('lets somebody with push access add one, as it always has', () => {
    expect(projectKeyDecision({ config: null, email: 'anyone@example.com', hasPush: true, slug: SLUG }))
      .toMatchObject({ ok: true, via: 'push' });
  });

  it('lets the primary manager add one by address', () => {
    expect(projectKeyDecision({ config, email: 'maya@example.com', slug: SLUG }))
      .toMatchObject({ ok: true, via: 'manager' });
  });

  it('lets a co-manager add one', () => {
    expect(projectKeyDecision({ config, email: 'priya@example.com', slug: SLUG }))
      .toMatchObject({ ok: true, via: 'manager' });
  });

  it('lets a roster member add one — the Google sign-in case', () => {
    // No push access to offer, so the roster is the proof.
    expect(projectKeyDecision({ config, email: 'Dev@Example.com', slug: SLUG }))
      .toMatchObject({ ok: true, via: 'member' });
  });

  it('refuses a signed-in stranger, and says what to do', () => {
    const r = projectKeyDecision({ config, email: 'sam@example.com', slug: SLUG });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/sam@example\.com is not on acme\/ledger/);
  });

  it('refuses a sign-in with no verified address, even with push access', () => {
    // The key has to be stored against somebody; without an address it would
    // belong to nobody another sign-in could find.
    expect(projectKeyDecision({ config, email: null, hasPush: true, slug: SLUG }).ok).toBe(false);
  });

  it('refuses rather than guessing when the project settings cannot be read', () => {
    const r = projectKeyDecision({ config: null, email: 'dev@example.com', slug: SLUG });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/Could not read/);
  });

  it('does not treat a manager written as a GitHub id as matching an address', () => {
    // A Google sign-in carries no GitHub id, so an old id-shaped gate cannot be
    // matched by address — and must not be assumed to.
    const old = { managerKey: 'github:7', members: [] };
    expect(projectKeyDecision({ config: old, email: 'maya@example.com', slug: SLUG }).ok).toBe(false);
  });
});
