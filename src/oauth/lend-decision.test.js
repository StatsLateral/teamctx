import { describe, it, expect } from 'vitest';
import { lendDecision } from './lend-decision.js';

const SLUG = 'acme/ledger';
const GH = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };

describe('who may lend a project GitHub access', () => {
  it('lets a repository admin lend it', () => {
    // Lending hands out your own credential, and an admin can already grant
    // access by other means. This is the same authority, spelled differently.
    expect(lendDecision({ config: {}, actor: GH, isAdmin: true, slug: SLUG }))
      .toMatchObject({ ok: true, via: 'admin' });
  });

  it('lets the manager lend without repository admin', () => {
    const config = { managerKey: 'github:1001' };
    expect(lendDecision({ config, actor: GH, isAdmin: false, slug: SLUG }))
      .toMatchObject({ ok: true, via: 'manager' });
  });

  it('recognises the manager by an identity from a different surface', () => {
    // The bug this exists for: the gate was pinned from a clone, so it holds
    // git:<email>, but the settings page knows the same person as github:<id>.
    // A single-form comparison refused them their own project.
    const config = { managerKey: 'git:ada@example.com', managerKeys: ['github:1001'] };
    expect(lendDecision({ config, actor: GH, isAdmin: false, slug: SLUG }).ok).toBe(true);
  });

  it('recognises the manager by GitHub login', () => {
    expect(lendDecision({ config: { managerKey: '@ada' }, actor: GH, isAdmin: false, slug: SLUG }).ok).toBe(true);
  });

  it('refuses a non-manager with no admin', () => {
    const config = { managerKey: 'github:9999' };
    const r = lendDecision({ config, actor: GH, isAdmin: false, slug: SLUG });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/managed by someone else/);
  });

  it('refuses when no manager is recorded and there is no admin', () => {
    expect(lendDecision({ config: {}, actor: GH, isAdmin: false, slug: SLUG }).ok).toBe(false);
  });

  it('does not treat an unreadable config as an open gate', () => {
    expect(lendDecision({ config: null, actor: GH, isAdmin: false, slug: SLUG }).ok).toBe(false);
  });

  it('never blames admin access when the manager is simply someone else', () => {
    // The original wording told the repository's own owner they needed a
    // permission they already had.
    const r = lendDecision({ config: { managerKey: 'github:9999' }, actor: GH, isAdmin: false, slug: SLUG });
    expect(r.why).not.toMatch(/^You need admin access/);
  });
});
