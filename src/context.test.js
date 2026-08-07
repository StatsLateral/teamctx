import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serializeToMd, updateShared, generateRoleFile, answerQuestion, proposeSubworkstreams, normalizeSubworkstreamProposal, compileTaskPrompt } from './context.js';

vi.mock('./ai.js', () => ({
  proposeDiff: vi.fn(),
  callClaude: vi.fn(),
  extractJson: (raw) => JSON.parse(raw),
}));
vi.mock('./ops.js', () => ({
  applyOps: vi.fn((ws) => ({ ...ws, _applied: true })),
}));

import { proposeDiff, callClaude } from './ai.js';

const baseWs = {
  id: 'main', name: 'Q3 Launch',
  whys: [{
    id: 'w1', text: 'Ship product by Q3', sourceContributionIds: ['c0'], summary: '',
    whats: [{
      id: 'w1-wh1', text: 'Build onboarding', sourceContributionIds: ['c0'], summary: '',
      hows: [{ id: 'w1-wh1-h1', text: 'Wire sign-up form', sourceContributionIds: ['c0'], summary: '' }],
    }],
  }],
};

describe('serializeToMd', () => {
  it('renders the Why/What/How tree', () => {
    const md = serializeToMd(baseWs, 'Q3 Launch');
    expect(md).toContain('# Project Context — Q3 Launch');
    expect(md).toContain('**Why:** Ship product by Q3');
    expect(md).toContain('**What:** Build onboarding');
    expect(md).toContain('**How:** Wire sign-up form');
  });

  it('renders placeholder when whys is empty', () => {
    const md = serializeToMd({ ...baseWs, whys: [] }, 'Empty');
    expect(md).toContain('No context yet');
  });

  it('includes lastUpdatedBy in the header when provided', () => {
    const md = serializeToMd(baseWs, 'Q3 Launch', 'cto');
    expect(md).toContain('cto');
  });

  it('renders a decision marker on nodes backed by a decision contribution', () => {
    const contributions = [
      { id: 'c0', ts: '2026-06-20T10:00:00.000Z', author: 'alice', text: 'x', tagged: null, source: 'cli' },
      { id: 'cD', ts: '2026-06-30T12:00:00.000Z', author: 'sam', text: 'chose postgres', tagged: 'decision', source: 'cli' },
    ];
    const ws = {
      ...baseWs,
      whys: [{
        ...baseWs.whys[0],
        whats: [{
          ...baseWs.whys[0].whats[0],
          sourceContributionIds: ['c0', 'cD'],
        }],
      }],
    };
    const md = serializeToMd(ws, 'Q3 Launch', '', contributions);
    expect(md).toContain('*[decision — sam, 2026-06-30, via cli]*');
    expect(md).not.toMatch(/Ship product by Q3.*\*\[decision/);
  });

  it('renders nothing extra when no decision contribution is linked', () => {
    const contributions = [{ id: 'c0', ts: '2026-06-20T10:00:00.000Z', author: 'alice', tagged: null }];
    const md = serializeToMd(baseWs, 'Q3 Launch', '', contributions);
    expect(md).not.toContain('[decision');
  });

  it('picks the latest decision when a node has multiple decision-tagged sources', () => {
    const contributions = [
      { id: 'd1', ts: '2026-06-10T00:00:00.000Z', author: 'alice', tagged: 'decision', source: 'cli' },
      { id: 'd2', ts: '2026-07-01T00:00:00.000Z', author: 'sam', tagged: 'decision', source: 'web' },
    ];
    const ws = {
      ...baseWs,
      whys: [{ ...baseWs.whys[0], sourceContributionIds: ['d1', 'd2'], whats: [] }],
    };
    const md = serializeToMd(ws, 'Q3 Launch', '', contributions);
    expect(md).toContain('*[decision — sam, 2026-07-01, via web]*');
    expect(md).not.toContain('*[decision — alice');
  });

  it('appends a Contributors section listing distinct authors with counts', () => {
    const contributions = [
      { id: 'c1', author: 'alice', ts: '2026-06-01', tagged: null, source: 'cli' },
      { id: 'c2', author: 'bob',   ts: '2026-06-02', tagged: 'decision', source: 'cli' },
    ];
    const ws = { ...baseWs, whys: [{ ...baseWs.whys[0], sourceContributionIds: ['c1', 'c2'], whats: [] }] };
    const md = serializeToMd(ws, 'Q3 Launch', '', contributions);
    expect(md).toContain('## Contributors');
    expect(md).toContain('- **alice** — 1 contribution');
    expect(md).toContain('- **bob** — 1 contribution (1 decision)');
  });

  it('omits the Contributors section when no node has any sources', () => {
    const ws = { id: 'main', name: '', whys: [{ id: 'w1', text: 't', sourceContributionIds: [], whats: [] }] };
    const md = serializeToMd(ws, 'Q3 Launch', '', []);
    expect(md).not.toContain('## Contributors');
  });

  it('defaults missing source to cli for backward compatibility', () => {
    const contributions = [
      { id: 'dold', ts: '2026-05-01T00:00:00.000Z', author: 'sam', tagged: 'decision' },
    ];
    const ws = {
      ...baseWs,
      whys: [{ ...baseWs.whys[0], sourceContributionIds: ['dold'], whats: [] }],
    };
    const md = serializeToMd(ws, 'Q3 Launch', '', contributions);
    expect(md).toContain('via cli');
  });
});

describe('updateShared', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls proposeDiff with the contribution text and applies ops', async () => {
    proposeDiff.mockResolvedValue({ summary: 'added goal', operations: [{ type: 'addWhy', text: 'x', summary: '' }] });
    const contribution = { id: 'c1', author: 'alice', text: 'new idea' };
    const config = { model: 'claude-sonnet-4-6' };
    const { workstream, summary } = await updateShared(baseWs, contribution, config);
    expect(proposeDiff).toHaveBeenCalledWith(expect.objectContaining({ contribution: 'new idea' }));
    expect(summary).toBe('added goal');
    expect(workstream._applied).toBe(true);
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

describe('proposeSubworkstreams', () => {
  beforeEach(() => vi.clearAllMocks());

  const wsWithFive = {
    id: 'main', name: 'Demo',
    whys: [
      { id: 'w1', text: 'Ship product Q3', whats: [] },
      { id: 'w2', text: 'Reach 100 customers', whats: [] },
      { id: 'w3', text: 'Migrate to microservices', whats: [] },
      { id: 'w4', text: 'Cut infra cost', whats: [] },
      { id: 'w5', text: 'Standalone', whats: [] },
    ],
  };

  it('returns empty splits when fewer than 2 whys exist without calling the model', async () => {
    const ws = { id: 'main', name: 'X', whys: [{ id: 'w1', text: 'only', whats: [] }] };
    const result = await proposeSubworkstreams(ws, { model: 'claude-sonnet-4-6', project: 'X' });
    expect(callClaude).not.toHaveBeenCalled();
    expect(result.splits).toEqual([]);
    expect(result.leftover).toEqual(['w1']);
  });

  it('parses splits from the model and enforces disjoint whyIds', async () => {
    callClaude.mockResolvedValue(JSON.stringify({
      splits: [
        { name: 'Product', rationale: 'commercial goals', whyIds: ['w1', 'w2'] },
        { name: 'Tech', rationale: 'engineering', whyIds: ['w3', 'w4'] },
      ],
      leftover: ['w5'],
    }));

    const result = await proposeSubworkstreams(wsWithFive, { model: 'claude-sonnet-4-6', project: 'Demo' });
    expect(result.splits).toHaveLength(2);
    expect(result.splits[0]).toMatchObject({ name: 'Product', whyIds: ['w1', 'w2'] });
    expect(result.splits[1]).toMatchObject({ name: 'Tech', whyIds: ['w3', 'w4'] });
    expect(result.leftover).toEqual(['w5']);
  });

  it('drops duplicate whyIds across splits (keeps only the first occurrence)', () => {
    const parsed = {
      splits: [
        { name: 'A', rationale: '', whyIds: ['w1', 'w2'] },
        { name: 'B', rationale: '', whyIds: ['w2', 'w3'] },
      ],
      leftover: [],
    };
    const normalized = normalizeSubworkstreamProposal(parsed, wsWithFive.whys);
    expect(normalized.splits[0].whyIds).toEqual(['w1', 'w2']);
    expect(normalized.splits[1].whyIds).toEqual(['w3']);
  });

  it('drops splits that become empty after filtering unknown ids', () => {
    const parsed = {
      splits: [
        { name: 'Ghost', rationale: '', whyIds: ['unknown-1', 'unknown-2'] },
        { name: 'Real', rationale: '', whyIds: ['w1'] },
      ],
      leftover: [],
    };
    const normalized = normalizeSubworkstreamProposal(parsed, wsWithFive.whys);
    expect(normalized.splits).toHaveLength(1);
    expect(normalized.splits[0].name).toBe('Real');
  });

  it('recomputes leftover from whys not claimed by any split', () => {
    const parsed = {
      splits: [{ name: 'Product', rationale: '', whyIds: ['w1', 'w2'] }],
      leftover: [],
    };
    const normalized = normalizeSubworkstreamProposal(parsed, wsWithFive.whys);
    expect(normalized.leftover).toEqual(['w3', 'w4', 'w5']);
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
    const ws = { id: 'main', name: 'M', whys: [
      { id: 'w1', text: 't', sourceContributionIds: ['c1'], whats: [] },
      { id: 'w2', text: 'u', sourceContributionIds: ['c2'], whats: [] },
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
    const ws = { id: 'main', name: 'M', whys: cited.map((id, i) => ({
      id: `w${i}`, text: 't', sourceContributionIds: [id], whats: [],
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
    const ws = { id: 'main', name: 'M', whys: [
      { id: 'w1', text: 't', sourceContributionIds: ['c1'], whats: [] },
      { id: 'w2', text: 'u', sourceContributionIds: ['c2'], whats: [] },
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
    const ws = { id: 'main', name: 'M', whys: [{ id: 'w1', text: 't', sourceContributionIds: ['c1'], whats: [] }] };
    const contributions = [{ id: 'c1', author: 'alice', ts: '2026-06-01', source: 'cli', tagged: null, text: 'x' }];
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions });
    expect(result.trimEnd()).toBe('the answer');
  });

  it('no footer when the AI forgets the Citations block entirely', async () => {
    callClaude.mockResolvedValue('the answer');
    const ws = { id: 'main', name: 'M', whys: [{ id: 'w1', text: 't', sourceContributionIds: ['c1'], whats: [] }] };
    const contributions = [{ id: 'c1', author: 'alice', ts: '2026-06-01', source: 'cli', tagged: null, text: 'x' }];
    const result = await answerQuestion({ sharedMd: '# s', roleMd: '', question: 'q', config: { model: 'm' }, workstream: ws, contributions });
    expect(result).toBe('the answer');
  });

  it('anchors on the last Citations block, so quoted text cannot truncate the answer', async () => {
    callClaude.mockResolvedValue(
      'alice wrote "## Citations: c-evil" in her note, which is quoted verbatim.\n\n## Citations: c1'
    );
    const ws = { id: 'main', name: 'M', whys: [{ id: 'w1', text: 't', sourceContributionIds: ['c1'], whats: [] }] };
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
    const ws = { id: 'main', name: 'M', whys: [
      { id: 'w1', text: 'grow', sourceContributionIds: ['c1'], whats: [
        { id: 'wt1', text: 'linkedin', sourceContributionIds: ['c2'], hows: [] },
      ]},
    ]};
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
    const workstream = { id: 'growth', name: 'Growth', whys: [{ id: 'w1', text: 'grow revenue', whats: [] }] };
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
      workstream: { id: 'main', name: 'M', whys: [] },
      role: { slug: 'growth', name: 'Head of Growth', responsibilities: 'own paid acquisition' },
      contributions: [],
      config: { model: 'm', project: 'p' },
    });
    const prompt = callClaude.mock.calls[0][0].prompt;
    expect(prompt).toContain('Framed for role: Head of Growth');
    expect(prompt).toContain('own paid acquisition');
  });

  it('includes recent decisions on the same workstream', async () => {
    callClaude.mockResolvedValue('# md');
    await compileTaskPrompt({
      task: { id: 't-plan', title: 't', workstream: 'growth', status: 'open', createdAt: '2026-07-24' },
      workstream: { id: 'growth', name: 'G', whys: [] },
      role: null,
      contributions: [
        { text: 'Pause Google Ads', author: 'priya', ts: '2026-06-14T10:00:00Z', source: 'cli', tagged: 'decision', workstream: 'growth' },
        { text: 'Should be ignored', author: 'x', ts: '2026-06-15', source: 'cli', tagged: 'decision', workstream: 'main' },
      ],
      config: { model: 'm', project: 'p' },
    });
    const prompt = callClaude.mock.calls[0][0].prompt;
    expect(prompt).toContain('Pause Google Ads');
    expect(prompt).not.toContain('Should be ignored');
  });
});
