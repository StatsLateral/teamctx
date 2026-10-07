/**
 * The handle, and the two things it must never do.
 *
 * It must never shift — which is why it is stored rather than derived, and that
 * part is tested where it is written. And it must never be reused, which is the
 * one that is easy to get wrong: a counter taken from how many things exist
 * mints a key that a deleted thing already had, and two different records then
 * answer to `T-3` in two different weeks.
 */
import { describe, it, expect } from 'vitest';
import {
  KEY_PREFIX, isKey, parseKey, mintKey, emptyCounters, countersAbove, inCreationOrder, resolveKey, backfillKeys,
} from './record-key.js';

describe('what a key looks like', () => {
  it('is a letter, a dash and a number', () => {
    expect(isKey('T-14')).toBe(true);
    expect(isKey('D-3')).toBe(true);
    expect(isKey('X-1')).toBe(true);
  });

  it('is not a lowercase one, nor a letter this project does not use', () => {
    // A key is quoted from a page, not typed from memory, so accepting near
    // misses would only let a link resolve to something it does not name.
    expect(isKey('t-14')).toBe(false);
    expect(isKey('Q-1')).toBe(false);
  });

  it('is not a zero, a leading zero, or a number with anything after it', () => {
    expect(isKey('T-0')).toBe(false);
    expect(isKey('T-01')).toBe(false);
    expect(isKey('T-1x')).toBe(false);
    expect(isKey('T-1.2')).toBe(false);
  });

  it('is not an internal id, which is the whole point of the two existing', () => {
    expect(isKey('task-1a2b3c4d')).toBe(false);
    expect(isKey('rec-3502931f')).toBe(false);
  });

  it('is not something that merely contains one', () => {
    expect(isKey(' T-1')).toBe(false);
    expect(isKey('see T-1')).toBe(false);
    expect(isKey('T-1\nT-2')).toBe(false);
  });

  it('answers no to anything that is not a string', () => {
    [null, undefined, 14, {}, ['T-1']].forEach(v => expect(isKey(v)).toBe(false));
  });

  it('reads back as its letter and its number', () => {
    expect(parseKey('A-2')).toEqual({ prefix: 'A', n: 2 });
    expect(parseKey('nope')).toBe(null);
  });
});

describe('the letter each kind carries', () => {
  it('covers every kind of thing that gets one', () => {
    expect(KEY_PREFIX).toEqual({
      task: 'T', decision: 'D', rule: 'R', assumption: 'A', exception: 'X',
    });
  });
});

describe('minting one', () => {
  it('starts at one and hands back the counters to store', () => {
    const { key, counters } = mintKey(emptyCounters(), 'task');
    expect(key).toBe('T-1');
    expect(counters.T).toBe(2);
  });

  it('counts each kind on its own', () => {
    let c = emptyCounters();
    const keys = [];
    for (const kind of ['task', 'decision', 'task', 'rule', 'task']) {
      const r = mintKey(c, kind);
      keys.push(r.key);
      c = r.counters;
    }
    expect(keys).toEqual(['T-1', 'D-1', 'T-2', 'R-1', 'T-3']);
  });

  it('returns the counters rather than changing the ones it was given', () => {
    // The caller writes the key and the counters together or neither: a
    // contribution that ends up queued throws its tree away and has to throw
    // the counters away with it, or it burns a key it may never use.
    const before = emptyCounters();
    mintKey(before, 'task');
    expect(before.T).toBe(1);
  });

  it('starts from nothing when a project has no counters yet', () => {
    expect(mintKey(undefined, 'decision').key).toBe('D-1');
    expect(mintKey({}, 'decision').key).toBe('D-1');
  });

  it('ignores a counter that has been corrupted rather than minting nonsense', () => {
    // `T-0` and `T--1` are not keys, so a bad counter must not produce one.
    expect(mintKey({ T: 0 }, 'task').key).toBe('T-1');
    expect(mintKey({ T: -4 }, 'task').key).toBe('T-1');
    expect(mintKey({ T: 'many' }, 'task').key).toBe('T-1');
  });

  it('mints nothing for a kind that does not get a key', () => {
    expect(mintKey(emptyCounters(), 'question').key).toBe(null);
  });
});

describe('counters read off the keys in use', () => {
  it('sits one above the highest, so a deleted key is never handed out again', () => {
    // Three tasks, the middle one deleted. A counter from the count would mint
    // `T-3` a second time and two things would answer to it.
    expect(countersAbove(['T-1', 'T-3']).T).toBe(4);
  });

  it('does not go down for a gap at the start', () => {
    expect(countersAbove(['T-7']).T).toBe(8);
  });

  it('leaves a kind with no keys at one', () => {
    expect(countersAbove(['T-2']).D).toBe(1);
  });

  it('ignores anything that is not a key', () => {
    expect(countersAbove(['T-2', null, 'task-abc', '', 'Q-9']).T).toBe(3);
  });

  it('starts fresh for a project with nothing in it', () => {
    expect(countersAbove([])).toEqual(emptyCounters());
    expect(countersAbove(undefined)).toEqual(emptyCounters());
  });
});

