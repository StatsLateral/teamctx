/**
 * A proposed task never says it came from a record that was dropped (#175).
 *
 * Found on a live run: the model proposed a decision with an invalid
 * `links.replaces`, which the checks drop, and a task "from" that decision. The
 * reviewer read "from Decision: …" about a decision that was not being added.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./ai.js', async original => ({
  ...(await original()),
  proposeDiff: vi.fn(async () => ({
    summary: 'Registration closes earlier',
    operations: [
      { type: 'addRecord', ref: 'd', record: { type: 'decision', text: 'Registration closes on 5 November', links: { replaces: 'not-here' } } },
      { type: 'addTask', title: 'Set up the sign-up form', owner: 'Smita', from: 'd', fromRecord: { type: 'decision', text: 'Registration closes on 5 November' } },
    ],
  })),
}));

const { updateShared } = await import('./context.js');
const { withoutDroppedSources } = await import('./task-wording.js');
const { makeWorkstream } = await import('./test-fixtures/model.js');

describe('a task whose source was dropped', () => {
  it('keeps the task and its owner, and loses where it came from', async () => {
    const r = await updateShared(makeWorkstream('registration'), { id: 'c-1', text: 'notes', author: 'Satyagya' }, { model: 'm', nextKey: {}, workstreams: [{ id: 'registration', number: 1, name: 'Registration' }] });
    expect(r.dropped).toHaveLength(1);
    expect(r.operations).toEqual([{ type: 'addTask', title: 'Set up the sign-up form', owner: 'Smita' }]);
  });

  it('is left alone when its source was kept', () => {
    const ops = [{ type: 'addTask', title: 'T', from: 'd', fromRecord: { type: 'decision', text: 'x' } }];
    expect(withoutDroppedSources(ops, [])).toBe(ops);
    expect(withoutDroppedSources(ops, [{ type: 'addRecord', ref: 'other' }])).toEqual(ops);
  });
});
