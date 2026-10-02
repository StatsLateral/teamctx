import { describe, it, expect } from 'vitest';
import { serializeToMd } from './context.js';

const rec = (id, type, text) => ({ id, type, text, status: 'active', attachedTo: { kind: 'project' }, links: {} });

const PROJECT = {
  name: 'Ledger', goal: { text: 'ship the ledger by Q3' },
  records: [rec('p1', 'decision', 'agree the schema')], tasks: [],
};
const WORKSTREAM = { id: 'engineering', name: 'Engineering', records: [rec('w1', 'why', 'build the importer')], tasks: [] };

const md = (ws, opts) => serializeToMd(ws, 'Ledger', '', [], opts);

describe('a workstream compiled with the project above it', () => {
  it('shows the project first, then its own', () => {
    const out = md(WORKSTREAM, { project: PROJECT });
    expect(out.indexOf('ship the ledger by Q3')).toBeLessThan(out.indexOf('build the importer'));
  });

  it('marks the inherited half read-only', () => {
    // The line a reader needs to tell what they may add to from what is settled
    // above them. Without it the first move is an edit to somebody else's context.
    expect(md(WORKSTREAM, { project: PROJECT })).toMatch(/Project context.*read-only/);
  });

  it('names the workstream where its own context starts', () => {
    expect(md(WORKSTREAM, { project: PROJECT })).toContain('## Engineering');
  });

  it('carries everything the project relies on, not just its goal', () => {
    expect(md(WORKSTREAM, { project: PROJECT })).toContain('We decided: agree the schema');
  });
});

describe('what does not change', () => {
  it('renders the project alone, with no inherited label, when nothing is above it', () => {
    const out = md(PROJECT, {});
    expect(out).toContain('ship the ledger by Q3');
    expect(out).not.toContain('read-only');
  });

  it('says "no context yet" only when both halves are empty', () => {
    const empty = { name: 'Ledger', goal: null, records: [], tasks: [] };
    expect(md({ id: 'e', name: 'E', records: [], tasks: [] }, { project: empty })).toContain('No context yet');
  });

  it('does not call a workstream empty when it inherits something', () => {
    expect(md({ id: 'e', name: 'E', records: [], tasks: [] }, { project: PROJECT })).not.toContain('No context yet');
  });

  it('leaves an unnamed workstream a usable heading', () => {
    expect(md({ id: 'eng', name: '', records: [], tasks: [] }, { project: PROJECT })).toContain('## eng');
  });
});
