/**
 * A founding contribution carries the goal and the first tasks together. The
 * half that belongs to the other tree is kept for the caller to route, not
 * dropped here.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./ai.js', async original => ({
  ...(await original()),
  proposeDiff: vi.fn(async () => ({
    summary: 'The trip',
    operations: [
      { type: 'setGoal', text: 'Four adults see Vietnam in December' },
      { type: 'addTask', title: 'Book the Ha Long Bay cruise' },
    ],
  })),
}));

const { updateShared } = await import('./context.js');
const { makeWorkstream } = await import('./test-fixtures/model.js');

const config = { model: 'm', nextKey: {}, workstreams: [{ id: 'trip', number: 1, name: 'Trip' }] };
const contribution = { id: 'c-1', text: 'the trip', author: 'Satyagya' };

describe('the goal of a founding contribution sent to a workstream', () => {
  it('is kept for the caller to move to the project', async () => {
    const r = await updateShared(makeWorkstream('trip'), contribution, config, { founding: true });
    expect(r.operations.map(o => o.type)).toEqual(['setGoal', 'addTask']);
    expect(r.dropped).toEqual([]);
  });

  it('is dropped as before for any other contribution', async () => {
    const r = await updateShared(makeWorkstream('trip'), contribution, config);
    expect(r.operations.map(o => o.type)).toEqual(['addTask']);
    expect(r.dropped.map(d => d.reason)).toEqual(['the goal belongs to the project, not to a workstream']);
  });
});
