/**
 * Following `restsOn`, which nothing used to follow.
 *
 * The cases that matter are the ones a hand-written walk gets wrong: a record
 * reached by two paths, two records resting on each other, and a chain the
 * manager has repaired halfway down. The acceptance criteria on #120 name the
 * first two; the third is the one the first draft of this file got wrong.
 */
import { describe, it, expect } from 'vitest';
import { restingOn, needsReviewFlags, NEEDS_REVIEW } from './impact.js';
import { makeRecord, makeTask } from './test-fixtures/model.js';

const assume = (over = {}) => makeRecord({ type: 'assumption', ...over });
const decide = (over = {}) => makeRecord({ type: 'decision', ...over });
const rests = (...ids) => ({ links: { restsOn: ids } });
const ids = (list) => list.map(r => r.id);

describe('what rests on an assumption', () => {
  it('finds a decision that names it', () => {
    const a = assume({ id: 'a1' });
    const d = decide({ id: 'd1', ...rests('a1') });
    expect(ids(restingOn([a, d], 'a1').records)).toEqual(['d1']);
  });

  it('follows a second level, and lists each one exactly once', () => {
    // #120's first acceptance criterion.
    const a = assume({ id: 'a1' });
    const d = decide({ id: 'd1', ...rests('a1') });
    const r = makeRecord({ id: 'r1', type: 'rule', ...rests('d1') });
    expect(ids(restingOn([a, d, r], 'a1').records)).toEqual(['d1', 'r1']);
  });

  it('lists a record reached by two paths once, not twice', () => {
    const a = assume({ id: 'a1' });
    const d1 = decide({ id: 'd1', ...rests('a1') });
    const d2 = decide({ id: 'd2', ...rests('a1') });
    const both = makeRecord({ id: 'r1', type: 'rule', ...rests('d1', 'd2') });
    expect(ids(restingOn([a, d1, d2, both], 'a1').records)).toEqual(['d1', 'd2', 'r1']);
  });

  it('stops rather than loops on two records that rest on each other', () => {
    // Nothing stops the AI proposing this pair, and a walk without a visited set
    // runs until the stack gives out.
    const a = assume({ id: 'a1' });
    const d1 = decide({ id: 'd1', ...rests('a1', 'd2') });
    const d2 = decide({ id: 'd2', ...rests('d1') });
    expect(ids(restingOn([a, d1, d2], 'a1').records).sort()).toEqual(['d1', 'd2']);
  });

  it('reads what rests directly on it before what rests on those', () => {
    // So the list reads the way somebody would say it out loud.
    const a = assume({ id: 'a1' });
    const far = makeRecord({ id: 'far', type: 'rule', ...rests('near') });
    const near = decide({ id: 'near', ...rests('a1') });
    expect(ids(restingOn([a, far, near], 'a1').records)).toEqual(['near', 'far']);
  });

  it('answers nothing for an assumption nobody built on', () => {
    const a = assume({ id: 'a1' });
    expect(restingOn([a, decide({ id: 'd1' })], 'a1').records).toEqual([]);
  });

  it('crosses parts of the work, because it is given every record', () => {
    // The reason this takes a flat list and not a tree. A walk over one
    // workstream would answer "nothing rests on this" and be believed.
    const a = assume({ id: 'a1', attachedTo: { kind: 'project' } });
    const elsewhere = decide({ id: 'd1', attachedTo: { kind: 'workstream', id: 'billing' }, ...rests('a1') });
    expect(ids(restingOn([a, elsewhere], 'a1').records)).toEqual(['d1']);
  });
});

describe('records that are no longer standing', () => {
  it('does not follow a replaced record, or anything under it', () => {
    const a = assume({ id: 'a1' });
    const gone = decide({ id: 'd1', status: 'replaced', ...rests('a1') });
    const under = makeRecord({ id: 'r1', type: 'rule', ...rests('d1') });
    expect(restingOn([a, gone, under], 'a1').records).toEqual([]);
  });

  it('does not follow an exception whose own date has passed', () => {
    const a = assume({ id: 'a1' });
    const expired = makeRecord({
      id: 'x1', type: 'exception', expiresAt: '2026-01-01',
      links: { bends: 'rule-1', restsOn: ['a1'] },
    });
    expect(restingOn([a, expired], 'a1', { onDay: '2026-10-05' }).records).toEqual([]);
  });
});

describe('the tasks being done because of them', () => {
  it('names the task a dependent record is attached to', () => {
    const a = assume({ id: 'a1' });
    const d = decide({ id: 'd1', attachedTo: { kind: 'task', id: 't1' }, ...rests('a1') });
    const t = makeTask({ id: 't1', title: 'Build SSO' });
    const out = restingOn([a, d], 'a1', { tasks: [t] });
    expect(out.tasks.map(x => x.title)).toEqual(['Build SSO']);
  });

  it('names a task once even when two records on it rest on the assumption', () => {
    const a = assume({ id: 'a1' });
    const on = { kind: 'task', id: 't1' };
    const d1 = decide({ id: 'd1', attachedTo: on, ...rests('a1') });
    const d2 = decide({ id: 'd2', attachedTo: on, ...rests('a1') });
    const out = restingOn([a, d1, d2], 'a1', { tasks: [makeTask({ id: 't1' })] });
    expect(out.tasks).toHaveLength(1);
  });

  it('leaves out a task id it was given no task for', () => {
    // A dependent attached to a task in a part of the work the caller did not
    // pass. Better absent than a hole in the list with an id in it.
    const a = assume({ id: 'a1' });
    const d = decide({ id: 'd1', attachedTo: { kind: 'task', id: 'gone' }, ...rests('a1') });
    expect(restingOn([a, d], 'a1', { tasks: [] }).tasks).toEqual([]);
  });
});

