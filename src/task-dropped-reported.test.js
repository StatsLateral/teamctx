/**
 * A task the wording check leaves out is named in what was left out (#175), so
 * one that was real work has a way back in.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./ai.js', async original => ({
  ...(await original()),
  proposeDiff: vi.fn(async () => ({
    summary: 'Venue booked',
    operations: [{ type: 'addTask', title: 'Book the venue for the March meetup' }],
    dropped: [{ reason: 'left out the task "Reviewing the venues": it does not start with what a person does' }],
  })),
}));

const { updateShared } = await import('./context.js');
const { makeWorkstream } = await import('./test-fixtures/model.js');

describe('a task the wording check left out', () => {
  it('is reported with the other things left out, and the kept task stays', async () => {
    const r = await updateShared(makeWorkstream('venue'), { id: 'c-1', text: 'notes', author: 'Satyagya' }, { model: 'm', nextKey: {}, workstreams: [{ id: 'venue', number: 1, name: 'Venue' }] });
    expect(r.dropped.map(d => d.reason)).toEqual(['left out the task "Reviewing the venues": it does not start with what a person does']);
    expect(r.operations).toEqual([expect.objectContaining({ type: 'addTask', title: 'Book the venue for the March meetup' })]);
  });
});
