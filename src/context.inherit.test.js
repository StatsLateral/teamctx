import { describe, it, expect } from 'vitest';
import { serializeToMd } from './context.js';

const why = (text, whats = []) => ({ id: text.slice(0, 4), text, whats });
const what = (text, hows = []) => ({ id: text.slice(0, 4), text, hows });

const PROJECT = { name: 'Ledger', whys: [why('ship the ledger by Q3', [what('agree the schema')])] };
const WORKSTREAM = { id: 'engineering', name: 'Engineering', whys: [why('build the importer')] };

const md = (ws, opts) => serializeToMd(ws, 'Ledger', '', [], opts);

describe('a workstream compiled with the project above it', () => {
  it('shows the project tree first, then its own', () => {
    const out = md(WORKSTREAM, { project: PROJECT });
    expect(out.indexOf('ship the ledger by Q3')).toBeLessThan(out.indexOf('build the importer'));
  });

  it('marks the inherited half read-only', () => {
    // The line a reader needs to tell what they may add to from what is settled
    // above them. Without it the first move is an edit to somebody else's tree.
    expect(md(WORKSTREAM, { project: PROJECT })).toContain('read-only');
  });

  it('names the workstream where its own context starts', () => {
    expect(md(WORKSTREAM, { project: PROJECT })).toContain('### Engineering');
  });

  it('carries the whole inherited tree, not just its whys', () => {
    expect(md(WORKSTREAM, { project: PROJECT })).toContain('agree the schema');
  });
});

describe('what does not change', () => {
  it('renders exactly as before when no project is passed', () => {
    const out = md(WORKSTREAM);
    expect(out).toContain('build the importer');
    expect(out).not.toContain('read-only');
    expect(out).not.toContain('### Engineering');
  });

  it('says "no context yet" only when both halves are empty', () => {
    const bare = { id: 'engineering', name: 'Engineering', whys: [] };
    expect(md(bare)).toContain('No context yet');
    expect(md(bare, { project: { whys: [] } })).toContain('No context yet');
  });

  it('does not call a workstream empty when it inherits something', () => {
    // The case that would otherwise regress: a member joins a fresh workstream
    // on an established project and is told the project knows nothing.
    const bare = { id: 'engineering', name: 'Engineering', whys: [] };
    const out = md(bare, { project: PROJECT });
    expect(out).not.toContain('No context yet');
    expect(out).toContain('ship the ledger by Q3');
  });

  it('leaves an unnamed workstream a usable heading', () => {
    const out = md({ id: 'x', whys: [why('do the thing')] }, { project: PROJECT });
    expect(out).toContain('### This workstream');
  });
});
