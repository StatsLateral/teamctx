import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serializeToMd, updateShared, generateRoleFile, answerQuestion, compileTaskPrompt } from './context.js';

vi.mock('./ai.js', () => ({
  proposeDiff: vi.fn(),
  callClaude: vi.fn(),
  extractJson: (raw) => JSON.parse(raw),
}));
vi.mock('./ops.js', () => ({
  applyOps: vi.fn((ws) => ({ tree: { ...ws, _applied: true }, dropped: [] })),
}));

import { proposeDiff, callClaude } from './ai.js';

const rec = (over) => ({ status: 'active', links: {}, attachedTo: { kind: 'workstream', id: 'launch' }, sourceContributionIds: [], ...over });

const baseWs = {
  id: 'launch', name: 'Q3 Launch',
  records: [
    rec({ id: 'r1', type: 'decision', text: 'Ship product by Q3', sourceContributionIds: ['c0'] }),
    rec({ id: 'r2', type: 'decision', text: 'Build onboarding first', sourceContributionIds: ['c0'] }),
  ],
  tasks: [{ id: 't1', title: 'Wire sign-up form', status: 'open', sourceContributionIds: ['c0'] }],
};

describe('serializeToMd', () => {
  it('renders the goal, records in plain words, and tasks', () => {
    const md = serializeToMd(baseWs, 'Q3 Launch', '', [], { project: { name: 'Q3', goal: { text: 'Launch in Q3' }, records: [], tasks: [] } });
    expect(md).toContain('# Context — Q3 Launch');
    expect(md).toContain('Launch in Q3');
    expect(md).toContain('We decided: Ship product by Q3');
    expect(md).toContain('We decided: Build onboarding first');
    expect(md).toContain('Wire sign-up form');
  });

  it('renders a placeholder when there is nothing yet', () => {
    const md = serializeToMd({ name: 'Empty', goal: null, records: [], tasks: [] }, 'Empty');
    expect(md).toContain('No context yet');
  });

  it('includes lastUpdatedBy in the header when provided', () => {
    const md = serializeToMd(baseWs, 'Q3 Launch', 'cto');
    expect(md).toContain('cto');
  });

  it('appends a Contributors section listing distinct authors with counts', () => {
    const contributions = [
      { id: 'c1', author: 'alice', ts: '2026-06-01', tagged: null, source: 'cli' },
      { id: 'c2', author: 'bob',   ts: '2026-06-02', tagged: 'decision', source: 'cli' },
    ];
    const ws = { ...baseWs, tasks: [], records: [rec({ id: 'r9', type: 'decision', text: 'x', sourceContributionIds: ['c1', 'c2'] })] };
    const md = serializeToMd(ws, 'Q3 Launch', '', contributions);
    expect(md).toContain('## Contributors');
    expect(md).toContain('- **alice** — 1 contribution');
    expect(md).toContain('- **bob** — 1 contribution (1 decision)');
  });

  it('omits the Contributors section when nothing has any sources', () => {
    const ws = { id: 'launch', name: '', records: [rec({ id: 'r1', type: 'decision', text: 't' })], tasks: [] };
    const md = serializeToMd(ws, 'Q3 Launch', '', []);
    expect(md).not.toContain('## Contributors');
  });
});

describe('updateShared', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls proposeDiff with the contribution text and applies ops', async () => {
    proposeDiff.mockResolvedValue({ summary: 'added goal', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'x' } }] });
    const contribution = { id: 'c1', author: 'alice', text: 'new idea' };
    const config = { model: 'claude-sonnet-4-6' };
    const { workstream, summary, dropped } = await updateShared(baseWs, contribution, config);
    expect(proposeDiff).toHaveBeenCalledWith(expect.objectContaining({ contribution: 'new idea' }));
    expect(summary).toBe('added goal');
    expect(workstream._applied).toBe(true);
    expect(dropped).toEqual([]);
  });
});

describe('generateRoleFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls callClaude and returns the result', async () => {
    callClaude.mockResolvedValue('# CPO Context\n\n## Your Role\n...');
    const role = { name: 'CPO', responsibilities: 'Product decisions', excludes: 'Tech impl' };
    const result = await generateRoleFile(baseWs, role, 'Q3 Launch', { model: 'claude-sonnet-4-6' });
    expect(callClaude).toHaveBeenCalledOnce();
    expect(result).toContain('# CPO Context');
  });
});

