/**
 * What an assistant is told about the project, a workstream, or a task.
 *
 * The properties that matter are the ones a reader would be hurt by losing: the
 * path down to a workstream is carried in order, nothing from a sibling is, an
 * exception is never separated from the rule it bends, and a part the reader
 * cannot see is never named.
 */
import { describe, it, expect } from 'vitest';
import { drawerPrompts, connectedPrompt, contextGroups } from './prompts.js';
import { makeRecord, makeTask } from './test-fixtures/model.js';

const ON = '2026-10-02';
const rule = makeRecord({ id: 'rec-rule', type: 'rule', text: 'No discounts over 15%', attachedTo: { kind: 'workstream', id: 'pricing' } });
const exc = makeRecord({ id: 'rec-exc', type: 'exception', text: 'Acme may get 20%', expiresAt: '2026-12-31', links: { bends: 'rec-rule' } });

const view = (over = {}) => ({
  project: 'Northwind', owner: 'acme', repo: 'gtm',
  projectTree: { goal: { text: 'Open four health systems', why: 'Cold outreach fails' }, records: [makeRecord({ id: 'rec-p', text: 'Fixed price for pilots' })], tasks: [] },
  trees: {
    launch: { id: 'launch', records: [makeRecord({ id: 'rec-l', text: 'Launch in October' })], tasks: [makeTask({ key: '1.1', title: 'Draft the post' })] },
    pricing: { id: 'pricing', records: [rule, exc], tasks: [makeTask({ key: '2.1', title: 'Quote tiers' })] },
    support: { id: 'support', records: [makeRecord({ id: 'rec-s', text: 'Support is email only' })], tasks: [] },
  },
  workstreams: [
    { id: 'launch', number: 1, name: 'Launch', parent: null },
    { id: 'pricing', number: 2, name: 'Pricing', parent: 'launch' },
    { id: 'support', number: 3, name: 'Support', parent: null },
  ],
  tasks: { open: [{ id: 't1', workstream: 'pricing' }, { id: 't2', workstream: 'pricing' }, { id: 't3', workstream: 'launch' }], done: [] },
  hiddenParts: 0,
  ...over,
});

describe('the connected (short) prompt', () => {
  const p = connectedPrompt({ owner: 'acme', repo: 'gtm', subject: 'workstream 2 (Pricing)', scope: 'workstream 2 (Pricing) and the project context it inherits' });

  it('tells the assistant to check it is on the right project, then fetch the context itself', () => {
    expect(p).toContain('connected to the repository acme/gtm');
    expect(p).toContain('get_connect_url');
    expect(p).toContain('stop and tell me');
    expect(p).toContain('fetch the current approved context');
  });

  it('keeps to the one part, and carries no context of its own', () => {
    expect(p).toContain('Keep to workstream 2 (Pricing)');
    expect(p).not.toContain('Fixed price');
  });
});

describe('the project prompt', () => {
  const { project } = drawerPrompts({ view: view(), onDay: ON });

  it('has the goal, why it matters and the project-level records', () => {
    expect(project.full).toContain('Open four health systems');
    expect(project.full).toContain('Why it matters: Cold outreach fails');
    expect(project.full).toContain('We decided: Fixed price for pilots');
  });

  it('indexes every workstream, with what is in each, and says to ask for more', () => {
    expect(project.full).toContain('## Not loaded here');
    expect(project.full).toContain('- 1 Launch — 1 active record, 1 open task');
    expect(project.full).toContain('- 2 Pricing — 2 active records, 2 open tasks');
    expect(project.full).toContain('Ask for more through the connector');
  });

  it('does not load a workstream\'s own records', () => {
    expect(project.full).not.toContain('Launch in October');
    expect(project.full).not.toContain('No discounts over 15%');
  });
});

