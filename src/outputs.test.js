import { describe, it, expect } from 'vitest';
import { outputStates, outputsForReader } from './outputs.js';

const out = (id, at, over = {}) => ({
  id, task: 't1', title: `Title ${id}`, body: `Body ${id}`, at, notes: null, prompt: null, basedOn: null,
  author: { key: 'git:priya@x', name: 'Priya' }, ...over,
});

describe('where an output stands', () => {
  const saved = [out('a', '2026-10-01T10:00:00Z'), out('b', '2026-10-02T10:00:00Z'), out('c', '2026-10-03T10:00:00Z')];

  it('is working unless something names it', () => {
    expect(outputStates(saved, { approvals: {}, waiting: new Set() }).map(o => o.state)).toEqual(['working', 'working', 'working']);
  });

  it('is accepted once an approval names it, and submitted while a queue item does', () => {
    const states = outputStates(saved, { approvals: { x: { outputs: ['a'] } }, waiting: new Set(['b']) });
    expect(states.map(o => o.state)).toEqual(['accepted', 'submitted', 'working']);
  });

  it('is accepted even if it is also named by a waiting item', () => {
    const states = outputStates(saved, { approvals: { x: { outputs: ['a'] } }, waiting: new Set(['a']) });
    expect(states[0].state).toBe('accepted');
  });

  it('ignores an approval or queue item whose outputs are not a list', () => {
    expect(outputStates(saved, { approvals: { x: { outputs: 'a' }, y: {} }, waiting: new Set() })[0].state).toBe('working');
  });
});

describe('what a reader is shown', () => {
  const states = outputStates(
    [out('a', '2026-10-01T10:00:00Z'), out('b', '2026-10-02T10:00:00Z', { author: { key: 'git:dev@x', name: 'Dev' }, basedOn: 'a' })],
    { approvals: {}, waiting: new Set() },
  );
  const reader = (over = {}) => outputsForReader({
    outputs: states, rejected: [], actorKeys: ['git:priya@x'], isManager: false, canSee: () => true, ...over,
  });

  it('lists every output on the task, newest first, in full', () => {
    expect(reader().map(o => o.id)).toEqual(['b', 'a']);
    expect(reader()[0]).toMatchObject({ title: 'Title b', body: 'Body b', basedOn: 'a', state: 'working' });
  });

  it('marks the reader\'s own, by the key rather than the name', () => {
    expect(reader().map(o => o.mine)).toEqual([false, true]);
    expect(reader({ actorKeys: ['github:9', 'git:priya@x'] })[1].mine).toBe(true);
    expect(reader({ actorKeys: [] }).map(o => o.mine)).toEqual([false, false]);
  });

  it('shows a name nobody on the roster answers to as "someone"', () => {
    const r = reader({ canSee: (name) => name === 'Priya' });
    expect(r.map(o => o.author)).toEqual(['someone', 'Priya']);
  });

  it('gives the manager every name', () => {
    expect(reader({ isManager: true, canSee: () => false }).map(o => o.author)).toEqual(['Dev', 'Priya']);
  });

  describe('the reason a submission was turned down', () => {
    const rejected = [{ id: 'q1', forTask: 't1', outputs: ['a', 'b'], reason: 'Too long', rejectedAt: '2026-10-04T10:00:00Z' }];

    it('is shown on the author\'s own output, and to the manager', () => {
      expect(reader({ rejected })[1].turnedDown).toEqual({ reason: 'Too long', at: '2026-10-04T10:00:00Z' });
      expect(reader({ rejected, isManager: true, actorKeys: [] }).map(o => o.turnedDown?.reason)).toEqual(['Too long', 'Too long']);
    });

    it('is not shown on somebody else\'s output', () => {
      expect(reader({ rejected })[0].turnedDown).toBeNull();
    });

    it('is not shown once the output has moved on', () => {
      const moved = outputStates(
        [out('a', '2026-10-01T10:00:00Z')], { approvals: {}, waiting: new Set(['a']) },
      );
      expect(outputsForReader({ outputs: moved, rejected, actorKeys: ['git:priya@x'], isManager: false, canSee: () => true })[0].turnedDown).toBeNull();
    });

    it('uses the latest rejection when there was more than one', () => {
      const twice = [...rejected, { id: 'q2', forTask: 't1', outputs: ['a'], reason: 'Still too long', rejectedAt: '2026-10-05T10:00:00Z' }];
      expect(reader({ rejected: twice })[1].turnedDown.reason).toBe('Still too long');
    });

    it('has no reason to show when the manager gave none', () => {
      const none = [{ id: 'q1', forTask: 't1', outputs: ['a'], reason: null, rejectedAt: '2026-10-04T10:00:00Z' }];
      expect(reader({ rejected: none })[1].turnedDown).toEqual({ reason: null, at: '2026-10-04T10:00:00Z' });
    });
  });
});

describe('who reads the feedback on a sent-back output', () => {
  const out = [{ id: 'o1', title: 't', body: 'b', at: '2026-10-15T19:59:00Z', state: 'working', author: { key: 'git:writer@x.com', name: 'Writer' } }];
  const rej = [{ forTask: 'T', outputs: ['o1'], reason: 'fix three points', rejectedAt: '2026-10-15T20:02:00Z' }];
  const read = (extra) => outputsForReader({ outputs: out, rejected: rej, canSee: () => true, ...extra })[0].turnedDown;

  it('shows it to whoever the task is assigned to, whatever the source of the work', () => {
    expect(read({ actorKeys: ['git:someone@x.com'], assigned: true })?.reason).toBe('fix three points');
  });
  it('still shows it to the author and the manager, and to nobody else', () => {
    expect(read({ actorKeys: ['git:writer@x.com'] })?.reason).toBe('fix three points');
    expect(read({ actorKeys: [], isManager: true })?.reason).toBe('fix three points');
    expect(read({ actorKeys: ['git:other@x.com'] })).toBeNull();
  });
});