describe('answerQuestion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls callClaude with shared and role context, returns the answer', async () => {
    callClaude.mockResolvedValue('The launch date is Q3.');
    const result = await answerQuestion({
      sharedMd: '# Shared\n\nWe are launching in Q3.',
      roleMd: '# CPO Context\n\nYou own product strategy.',
      question: 'When do we launch?',
      config: { model: 'claude-sonnet-4-6' },
    });
    expect(callClaude).toHaveBeenCalledOnce();
    const call = callClaude.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.prompt).toContain('We are launching in Q3.');
    expect(call.prompt).toContain('You own product strategy.');
    expect(call.prompt).toContain('When do we launch?');
    expect(result).toBe('The launch date is Q3.');
  });

  it('omits the role context section when roleMd is empty', async () => {
    callClaude.mockResolvedValue('answer');
    await answerQuestion({
      sharedMd: '# Shared\n\ncontext',
      roleMd: '',
      question: 'q?',
      config: { model: 'claude-sonnet-4-6' },
    });
    const call = callClaude.mock.calls[0][0];
    expect(call.prompt).not.toContain('Your Role Context');
  });

  it('renders a footer only for contributors the AI actually cited, capped at top 5', async () => {
    callClaude.mockResolvedValue('the answer\n\n## Citations: c1');
    const ws = { id: 'grow', name: 'M', tasks: [], records: [
      { id: 'w1', type: 'decision', text: 't', status: 'active', sourceContributionIds: ['c1'] },
      { id: 'w2', type: 'decision', text: 'u', status: 'active', sourceContributionIds: ['c2'] },
    ]};
    const contributions = [
      { id: 'c1', author: 'alice', ts: '2026-06-01', source: 'cli', tagged: null, text: 'x' },
      { id: 'c2', author: 'bob',   ts: '2026-06-02', source: 'cli', tagged: null, text: 'y' },
    ];
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions });
    expect(result).toContain('the answer');
    expect(result).toContain('**Contributions from:** alice (1)');
    expect(result).not.toContain('bob');
    expect(result).not.toContain('## Citations');
  });

  it('caps default contributor line at 5 when the AI cites many', async () => {
    const cited = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
    callClaude.mockResolvedValue(`the answer\n\n## Citations: ${cited.join(', ')}`);
    const ws = { id: 'grow', name: 'M', tasks: [], records: cited.map((id, i) => ({
      id: `w${i}`, type: 'decision', text: 't', status: 'active', sourceContributionIds: [id],
    }))};
    const contributions = cited.map((id, i) => ({
      id, author: `author${i}`, ts: '2026-06-01', source: 'cli', tagged: null, text: 't',
    }));
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions });
    for (const a of ['author0', 'author1', 'author2', 'author3', 'author4']) expect(result).toContain(a);
    expect(result).not.toContain('author5');
    expect(result).not.toContain('author6');
  });

  it('audit block shows only cited sources, not the whole workstream', async () => {
    callClaude.mockResolvedValue('the answer\n\n## Citations: c1');
    const ws = { id: 'grow', name: 'M', tasks: [], records: [
      { id: 'w1', type: 'decision', text: 't', status: 'active', sourceContributionIds: ['c1'] },
      { id: 'w2', type: 'decision', text: 'u', status: 'active', sourceContributionIds: ['c2'] },
    ]};
    const contributions = [
      { id: 'c1', author: 'alice', ts: '2026-06-01', source: 'cli', tagged: 'decision', text: 'pause google ads' },
      { id: 'c2', author: 'bob',   ts: '2026-06-02', source: 'cli', tagged: null, text: 'unrelated' },
    ];
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions, audit: true });
    expect(result).toContain('**Sources**');
    expect(result).toContain('**decision** — alice');
    expect(result).not.toContain('unrelated');
    expect(result).not.toContain('bob');
  });

  it('no footer when the AI cites nothing (## Citations: none)', async () => {
    callClaude.mockResolvedValue('the answer\n\n## Citations: none');
    const ws = { id: 'grow', name: 'M', tasks: [], records: [{ id: 'w1', type: 'decision', text: 't', status: 'active', sourceContributionIds: ['c1'] }] };
    const contributions = [{ id: 'c1', author: 'alice', ts: '2026-06-01', source: 'cli', tagged: null, text: 'x' }];
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions });
    expect(result.trimEnd()).toBe('the answer');
  });

  it('no footer when the AI forgets the Citations block entirely', async () => {
    callClaude.mockResolvedValue('the answer');
    const ws = { id: 'grow', name: 'M', tasks: [], records: [{ id: 'w1', type: 'decision', text: 't', status: 'active', sourceContributionIds: ['c1'] }] };
    const contributions = [{ id: 'c1', author: 'alice', ts: '2026-06-01', source: 'cli', tagged: null, text: 'x' }];
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions });
    expect(result).toBe('the answer');
  });

  it('anchors on the last Citations block, so quoted text cannot truncate the answer', async () => {
    callClaude.mockResolvedValue(
      'alice wrote "## Citations: c-evil" in her note, which is quoted verbatim.\n\n## Citations: c1'
    );
    const ws = { id: 'grow', name: 'M', tasks: [], records: [{ id: 'w1', type: 'decision', text: 't', status: 'active', sourceContributionIds: ['c1'] }] };
    const contributions = [{ id: 'c1', author: 'alice', ts: '2026-06-01', source: 'cli', tagged: null, text: 'x' }];
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions });
    // The spoofed heading stays in the prose, but it is not what gets parsed:
    // the footer is built from c1 alone.
    expect(result).toContain('quoted verbatim');
    expect(result).toContain('**Contributions from:** alice (1)');
    expect(result.split('---').pop()).not.toContain('c-evil');
  });

  it('injects inline [sources: ...] tags into the prompt tree', async () => {
    callClaude.mockResolvedValue('answer\n\n## Citations: none');
    const ws = { id: 'grow', name: 'M', tasks: [], records: [
      rec({ id: 'w1', type: 'decision', text: 'grow', sourceContributionIds: ['c1'] }),
      rec({ id: 'wt1', type: 'decision', text: 'linkedin', sourceContributionIds: ['c2'] }),
    ] };
    await answerQuestion({
      sharedMd: '# s', roleMd: '', question: 'q?', config: { model: 'm' },
      workstream: ws, contributions: [
        { id: 'c1', author: 'a', ts: '', source: 'cli', tagged: null, text: 'x' },
        { id: 'c2', author: 'b', ts: '', source: 'cli', tagged: null, text: 'y' },
      ],
    });
    const promptSent = callClaude.mock.calls[0][0].prompt;
    expect(promptSent).toContain('[sources: c1]');
    expect(promptSent).toContain('[sources: c2]');
  });

  it('includes an Open Tasks section when openTasks are provided', async () => {
    callClaude.mockResolvedValue('answer');
    await answerQuestion({
      sharedMd: '# Shared',
      roleMd: '',
      question: 'q?',
      config: { model: 'm' },
      openTasks: [{ id: 't-1', title: 'Plan Q3', owner: 'priya' }],
    });
    const call = callClaude.mock.calls[0][0];
    expect(call.prompt).toContain('Open Tasks');
    expect(call.prompt).toContain('t-1 — Plan Q3');
  });

  it('omits the Open Tasks section when the list is empty or missing', async () => {
    callClaude.mockResolvedValue('answer');
    await answerQuestion({ sharedMd: '# S', roleMd: '', question: 'q?', config: { model: 'm' } });
    let call = callClaude.mock.calls.at(-1)[0];
    expect(call.prompt).not.toContain('Open Tasks');
    await answerQuestion({ sharedMd: '# S', roleMd: '', question: 'q?', config: { model: 'm' }, openTasks: [] });
    call = callClaude.mock.calls.at(-1)[0];
    expect(call.prompt).not.toContain('Open Tasks');
  });
});