describe('a workstream prompt', () => {
  const { ws } = drawerPrompts({ view: view(), onDay: ON });

  it('carries the project, then each part on the path down, outermost first', () => {
    const t = ws.pricing.full;
    expect(t.indexOf('Fixed price for pilots')).toBeLessThan(t.indexOf('Launch in October'));
    expect(t.indexOf('Launch in October')).toBeLessThan(t.indexOf('No discounts over 15%'));
    expect(t).toContain('## 1 Launch');
    expect(t).toContain('## 2 Pricing');
  });

  it('loads nothing from a sibling', () => {
    expect(ws.pricing.full).not.toContain('Support is email only');
    expect(ws.launch.full).not.toContain('No discounts over 15%');
  });

  it('puts an exception under the rule it bends, in words', () => {
    const t = ws.pricing.full;
    expect(t.indexOf('Rule: No discounts over 15%')).toBeLessThan(t.indexOf('Allowed: Acme may get 20%'));
    expect(t).toContain('instead of: No discounts over 15%');
  });

  it('indexes the parts it did not load, and not itself or its path', () => {
    const t = ws.pricing.full.slice(ws.pricing.full.indexOf('## Not loaded here'));
    expect(t).toContain('- 3 Support — 1 active record, 0 open tasks');
    expect(t).not.toContain('Launch —');
    expect(t).not.toContain('Pricing —');
  });

  it('is told which part it is about', () => {
    expect(ws.pricing.short).toContain('Tell me about workstream 2 (Pricing).');
    expect(ws.pricing.full).toContain('approved context for workstream 2 (Pricing)');
  });

  it('carries no internal id, no record number and no letter key', () => {
    for (const text of [ws.pricing.full, ws.pricing.short, ws.launch.full, drawerPrompts({ view: view(), onDay: ON }).project.full]) {
      expect(text).not.toMatch(/\brec-[0-9a-f-]+|\b[TDRAXQ]-\d+\b/);
    }
  });
});

describe('what a reader may not see', () => {
  it('leaves a part out of the path and the index, and says only how many there are', () => {
    // The reader is on Pricing but cannot see Launch, its parent, or Support.
    const scoped = view({
      trees: { pricing: view().trees.pricing },
      workstreams: [{ id: 'pricing', number: 2, name: 'Pricing', parent: 'launch' }],
      hiddenParts: 2,
    });
    const { ws } = drawerPrompts({ view: scoped, onDay: ON });
    const t = ws.pricing.full;
    expect(t).toContain('No discounts over 15%');
    expect(t).not.toContain('Launch in October');
    expect(t).not.toContain('Launch');
    expect(t).not.toContain('Support');
    expect(t).toContain('- 2 parts you cannot see');
  });

  it('says "1 part", not "1 parts"', () => {
    const { project } = drawerPrompts({ view: view({ hiddenParts: 1 }), onDay: ON });
    expect(project.full).toContain('- 1 part you cannot see');
  });

  it('prints no index at all when there is nothing to list', () => {
    const only = view({ workstreams: [], trees: {}, tasks: { open: [], done: [] } });
    expect(drawerPrompts({ view: only, onDay: ON }).project.full).not.toContain('Not loaded here');
  });

  it('leaves out records that are no longer active', () => {
    const v = view();
    v.trees.pricing.records = [...v.trees.pricing.records, makeRecord({ text: 'Old price list', status: 'replaced' })];
    expect(drawerPrompts({ view: v, onDay: ON }).ws.pricing.full).not.toContain('Old price list');
  });

  it('says so when a decision rests on something that broke', () => {
    const v = view();
    v.trees.pricing.records = [...v.trees.pricing.records, makeRecord({ id: 'rec-f', text: 'Price annually', needsReview: 'needs review — rests on a broken assumption' })];
    expect(drawerPrompts({ view: v, onDay: ON }).ws.pricing.full).toMatch(/Price annually.*needs review/);
  });
});

describe('the context in plain English', () => {
  const groups = contextGroups([
    makeRecord({ id: 'd', type: 'decision', text: 'Annual plans' }),
    makeRecord({ id: 'a', type: 'assumption', text: 'Buyers want SSO', reviewBy: '2026-12-01' }),
    rule, exc,
    makeRecord({ id: 'x2', type: 'exception', text: 'Orphan exception', links: { bends: 'gone' } }),
    makeRecord({ id: 'old', type: 'decision', text: 'Retired', status: 'closed' }),
  ], ON);

  it('groups what was decided, the rules and what is being assumed', () => {
    expect(groups.decided.map(d => d.text)).toEqual(['Annual plans']);
    expect(groups.assuming.map(a => a.text)).toEqual(['Buyers want SSO']);
    expect(groups.rules.map(r => r.text)).toEqual(['No discounts over 15%']);
  });

  it('keeps an exception under the rule it bends, and drops one whose rule is not there', () => {
    expect(groups.rules[0].exceptions.map(e => e.text)).toEqual(['Acme may get 20%']);
    expect(JSON.stringify(groups)).not.toContain('Orphan exception');
  });

  it('leaves out what is no longer active', () => {
    expect(JSON.stringify(groups)).not.toContain('Retired');
  });

  it('is only wording: no ids or numbers', () => {
    expect(JSON.stringify(groups)).not.toMatch(/rec-|"key"/);
  });
});
