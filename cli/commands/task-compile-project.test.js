/**
 * Compiling a task that sits on the project.
 *
 * The default case after the migration: every open task on a project that never
 * split folds to project level, and new ones land there too. The compiled
 * prompt passed the project tree as the inherited half of a tree that already
 * *was* the project, so the model was handed every Why twice — the second copy
 * under a "read-only here" heading that means nothing on the thing it came
 * from. This checks the prompt the model actually receives, which is what the
 * earlier tests mocked away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/ai.js', () => ({
  callClaude: vi.fn(async () => '# compiled'),
  extractJson: vi.fn(),
  getFastModelFor: vi.fn(() => 'm'),
}));

const { compileTaskPrompt } = await import('../../src/context.js');
const { callClaude } = await import('../../src/ai.js');

const PROJECT = {
  name: 'Ledger',
  whys: [{ id: 'p1', text: 'ship the ledger', whats: [{ id: 'a1', text: 'invoicing', hows: [] }] }],
};
const WORKSTREAM = {
  id: 'delivery', name: 'Delivery',
  whys: [{ id: 'w1', text: 'onboard three customers', whats: [] }],
};
const config = { project: 'Ledger', model: 'm' };

const promptSent = () => callClaude.mock.calls[0][0].prompt;
const occurrences = (text, needle) => text.split(needle).length - 1;

beforeEach(() => vi.clearAllMocks());

describe('a task at project level', () => {
  const task = { id: 't1', title: 'book the venue', status: 'open', workstream: null };

  it('sends each Why once', async () => {
    await compileTaskPrompt({ task, workstream: PROJECT, role: null, contributions: [], config, project: null });
    expect(occurrences(promptSent(), 'ship the ledger')).toBe(1);
  });

  it('does not label the project as inherited from itself', async () => {
    await compileTaskPrompt({ task, workstream: PROJECT, role: null, contributions: [], config, project: null });
    expect(promptSent()).not.toMatch(/Inherited from the project/);
  });

  it('would duplicate if the project were passed as both halves', async () => {
    // The bug, pinned: this is what the call used to do unconditionally.
    await compileTaskPrompt({ task, workstream: PROJECT, role: null, contributions: [], config, project: PROJECT });
    expect(occurrences(promptSent(), 'ship the ledger')).toBe(2);
  });
});

describe('a task inside a workstream', () => {
  const task = { id: 't2', title: 'draft the email', status: 'open', workstream: 'delivery' };

  it('still gets the project tree above the workstream', async () => {
    await compileTaskPrompt({ task, workstream: WORKSTREAM, role: null, contributions: [], config, project: PROJECT });
    const prompt = promptSent();
    expect(prompt).toMatch(/Inherited from the project/);
    expect(occurrences(prompt, 'ship the ledger')).toBe(1);
    expect(occurrences(prompt, 'onboard three customers')).toBe(1);
  });
});
