import { describe, it, expect } from 'vitest';
import {
  POLICIES, DEFAULT_POLICY, NEW_PROJECT_POLICY,
  reviewPolicy, isAdditive, needsReview, reflectNeedsManager,
  InvalidReviewPolicyError,
} from './review-policy.js';

const add = (type = 'addWhy') => ({ type, text: 'x' });
const del = () => ({ type: 'deleteStatement', id: 'abc' });
const edit = () => ({ type: 'editStatement', id: 'abc', text: 'y' });

describe('reading the policy off a config', () => {
  it('treats a project that has never heard of the setting as "all"', () => {
    // The whole migration story rests on this. An existing project must keep
    // queueing everything after an upgrade, without anyone touching its config.
    expect(reviewPolicy({})).toBe('all');
    expect(reviewPolicy(undefined)).toBe('all');
    expect(DEFAULT_POLICY).toBe('all');
  });

  it('ignores a value it does not recognise rather than trusting it', () => {
    // config.json is a committed file anyone with push access can edit. A typo
    // must not silently open the gate.
    expect(reviewPolicy({ reviewPolicy: 'None' })).toBe('all');
    expect(reviewPolicy({ reviewPolicy: 'off' })).toBe('all');
    expect(reviewPolicy({ reviewPolicy: true })).toBe('all');
  });

  it('reads back each policy it does recognise', () => {
    POLICIES.forEach(p => expect(reviewPolicy({ reviewPolicy: p })).toBe(p));
  });

  it('starts new projects additive, which is not the fallback', () => {
    expect(NEW_PROJECT_POLICY).toBe('additive');
    expect(NEW_PROJECT_POLICY).not.toBe(DEFAULT_POLICY);
  });
});

describe('telling an addition from something that loses information', () => {
  it('counts the three add operations as additive', () => {
    expect(isAdditive([add('addWhy'), add('addWhat'), add('addHow')])).toBe(true);
  });

  it('counts a delete or an edit as not additive', () => {
    expect(isAdditive([del()])).toBe(false);
    expect(isAdditive([edit()])).toBe(false);
  });

  it('takes one destructive operation among many adds as destructive', () => {
    // The observed shape: a single contribution came back as seven operations,
    // two of them deleting statements somebody else had written.
    expect(isAdditive([add(), add(), del(), add()])).toBe(false);
  });

  it('treats an operation type it has never heard of as destructive', () => {
    // Failing open here would mean any operation added after this file was
    // written bypasses review by default.
    expect(isAdditive([{ type: 'replaceEverything' }])).toBe(false);
    expect(isAdditive([add(), { type: 'moveStatement' }])).toBe(false);
  });

  it('survives malformed operations without deciding they are safe', () => {
    expect(isAdditive([null])).toBe(false);
    expect(isAdditive([{}])).toBe(false);
  });

  it('calls an empty list additive, since it changes nothing', () => {
    expect(isAdditive([])).toBe(true);
    expect(isAdditive(undefined)).toBe(true);
  });
});

describe('deciding whether a contribution waits', () => {
  it('queues everything under "all"', () => {
    const c = { reviewPolicy: 'all' };
    expect(needsReview(c, [add()])).toBe(true);
    expect(needsReview(c, [del()])).toBe(true);
  });

  it('queues nothing under "none"', () => {
    const c = { reviewPolicy: 'none' };
    expect(needsReview(c, [add()])).toBe(false);
    expect(needsReview(c, [del()])).toBe(false);
  });

  it('under "additive", lets additions through and holds deletions', () => {
    const c = { reviewPolicy: 'additive' };
    expect(needsReview(c, [add(), add()])).toBe(false);
    expect(needsReview(c, [add(), del()])).toBe(true);
    expect(needsReview(c, [edit()])).toBe(true);
  });

  it('queues everything for a project with no policy recorded', () => {
    expect(needsReview({}, [add()])).toBe(true);
  });

  it('asks nothing about who is calling', () => {
    // Deliberate: `apply: true` stays manager-gated in contributeCore. This
    // answers whether review is required at all, and a member passing it is not
    // thereby acting as the manager.
    expect(needsReview.length).toBe(2);
  });
});

describe('who may rewrite the whole tree with reflect', () => {
  const gated = { managerKey: 'git:manager@example.com' };

  it('is the manager under "all" and "additive"', () => {
    expect(reflectNeedsManager({ ...gated, reviewPolicy: 'all' })).toBe(true);
    expect(reflectNeedsManager({ ...gated, reviewPolicy: 'additive' })).toBe(true);
  });

  it('is anyone under "none", which is what reflect did before this existed', () => {
    // A project that relied on members running reflect keeps that behaviour by
    // choosing `none` — no behaviour becomes unreachable.
    expect(reflectNeedsManager({ ...gated, reviewPolicy: 'none' })).toBe(false);
  });

  it('is anyone on a project with no manager pinned', () => {
    // Same bootstrap case the approval gate has: with nobody pinned there is
    // no one to assert against, and refusing everyone would strand the project.
    expect(reflectNeedsManager({ reviewPolicy: 'all' })).toBe(false);
  });

  it('defaults to manager-only for an existing gated project', () => {
    // The one behaviour change on upgrade, and the one worth a changelog line.
    expect(reflectNeedsManager(gated)).toBe(true);
  });
});

describe('rejecting a policy nobody can act on', () => {
  it('names the value and the valid ones', () => {
    const err = new InvalidReviewPolicyError('sometimes');
    expect(err.message).toContain('sometimes');
    expect(err.message).toContain('all, additive, none');
    expect(err.code).toBe('INVALID_REVIEW_POLICY');
  });
});
