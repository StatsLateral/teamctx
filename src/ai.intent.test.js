import { describe, it, expect, vi, beforeEach } from 'vitest';

const complete = vi.fn(async () => '{"summary":"s","operations":[]}');
vi.mock('./providers/index.js', () => ({
  getProvider: vi.fn(() => ({ complete })),
  knownProviderIds: () => ['anthropic'],
}));

import { proposeDiff } from './ai.js';

const workstream = { name: 'Ledger', whys: [{ id: 'w1', text: 'Existing why', whats: [] }] };
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
