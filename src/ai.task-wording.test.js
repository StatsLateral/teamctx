/**
 * Tasks the distiller proposes read as work a person picks up (#175): what it
 * is asked for, and what is kept of its answer for sample briefs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const complete = vi.fn();
vi.mock('./providers/index.js', () => ({
  getProvider: vi.fn(() => ({ complete })),
  knownProviderIds: () => ['anthropic'],
}));

import { proposeDiff } from './ai.js';
import { taskTitleProblem } from './task-wording.js';

const rule = { id: 'r1', type: 'rule', text: 'Every article goes through scoring, ranking and drafting before it is posted', status: 'active' };
const workstream = { id: 'article-1', name: 'Article 1', records: [rule], tasks: [] };
const answer = (operations, contradictions = []) => complete.mockResolvedValueOnce(JSON.stringify({ summary: 's', contradictions, operations }));
const task = title => ({ type: 'addTask', title });
const distil = (contribution, extra = {}) => proposeDiff({ workstream, contribution, source: 'mcp', config: {}, ...extra });
const titles = r => r.operations.filter(o => o.type === 'addTask').map(o => o.title);

beforeEach(() => complete.mockReset());

describe('what the distiller is asked for a task', () => {
  it('is work a person picks up and finishes, starting with what they do, never a step for an assistant', async () => {
    answer([]);
    await distil('Brief for article 1');
    const { prompt } = complete.mock.calls[0][0];
    expect(prompt).toMatch(/one piece of work a person picks up and finishes/);
    expect(prompt).toMatch(/starts with what they do and names the thing/);
    expect(prompt).toMatch(/never a step in an assistant’s or an AI’s process, never addressed to an assistant/);
    expect(prompt).toMatch(/rule that describes how work is done .* do not turn its steps into tasks/);
    expect(prompt).toMatch(/"owner": "who will do it, only if the input names them"/);
  });

  it('is none when the input says it is only source material or says not to make tasks', async () => {
    answer([]);
    await distil('x');
    expect(complete.mock.calls[0][0].prompt).toMatch(/says it is only source material, or says not to make tasks, propose no addTask/);
  });
});

describe('the tasks kept from a sample brief', () => {
  it('an editorial-workflow brief keeps only the tasks a person picks up', async () => {
    answer([
      { type: 'addRecord', record: { type: 'decision', text: 'Article 1 is about ticket pricing' } },
      task('Score and rank the content atoms you extracted'),
      task('Drafting native posts for the top atoms'),
      task('Write the launch post for article 1'),
      task('Ask Maya for the speaker quotes'),
    ]);
    const r = await distil('Brief for article 1: ticket pricing. Maya has the speaker quotes.');
    expect(titles(r)).toEqual(['Write the launch post for article 1', 'Ask Maya for the speaker quotes']);
    for (const t of titles(r)) expect(taskTitleProblem(t)).toBeNull();
    expect(r.operations[0].type).toBe('addRecord');
  });

  it('a brief that says it is source material keeps no task, whatever came back', async () => {
    for (const said of ['This is source material only, for later articles.', "Background notes. Don't create any tasks from this."]) {
      answer([{ type: 'addRecord', record: { type: 'decision', text: 'Prices rise in March' } }, task('Write the launch post for article 1')]);
      const r = await distil(said);
      expect(titles(r), said).toEqual([]);
      expect(r.operations).toHaveLength(1);
    }
  });

  it('a contradiction still points at its own operation after a task before it is dropped', async () => {
    answer([
      task('The atoms, ranked'),
      { type: 'addRecord', record: { type: 'rule', text: 'Articles are posted without scoring' } },
    ], [{ operationIndex: 1, recordId: 'r1', workstream: 'article-1' }]);
    const r = await distil('We stop scoring articles.');
    expect(r.operations).toHaveLength(1);
    expect(r.contradictions).toEqual([expect.objectContaining({ operationIndex: 0, record: expect.objectContaining({ id: 'r1' }) })]);
  });

  it('leaves operations it was only asked to check exactly as they were', async () => {
    const ops = [task('The atoms, ranked')];
    answer(ops);
    const r = await distil('This is source material only.', { operationsToCheck: ops });
    expect(r.operations).toBe(ops);
  });
});

describe('a contradiction that points at nothing', () => {
  it('is still refused when it points at a task that was dropped', async () => {
    answer([task('The atoms, ranked'), { type: 'addRecord', record: { type: 'rule', text: 'Articles are posted without scoring' } }],
      [{ operationIndex: 0, recordId: 'r1', workstream: 'article-1' }]);
    await expect(distil('We stop scoring articles.')).rejects.toThrow(/unknown record or operation/);
  });
});

describe('where a task came from, in what the distiller is asked and gives back', () => {
  it('asks for the decision or rule a task comes from, and puts its wording beside the task', async () => {
    answer([task('Write the launch post for article 1')].map(t => ({ ...t, from: 'r1' })));
    const r = await distil('Brief for article 1');
    expect(complete.mock.calls[0][0].prompt).toMatch(/"from": "<id or ref of the decision or rule it comes from>"/);
    expect(complete.mock.calls[0][0].prompt).toMatch(/When a task comes from a decision or rule, existing or proposed here, name it in from/);
    expect(r.operations[0]).toMatchObject({ from: 'r1', fromRecord: { type: 'rule', text: rule.text } });
  });
});