describe('which records are waiting on something broken', () => {
  const broke = (over = {}) => assume({ status: 'broken', brokenAt: '2026-10-05T09:00:00.000Z', ...over });

  it('flags a decision resting on a broken assumption', () => {
    const flags = needsReviewFlags([broke({ id: 'a1' }), decide({ id: 'd1', ...rests('a1') })]);
    expect(flags.get('d1')).toEqual(['a1']);
  });

  it('flags what rests on that decision too', () => {
    const flags = needsReviewFlags([
      broke({ id: 'a1' }),
      decide({ id: 'd1', ...rests('a1') }),
      makeRecord({ id: 'r1', type: 'rule', ...rests('d1') }),
    ]);
    expect(flags.get('r1')).toEqual(['a1']);
  });

  it('says nothing about an assumption that still holds', () => {
    const flags = needsReviewFlags([assume({ id: 'a1' }), decide({ id: 'd1', ...rests('a1') })]);
    expect(flags.size).toBe(0);
  });

  it('names both when a record rests on two that broke', () => {
    const flags = needsReviewFlags([
      broke({ id: 'a1' }), broke({ id: 'a2' }),
      decide({ id: 'd1', ...rests('a1', 'a2') }),
    ]);
    expect(flags.get('d1').sort()).toEqual(['a1', 'a2']);
  });

  it('ignores a broken record that is not an assumption', () => {
    // Only an assumption breaks. A decision that no longer holds is replaced,
    // and a replaced decision is history rather than a thing to flag under.
    const d = decide({ id: 'd1', status: 'broken', brokenAt: '2026-10-05T09:00:00.000Z' });
    const flags = needsReviewFlags([d, makeRecord({ id: 'r1', type: 'rule', ...rests('d1') })]);
    expect(flags.size).toBe(0);
  });
});

describe('clearing the flag', () => {
  const brokenAt = '2026-10-05T09:00:00.000Z';
  const broke = (over = {}) => assume({ status: 'broken', brokenAt, ...over });

  it('clears it once the manager re-confirms the record', () => {
    const flags = needsReviewFlags([
      broke({ id: 'a1' }),
      decide({ id: 'd1', reviewedAt: '2026-10-05T10:00:00.000Z', ...rests('a1') }),
    ]);
    expect(flags.size).toBe(0);
  });

  it('keeps it when the record was last looked at before the break', () => {
    const flags = needsReviewFlags([
      broke({ id: 'a1' }),
      decide({ id: 'd1', reviewedAt: '2026-10-04T10:00:00.000Z', ...rests('a1') }),
    ]);
    expect(flags.get('d1')).toEqual(['a1']);
  });

  it('tells the two apart within the same day', () => {
    // Why these are timestamps and not the date-only `updatedAt` a record
    // already carries: breaking an assumption and re-confirming what rested on
    // it in one sitting is the ordinary case, and a date cannot order them.
    const same = (reviewedAt) => needsReviewFlags([
      broke({ id: 'a1' }), decide({ id: 'd1', reviewedAt, ...rests('a1') }),
    ]);
    expect(same('2026-10-05T08:59:59.000Z').get('d1')).toEqual(['a1']);
    expect(same('2026-10-05T09:00:01.000Z').size).toBe(0);
  });

  it('settles it for the record standing on the one re-confirmed', () => {
    // The manager said the decision still holds, so the rule resting on that
    // decision is not waiting on anybody. The walk stops there rather than
    // flagging everything underneath for a question already answered.
    const flags = needsReviewFlags([
      broke({ id: 'a1' }),
      decide({ id: 'd1', reviewedAt: '2026-10-05T10:00:00.000Z', ...rests('a1') }),
      makeRecord({ id: 'r1', type: 'rule', ...rests('d1') }),
    ]);
    expect(flags.size).toBe(0);
  });

  it('still flags that record if it rests on the broken one directly as well', () => {
    // Repairing one path does not repair the other.
    const flags = needsReviewFlags([
      broke({ id: 'a1' }),
      decide({ id: 'd1', reviewedAt: '2026-10-05T10:00:00.000Z', ...rests('a1') }),
      makeRecord({ id: 'r1', type: 'rule', ...rests('d1', 'a1') }),
    ]);
    expect(flags.get('r1')).toEqual(['a1']);
  });

  it('flags a record re-confirmed against a different assumption', () => {
    // `reviewedAt` is one date, and two assumptions break at different times.
    // Re-confirming after the first must not pass for the second.
    const flags = needsReviewFlags([
      broke({ id: 'a1', brokenAt: '2026-10-01T09:00:00.000Z' }),
      broke({ id: 'a2', brokenAt: '2026-10-05T09:00:00.000Z' }),
      decide({ id: 'd1', reviewedAt: '2026-10-02T10:00:00.000Z', ...rests('a1', 'a2') }),
    ]);
    expect(flags.get('d1')).toEqual(['a2']);
  });

  it('flags a dependent of an assumption broken before this was recorded', () => {
    // No `brokenAt` at all, from a project broken under an older version. Fails
    // closed: a second look is the safe answer, a silent pass is not.
    const flags = needsReviewFlags([
      assume({ id: 'a1', status: 'broken' }),
      decide({ id: 'd1', reviewedAt: '2026-10-05T10:00:00.000Z', ...rests('a1') }),
    ]);
    expect(flags.get('d1')).toEqual(['a1']);
  });
});

describe('what a brief says', () => {
  it('has one wording, so every read path says the same thing', () => {
    expect(NEEDS_REVIEW).toBe('needs review — rests on a broken assumption');
  });
});
