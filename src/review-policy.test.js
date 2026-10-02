import { describe, it, expect } from 'vitest';
import {
  POLICIES, DEFAULT_POLICY, NEW_PROJECT_POLICY,
  reviewPolicy, isAdditive, needsReview,
  InvalidReviewPolicyError,
} from './review-policy.js';

const add = (type = 'why') => (type === 'task' ? { type: 'addTask', title: 'x' } : { type: 'addRecord', record: { type } });
const del = () => ({ type: 'removeTask', id: 'abc' });
const edit = () => ({ type: 'editRecord', id: 'abc', changes: { text: 'y' } });

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

  it('starts new projects reviewing everything, the same as the fallback', () => {
    // These were deliberately different: a new project was `additive` while a
    // project that had never heard of the setting queued everything. A member's
    // assistant could then add statements the whole team's assistants read as the
    // team's position, with nobody having agreed to them.
    expect(NEW_PROJECT_POLICY).toBe('all');
    expect(NEW_PROJECT_POLICY).toBe(DEFAULT_POLICY);
  });

  it('still lets a project ask for less, and still reads it back', () => {
    // The point is the default, not removing the choice.
    expect(reviewPolicy({ reviewPolicy: 'additive' })).toBe('additive');
    expect(needsReview({ reviewPolicy: 'additive' }, [add('why')])).toBe(false);
  });
});

describe('telling an addition from something that loses information', () => {
  it('counts the three add operations as additive', () => {
    expect(isAdditive([add('why'), add('assumption'), add('task')])).toBe(true);
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

describe('rejecting a policy nobody can act on', () => {
  it('names the value and the valid ones', () => {
    const err = new InvalidReviewPolicyError('sometimes');
    expect(err.message).toContain('sometimes');
    expect(err.message).toContain('all, additive, none');
    expect(err.code).toBe('INVALID_REVIEW_POLICY');
  });
});

describe('isAdditive on the governed model', () => {
  const rec = (type) => ({ type: 'addRecord', record: { type } });
  it('tasks and low-stakes records are additive', () => {
    expect(isAdditive([{ type: 'addTask', title: 't' }, rec('why'), rec('assumption'), rec('question'), rec('risk')])).toBe(true);
  });
  it('decisions, rules and exceptions never are', () => {
    for (const t of ['decision', 'rule', 'exception']) expect(isAdditive([rec(t)])).toBe(false);
  });
  it('edits, status changes, removals and the goal never are', () => {
    for (const type of ['editRecord', 'setRecordStatus', 'removeTask', 'editTask', 'setGoal']) {
      expect(isAdditive([{ type }])).toBe(false);
    }
  });
  it('additive policy still queues a decision', () => {
    expect(needsReview({ reviewPolicy: 'additive' }, [rec('decision')])).toBe(true);
  });
});

describe('retiring or settling something is never a quiet addition', () => {
  it('an addition that replaces an existing record is not additive', () => {
    expect(isAdditive([{ type: 'addRecord', record: { type: 'why', text: 'x', links: { replaces: 'rec-d' } } }])).toBe(false);
  });
  it('decisions, rules and exceptions need the manager even under "none"', () => {
    for (const t of ['decision', 'rule', 'exception']) {
      expect(needsReview({ reviewPolicy: 'none' }, [{ type: 'addRecord', record: { type: t, text: 'x' } }])).toBe(true);
    }
    expect(needsReview({ reviewPolicy: 'none' }, [{ type: 'addTask', title: 't' }])).toBe(false);
  });
  it('a status change needs the manager even under "none"', () => {
    expect(needsReview({ reviewPolicy: 'none' }, [{ type: 'setRecordStatus', id: 'r', status: 'replaced' }])).toBe(true);
  });
});
