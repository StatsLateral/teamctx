import { describe, it, expect, vi, beforeEach } from 'vitest';

const complete = vi.fn(async () => '{"summary":"s","operations":[]}');
vi.mock('./providers/index.js', () => ({
  getProvider: vi.fn(() => ({ complete })),
  knownProviderIds: () => ['anthropic'],
}));

import { proposeDiff } from './ai.js';

const workstream = { name: 'Ledger', records: [{ id: 'w1', type: 'decision', text: 'Existing why', status: 'active' }], tasks: [] };
const call = () => complete.mock.calls[0][0];

beforeEach(() => complete.mockClear());

describe('proposeDiff — contribution intent (the default)', () => {
  it('labels the input as a contribution', async () => {
    await proposeDiff({ workstream, contribution: 'we shipped X', source: 'alice', config: {} });
    expect(call().prompt).toContain('Contribution (source: alice)');
  });

  it('does not add the document guidance', async () => {
    // A typed update is deliberate — every sentence is signal, and telling the
    // model to discard "one-off details" would throw away the point.
    await proposeDiff({ workstream, contribution: 'we shipped X', source: 'alice', config: {} });
    expect(call().prompt).not.toMatch(/durable team/i);
    expect(call().system).toMatch(/single team contribution/);
  });
});

describe('proposeDiff — document intent', () => {
  const distill = (extra = {}) => proposeDiff({
    workstream, contribution: '# Heading\n\nprose', source: 'import:docs/a.md',
    config: {}, intent: 'document', ...extra,
  });

  it('labels the input as a document', async () => {
    await distill();
    expect(call().prompt).toContain('Document (source: import:docs/a.md)');
  });

  it('asks for durable context and warns off document structure', async () => {
    await distill();
    const { prompt, system } = call();
    expect(system).toMatch(/extract durable team context/i);
    expect(prompt).toMatch(/durable team/i);
    expect(prompt).toMatch(/Ignore document structure/i);
    expect(prompt).toMatch(/one-off details/i);
  });

  it('permits an empty answer, so a document with no context adds nothing', async () => {
    // Without this the model feels obliged to produce something from every file.
    await distill();
    expect(call().prompt).toMatch(/empty\s+operations array/i);
  });
});

describe('proposeDiff — avoid list', () => {
  it('is absent when nothing has been proposed yet', async () => {
    await proposeDiff({ workstream, contribution: 'x', source: 's', config: {}, intent: 'document' });
    expect(call().prompt).not.toMatch(/Already proposed/);
  });

  it('lists what earlier documents in the run already proposed', async () => {
    await proposeDiff({
      workstream, contribution: 'x', source: 's', config: {}, intent: 'document',
      avoid: ['Move billing off Stripe', 'Staff the ledger team'],
    });
    const { prompt } = call();
    expect(prompt).toMatch(/Already proposed earlier in this same import/);
    expect(prompt).toContain('- Move billing off Stripe');
    expect(prompt).toContain('- Staff the ledger team');
  });

  it('still shows the existing record, so both sources of duplication are covered', async () => {
    await proposeDiff({
      workstream, contribution: 'x', source: 's', config: {}, intent: 'document',
      avoid: ['Move billing off Stripe'],
    });
    expect(call().prompt).toContain('Existing why');
  });
});

describe('proposeDiff — governed operations', () => {
  it('asks for governed operations and gives the current ids and today', async () => {
    await proposeDiff({
      workstream: { id: 'food', name: 'Food', records: [{ id: 'rec-1', type: 'rule', text: 'No nuts', status: 'active' }], tasks: [] },
      contribution: 'Mum may use chocolate frosting on the adults cake until the party',
      source: 'Maya', config: {}, today: '2026-10-02',
    });
    const { prompt, system } = call();
    expect(prompt).toContain('"addRecord"');
    expect(prompt).toContain('exception');
    expect(prompt).toContain('rec-1');
    expect(prompt).toContain('Today is 2026-10-02');
    expect(`${system}\n${prompt}`).not.toMatch(/addWhy|addWhat|addHow|Why \/ What \/ How/);
  });

  it('never shows the model a record that is no longer active', async () => {
    await proposeDiff({
      workstream: { name: 'F', records: [{ id: 'rec-old', type: 'decision', text: 'Old plan', status: 'replaced' }], tasks: [] },
      contribution: 'x', source: 's', config: {}, today: '2026-10-02',
    });
    expect(call().prompt).not.toContain('Old plan');
  });
});

describe('proposeDiff — where records attach', () => {
  it('only asks for attachedTo when a record is about one task, never to put it on the project', async () => {
    await proposeDiff({ workstream: { id: 'food', name: 'Food', records: [], tasks: [] }, contribution: 'x', source: 's', config: {}, today: '2026-10-02' });
    const { prompt } = call();
    expect(prompt).not.toContain('"attachedTo": { "kind": "project" }');
    expect(prompt).toMatch(/attachedTo only when[\s\S]*specific task/);
  });
});

describe('proposeDiff — four kinds of record', () => {
  it('offers only decision, assumption, rule and exception, and puts reasons in detail', async () => {
    await proposeDiff({ workstream: { name: 'F', records: [], tasks: [] }, contribution: 'x', source: 's', config: {}, today: '2026-10-02' });
    const { prompt } = call();
    expect(prompt).toContain('"type": "decision|assumption|rule|exception"');
    expect(prompt).not.toMatch(/\bquestion = |\brisk = |\bwhy = /);
    expect(prompt).toMatch(/reason.*detail/i);
  });
});