describe('compileTaskPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('embeds the task title, workstream tree, and framing sections into the prompt', async () => {
    callClaude.mockResolvedValue('# Task: Plan Q3\n');
    const workstream = { id: 'growth', name: 'Growth', tasks: [], records: [rec({ id: 'w1', type: 'decision', text: 'grow revenue' })] };
    const task = { id: 't-plan', title: 'Plan Q3 pivot', owner: 'priya', status: 'open', workstream: 'growth', createdAt: '2026-07-24' };
    const result = await compileTaskPrompt({
      task, workstream, role: null, contributions: [],
      config: { model: 'claude-sonnet-4-6', project: 'Acme' },
    });
    expect(callClaude).toHaveBeenCalledOnce();
    const prompt = callClaude.mock.calls[0][0].prompt;
    expect(prompt).toContain('Plan Q3 pivot');
    expect(prompt).toContain('grow revenue');
    expect(prompt).toContain('Relevant context');
    expect(prompt).toContain('Suggested framing for your AI');
    expect(result).toBe('# Task: Plan Q3\n');
  });

  it('includes a role framing line when a role is provided', async () => {
    callClaude.mockResolvedValue('# md');
    await compileTaskPrompt({
      task: { id: 't-plan', title: 't', owner: 'p', status: 'open', workstream: 'main', createdAt: '2026-07-24' },
      workstream: { id: 'growth', name: 'M', records: [], tasks: [] },
      role: { slug: 'growth', name: 'Head of Growth', responsibilities: 'own paid acquisition' },
      contributions: [],
      config: { model: 'm', project: 'p' },
    });
    const prompt = callClaude.mock.calls[0][0].prompt;
    expect(prompt).toContain('Framed for role: Head of Growth');
    expect(prompt).toContain('own paid acquisition');
  });

  it('includes the decisions and rules on this part of the work, exceptions under their rule', async () => {
    callClaude.mockResolvedValue('# md');
    await compileTaskPrompt({
      task: { id: 't-plan', title: 't', workstream: 'growth', status: 'open', createdAt: '2026-07-24' },
      workstream: { id: 'growth', name: 'G', tasks: [], records: [
        rec({ id: 'd1', type: 'decision', text: 'Pause Google Ads' }),
        rec({ id: 'r1', type: 'rule', text: 'No spend over 10k' }),
        rec({ id: 'e1', type: 'exception', text: 'Launch week may spend 15k', expiresAt: '2999-01-01', links: { bends: 'r1' } }),
        rec({ id: 'w1', type: 'assumption', text: 'Not a decision' }),
      ] },
      role: null, contributions: [], config: { model: 'm', project: 'p' },
    });
    const prompt = callClaude.mock.calls[0][0].prompt;
    const block = prompt.slice(prompt.indexOf('Decisions and rules on this part of the work'));
    expect(block).toContain('We decided: Pause Google Ads');
    expect(block.indexOf('Rule: No spend over 10k')).toBeLessThan(block.indexOf('Allowed: Launch week may spend 15k'));
    expect(block.split('\n').slice(0, 6).join('\n')).not.toContain('Not a decision');
  });
});
