/**
 * The numbers, and the two things they must never do: shift, and be reused.
 *
 * Never reused is the one that is easy to get wrong. A counter taken from how
 * many things exist mints a number that a deleted thing already had, and two
 * different tasks then answer to `3.3` in two different weeks.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyCounters, normalizeCounters, workstreamNumber, mintWorkstreamNumber, mintTaskKey, isTaskKey, resolveKey,
} from './numbering.js';

describe('what a task number looks like', () => {
  it('is a workstream number, a dot and a task number', () => {
    expect(isTaskKey('3.2')).toBe(true);
    expect(isTaskKey('12.40')).toBe(true);
  });

  it('is not a workstream number, nor an old letter key, nor an id', () => {
    ['3', 'T-14', 'D-3', 'task-1a2b3c4d', 't-write-the-post'].forEach(v => expect(isTaskKey(v)).toBe(false));
  });

  it('is not a zero, a leading zero, or something with more around it', () => {
    ['0.1', '3.0', '03.2', '3.02', '3.2.1', ' 3.2', '3.2 ', '3.2\n4.1', 'see 3.2'].forEach(v => expect(isTaskKey(v)).toBe(false));
  });

  it('answers no to anything that is not a string', () => {
    [null, undefined, 3.2, {}, ['3.2']].forEach(v => expect(isTaskKey(v)).toBe(false));
  });
});

describe('workstream numbers', () => {
  it('start at 1 and go up by one, across the whole project', () => {
    let counters = emptyCounters();
    const numbers = [];
    for (let i = 0; i < 3; i++) {
      const minted = mintWorkstreamNumber(counters);
      numbers.push(minted.number);
      counters = minted.counters;
    }
    expect(numbers).toEqual([1, 2, 3]);
  });

  it('do not touch the task counters', () => {
    const counters = { workstream: 2, tasks: { launch: 4 } };
    expect(mintWorkstreamNumber(counters).counters).toEqual({ workstream: 3, tasks: { launch: 4 } });
  });

  it('are read from the registry as stored, and null when there is none', () => {
    const config = { workstreams: [{ id: 'launch', number: 2 }, { id: 'old' }] };
    expect(workstreamNumber(config, 'launch')).toBe(2);
    expect(workstreamNumber(config, 'old')).toBe(null);
    expect(workstreamNumber(config, 'nope')).toBe(null);
    expect(workstreamNumber({}, 'launch')).toBe(null);
  });
});

describe('task numbers', () => {
  it('count per workstream', () => {
    let counters = emptyCounters();
    const keys = [];
    for (const [number, workstream] of [[3, 'pricing'], [3, 'pricing'], [4, 'outreach'], [3, 'pricing']]) {
      const minted = mintTaskKey(counters, { number, workstream });
      keys.push(minted.key);
      counters = minted.counters;
    }
    expect(keys).toEqual(['3.1', '3.2', '4.1', '3.3']);
  });

  it('are not reused after a delete, because the counter is stored, not derived', () => {
    // Three made, the middle one removed: the tasks are 3.1 and 3.3, and a
    // count of two would mint 3.3 again.
    let counters = emptyCounters();
    for (let i = 0; i < 3; i++) counters = mintTaskKey(counters, { number: 3, workstream: 'pricing' }).counters;
    expect(mintTaskKey(counters, { number: 3, workstream: 'pricing' }).key).toBe('3.4');
  });

  it('refuse a workstream with no number, rather than inventing one', () => {
    expect(() => mintTaskKey(emptyCounters(), { number: null, workstream: 'x' })).toThrow(/no number/);
    expect(() => mintTaskKey(emptyCounters(), { number: 0, workstream: 'x' })).toThrow(/no number/);
  });

  it('never mutate the counters they are given', () => {
    const counters = Object.freeze({ workstream: 1, tasks: Object.freeze({ a: 1 }) });
    expect(() => mintTaskKey(counters, { number: 1, workstream: 'a' })).not.toThrow();
  });
});

describe('counters of any shape', () => {
  it('come out in the known shape', () => {
    expect(normalizeCounters(undefined)).toEqual({ workstream: 1, tasks: {} });
    expect(normalizeCounters({ T: 14, D: 3 })).toEqual({ workstream: 1, tasks: {} });
    expect(normalizeCounters({ workstream: 0, tasks: { a: -2, b: 5 } })).toEqual({ workstream: 1, tasks: { a: 1, b: 5 } });
  });
});

describe('resolving a number to the id it names', () => {
  const tasks = [{ id: 't-write-the-post', key: '1.2' }, { id: 't-other', key: '2.1' }];

  it('returns the id', () => expect(resolveKey('1.2', { tasks })).toBe('t-write-the-post'));
  it('returns an id untouched', () => expect(resolveKey('t-other', { tasks })).toBe('t-other'));
  it('returns a number naming nothing untouched, so it resolves to no row', () => expect(resolveKey('9.9', { tasks })).toBe('9.9'));
  it('passes null through', () => expect(resolveKey(null, { tasks })).toBe(null));
});

describe('a task outside any workstream', () => {
  it('is refused with the way out: name one, or add one', async () => {
    const { TaskWithoutWorkstreamError } = await import('./numbering.js');
    expect(new TaskWithoutWorkstreamError(['launch', 'support']).message).toMatch(/Say which one: launch, support/);
    expect(new TaskWithoutWorkstreamError([]).message).toMatch(/no workstream yet.*add one first/);
    expect(new TaskWithoutWorkstreamError().code).toBe('TASK_NEEDS_WORKSTREAM');
  });
});
