/**
 * A proposed task keeps the decision or rule it came from (#175), so a manager
 * sees why it is proposed: beside it in the proposal, on the page and in the
 * chat, and on the task once approved.
 */
import { describe, it, expect } from 'vitest';
import { withWhereFrom } from './task-wording.js';
import { describeChange } from './change-labels.js';
import { applyOps } from './ops.js';
import { makeRecord, makeWorkstream } from './test-fixtures/model.js';
import { reportBackContribute } from '../mcp/server.js';

const rule = { id: 'r1', type: 'rule', text: 'Every article gets a launch post', status: 'active' };
const task = (extra = {}) => ({ type: 'addTask', title: 'Write the launch post for article 1', ...extra });

describe('where a proposed task came from', () => {
  it('is an existing decision or rule, or one proposed with it, and its wording goes beside the task', () => {
    const decision = { type: 'addRecord', ref: 'd', record: { type: 'decision', text: 'Article 1 launches on Monday' } };
    const [, fromRule, fromNew] = withWhereFrom([decision, task({ from: 'r1' }), task({ from: 'd' })], [rule]);
    expect(fromRule).toMatchObject({ from: 'r1', fromRecord: { type: 'rule', text: 'Every article gets a launch post' } });
    expect(fromNew).toMatchObject({ from: 'd', fromRecord: { type: 'decision', text: 'Article 1 launches on Monday' } });
  });

  it('is let go when it names nothing, or something that is not a decision or rule, and the task is kept', () => {
    const assumption = { id: 'a1', type: 'assumption', text: 'Readers want it', status: 'active' };
    for (const from of ['nope', 'a1']) {
      const [t] = withWhereFrom([task({ from, fromRecord: { type: 'rule', text: 'made up' } })], [rule, assumption]);
      expect(t, from).toEqual(task());
    }
  });

  it('is said beside the task on the page and in the chat', () => {
    const op = withWhereFrom([task({ from: 'r1' })], [rule])[0];
    expect(describeChange(op)).toBe('Add a task: Write the launch post for article 1 (from Rule: "Every article gets a launch post")');
    expect(describeChange(task())).toBe('Add a task: Write the launch post for article 1');
    const said = reportBackContribute({ id: 'mcp-1', mode: 'queued', number: '1.1', workstream: 'article', summary: 's', operations: [op] });
    expect(said).toContain('"Write the launch post for article 1", from Rule: "Every article gets a launch post"');
  });

  it('stays on the task once approved, as the id of that record', () => {
    const ws = makeWorkstream('article', { records: [makeRecord({ id: 'r1', type: 'rule', text: rule.text })] });
    const { tree } = applyOps(ws, [
      { type: 'addRecord', ref: 'd', record: { type: 'decision', text: 'Article 1 launches on Monday' } },
      task({ from: 'r1' }), task({ title: 'Book the launch slot', from: 'd' }), task({ title: 'Tell the speakers', from: 'gone' }),
    ], 'c-1', { target: 'article', workstreamNumber: 1, nextKey: {} });
    const added = tree.records.find(r => r.text === 'Article 1 launches on Monday');
    expect(tree.tasks.map(t => [t.title, t.from])).toEqual([
      ['Write the launch post for article 1', 'r1'], ['Book the launch slot', added.id], ['Tell the speakers', undefined],
    ]);
  });
});