describe('the order things were created in', () => {
  it('compares CLI and MCP timestamps, not their source prefixes', () => {
    const records = [
      { id: 'later', createdAt: '2026-10-05', sourceContributionIds: ['c-1791200001000-x'] },
      { id: 'earlier', createdAt: '2026-10-05', sourceContributionIds: ['mcp-1791200000000-y'] },
    ];
    expect(inCreationOrder(records).map(r => r.id)).toEqual(['earlier', 'later']);
  });

  it('orders date-only tasks alongside tasks with full timestamps', () => {
    const early = { id: 'early', createdAt: '2026-10-05T01:00:00.000Z' };
    const late = { id: 'late', createdAt: '2026-10-05', sourceContributionIds: [`mcp-${Date.parse('2026-10-05T02:00:00Z')}-x`] };
    expect(inCreationOrder([late, early]).map(t => t.id)).toEqual(['early', 'late']);
  });
  const at = (createdAt, over = {}) => ({ createdAt, ...over });

  it('is by date first', () => {
    const out = inCreationOrder([at('2026-10-03'), at('2026-10-01'), at('2026-10-02')]);
    expect(out.map(x => x.createdAt)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('breaks a shared date on the contribution that wrote it', () => {
    // Most records in a project share a date, so this tie is the common case
    // rather than the edge. Contribution ids carry a timestamp.
    const out = inCreationOrder([
      at('2026-10-01', { id: 'b', sourceContributionIds: ['c-200-x'] }),
      at('2026-10-01', { id: 'a', sourceContributionIds: ['c-100-x'] }),
    ]);
    expect(out.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('falls back to where it sits in the file, and keeps that stable', () => {
    const items = [at('2026-10-01', { id: 'first' }), at('2026-10-01', { id: 'second' })];
    expect(inCreationOrder(items).map(x => x.id)).toEqual(['first', 'second']);
    expect(inCreationOrder(items).map(x => x.id)).toEqual(['first', 'second']);
  });

  it('puts something with no date at all first, rather than dropping it', () => {
    const out = inCreationOrder([at('2026-10-01', { id: 'dated' }), { id: 'undated' }]);
    expect(out.map(x => x.id)).toEqual(['undated', 'dated']);
  });

  it('does not reorder the list it was given', () => {
    const items = [at('2026-10-03', { id: 'c' }), at('2026-10-01', { id: 'a' })];
    inCreationOrder(items);
    expect(items.map(x => x.id)).toEqual(['c', 'a']);
  });
});

describe('backfill across the project', () => {
  it('preserves issued keys, fills by creation order and does not mutate input', () => {
    const trees = [
      { records: [{ id: 'old-key', type: 'decision', key: 'D-8' }, { id: 'later', type: 'decision', createdAt: '2026-10-05' }], tasks: [] },
      { records: [{ id: 'earlier', type: 'decision', createdAt: '2026-10-04' }], tasks: [{ id: 'task', createdAt: '2026-10-01' }] },
    ];
    const once = backfillKeys(trees, { D: 12, T: 9 });
    expect(once.trees[0].records.map(r => r.key)).toEqual(['D-8', 'D-13']);
    expect(once.trees[1].records[0].key).toBe('D-12');
    expect(once.trees[1].tasks[0].key).toBe('T-9');
    expect(trees[0].records[1].key).toBeUndefined();
    expect(backfillKeys(once.trees, once.nextKey)).toEqual(once);
  });
});

describe('a key standing in for an id in a link', () => {
  const records = [{ id: 'rec-abc', key: 'R-2' }, { id: 'rec-def', key: 'D-1' }];
  const tasks = [{ id: 'task-123', key: 'T-14' }];

  it('resolves to the id the key names', () => {
    expect(resolveKey('R-2', { records, tasks })).toBe('rec-abc');
    expect(resolveKey('T-14', { records, tasks })).toBe('task-123');
  });

  it('leaves an internal id alone, which is most of what arrives here', () => {
    expect(resolveKey('rec-abc', { records, tasks })).toBe('rec-abc');
    expect(resolveKey('task-123', { records, tasks })).toBe('task-123');
  });

  it('leaves a key naming nothing alone, so it falls back the way an unknown id does', () => {
    // Not an error: a link to something out of this reader's scope, or to
    // something since deleted, should land on the page quietly.
    expect(resolveKey('T-99', { records, tasks })).toBe('T-99');
  });

  it('passes null and undefined through, since a link need not point at anything', () => {
    expect(resolveKey(null, { records, tasks })).toBe(null);
    expect(resolveKey(undefined, { records, tasks })).toBe(undefined);
  });

  it('works with nothing to search, rather than throwing', () => {
    expect(resolveKey('T-1')).toBe('T-1');
    expect(resolveKey('T-1', {})).toBe('T-1');
  });

  it('does not match on a record that has no key at all', () => {
    expect(resolveKey('T-1', { records: [{ id: 'rec-x' }], tasks: [] })).toBe('T-1');
  });
});
