/**
 * The rule: nobody is brought onto an empty project.
 *
 * A member reads two trees — the project's context with their own workstream's
 * beneath it — so both halves are checked, and a project-wide member has only
 * the first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./storage.js', () => ({
  readProject: vi.fn(),
  readWorkstream: vi.fn(),
}));

const { assertJoinableContext, EmptyContextError } = await import('./context-gate.js');
const { readProject, readWorkstream } = await import('./storage.js');

const FULL = { name: 'Ledger', whys: [{ id: 'w1', text: 'ship it', whats: [] }] };
const EMPTY = { name: 'Ledger', whys: [] };

const config = {
  project: 'Ledger',
  workstreams: [{ id: 'delivery', name: 'Delivery' }, { id: 'docs', name: 'Documentation' }],
};

const call = (over = {}) => assertJoinableContext({ config, who: 'Priya', teamctxDir: '/x', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  readProject.mockReturnValue(FULL);
  readWorkstream.mockReturnValue(FULL);
});

describe('a project with nothing written in it', () => {
  beforeEach(() => readProject.mockReturnValue(EMPTY));

  it('refuses, whoever is being added', () => {
    expect(() => call()).toThrow(EmptyContextError);
  });

  it('refuses a scoped member too, without looking at the workstream', () => {
    // The project half is missing either way, and reporting the workstream
    // would send the manager to fix the wrong thing first.
    expect(() => call({ scope: ['delivery'] })).toThrow(/This project has nothing written down/);
    expect(readWorkstream).not.toHaveBeenCalled();
  });

  it('says what to do next, and names the person', () => {
    expect(() => call()).toThrow(/Tell me what it's about and I'll add it, then we can bring Priya on/);
  });

  it('carries which half was empty, for a caller that wants to act on it', () => {
    try { call(); } catch (err) {
      expect(err.code).toBe('EMPTY_CONTEXT');
      expect(err.scope).toBe('project');
      expect(err.workstream).toBe(null);
    }
    expect.assertions(3);
  });
});

describe('a workstream with nothing of its own', () => {
  beforeEach(() => {
    readWorkstream.mockImplementation(id => (id === 'docs' ? EMPTY : FULL));
  });

  it('refuses even though the project is full', () => {
    expect(() => call({ scope: ['docs'] })).toThrow(EmptyContextError);
  });

  it('names the workstream the way a person would say it', () => {
    expect(() => call({ scope: ['docs'] })).toThrow(/"Documentation" has nothing written down/);
  });

  it('falls back to the id when the workstream is not named in config', () => {
    // On disk but not in the config list. `member add` rejects an unknown id
    // before this runs, so the id is all there is to say.
    readWorkstream.mockReturnValue(EMPTY);
    expect(() => call({ scope: ['finance'] })).toThrow(/"finance" has nothing written down/);
  });

  it('fails the whole call rather than adding them to the good one', () => {
    // A member scoped to less than the manager asked for is a worse failure
    // than a refusal: nobody finds out until they cannot see something.
    expect(() => call({ scope: ['delivery', 'docs'] })).toThrow(/"Documentation"/);
  });

  it('carries the id of the empty one', () => {
    try { call({ scope: ['docs'] }); } catch (err) {
      expect(err.scope).toBe('workstream');
      expect(err.workstream).toBe('docs');
    }
    expect.assertions(2);
  });
});

describe('when there is something to read', () => {
  it('allows a project-wide member', () => {
    expect(() => call()).not.toThrow();
  });

  it('allows a project-wide member on a project with no workstreams at all', () => {
    expect(() => call({ config: { project: 'Ledger' } })).not.toThrow();
    expect(readWorkstream).not.toHaveBeenCalled();
  });

  it('allows a scoped member when every workstream has its own', () => {
    expect(() => call({ scope: ['delivery', 'docs'] })).not.toThrow();
  });

  it('checks a workstream by id against the right directory', () => {
    call({ scope: ['delivery'] });
    expect(readWorkstream).toHaveBeenCalledWith('delivery', '/x');
  });
});

describe('what counts as something to read', () => {
  it('one Why is enough', () => {
    readProject.mockReturnValue({ whys: [{ id: 'w1', text: 'ship it' }] });
    expect(() => call()).not.toThrow();
  });

  it('a tree with no whys key at all is empty', () => {
    readProject.mockReturnValue({ name: 'Ledger' });
    expect(() => call()).toThrow(EmptyContextError);
  });

  it('says "them" when nobody was named', () => {
    readProject.mockReturnValue(EMPTY);
    expect(() => assertJoinableContext({ config, teamctxDir: '/x' })).toThrow(/bring them on/);
  });
});