/**
 * The distiller is told that re-confirming exists.
 *
 * It was not, and an end-to-end run is what found it. `applyOps` has accepted
 * `status: "active"` and stamped `reviewedAt` all along, and the unit tests for
 * it passed because they call `applyOps` directly. But the schema handed to the
 * distiller listed only `replaced|broken|closed`, so asked to re-confirm a
 * decision that still held, the AI replaced it with a copy of itself — the one
 * operation that is both wrong and plausible. Half of #120's "one way to
 * confirm" was unreachable in practice while every test passed.
 */
describe('re-confirming, in the schema the AI is given', () => {
  const prompt = async () => {
    await proposeDiff({ workstream, contribution: 'it still holds', source: 'alice', config: { model: 'm' } });
    return call().prompt;
  };

  it('offers active as a status it may set', async () => {
    expect(await prompt()).toContain('"replaced|broken|closed|active"');
  });

  it('says what setting an active record active again means', async () => {
    const p = await prompt();
    expect(p).toMatch(/already active back to active is how/i);
    expect(p).toMatch(/clears the "needs review" mark/i);
  });

  it('tells it not to replace a record with a copy of itself instead', async () => {
    // The exact thing it did before being told otherwise.
    expect(await prompt()).toMatch(/not.*replace a record with a copy of itself/is);
  });

  it('keeps broken for assumptions and replaced for decisions apart', async () => {
    expect(await prompt()).toMatch(/"broken" only for an assumption/i);
  });
});

/**
 * The model is told evidence exists, and when it applies.
 *
 * An operation the model is never shown is unreachable however correct the
 * server is — #120's re-confirmation was exactly that, found only by running it
 * end to end. So the schema and the guidance are both pinned here.
 */
describe('evidence against an assumption, in what the model is given', () => {
  const ws = {
    name: 'Ledger', tasks: [],
    records: [{ id: 'a1', type: 'assumption', text: 'Buyers need SSO before a pilot', status: 'active' }],
  };
  const prompt = async () => {
    await proposeDiff({ workstream: ws, contribution: 'note', source: 'alice', config: { model: 'm' } });
    return call().prompt;
  };

  it('offers addEvidence as an operation', async () => {
    expect(await prompt()).toContain('"type": "addEvidence"');
  });

  it('shows the assumptions it may be evidence against', async () => {
    const p = await prompt();
    expect(p).toContain('"type": "assumption"');
    expect(p).toContain('Buyers need SSO before a pilot');
  });

  it('asks for the evidence and the break together', async () => {
    expect(await prompt()).toMatch(/BOTH an addEvidence[\s\S]*AND a setRecordStatus "broken"/);
  });

  it('warns that the note will rarely name the assumption', async () => {
    // The case the issue is about: the evidence never says which belief it hits.
    expect(await prompt()).toMatch(/will rarely name the\s+assumption/);
  });

  it('rules out unrelated assumptions and mere mentions', async () => {
    const p = await prompt();
    expect(p).toMatch(/is not\s+evidence about hiring/);
    expect(p).toMatch(/without contradicting it is not/);
  });

  it('keeps who and when out of the model’s hands', async () => {
    expect(await prompt()).toMatch(/do\s+not say who said it or when/);
  });

  it('never asks for evidence on a decision or rule', async () => {
    expect(await prompt()).toMatch(/Never addEvidence on a decision, rule or exception/);
  });
});

describe('relying on an assumption is not evidence against it', () => {
  // Found in testing: "Because buyers need SSO before a pilot, we decided to
  // build SSO first" came back as evidence against that assumption plus a
  // break — the opposite of what it says — and "this rests on the assumption
  // that…" came back as nothing at all.
  const prompt = async () => {
    await proposeDiff({ workstream, contribution: 'note', source: 'alice', config: { model: 'm' } });
    return call().prompt;
  };

  it('says a contribution that relies on it records a decision resting on it', async () => {
    const p = await prompt();
    expect(p).toMatch(/Nor is a contribution that RELIES on the assumption/);
    expect(p).toMatch(/links\.restsOn naming the assumption, and no\s+addEvidence and no break/);
  });

  it('keeps the hands-off rule to a contribution that breaks one', async () => {
    const p = await prompt();
    expect(p).toMatch(/When you do propose a break, do not also edit/);
    expect(p).toMatch(/a new decision\s+that rests on an assumption is recorded as usual/);
  });
});

describe('proposeDiff — the shape of a goal', () => {
  it('asks for an outcome sentence and a reason, in plain words', async () => {
    await proposeDiff({ workstream, contribution: 'we want ten pilots', source: 'alice', config: {} });
    expect(call().prompt).toMatch(/one outcome sentence that names who or what changes, not how/);
    expect(call().prompt).toMatch(/does not restate the goal/);
    expect(call().prompt).toMatch(/no headings, bullets, hedging or marketing/);
  });

  it('tells the model to leave the reason out rather than invent one', async () => {
    await proposeDiff({ workstream, contribution: 'we want ten pilots', source: 'alice', config: {} });
    expect(call().prompt).toMatch(/leave "why" out rather than invent one/);
  });
});
