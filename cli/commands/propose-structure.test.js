/**
 * `proposeStructure` drafts how a project could be organised in the governed
 * model — goal, whys, parts of the work, tasks, records and how people fit —
 * and writes nothing. Applying a draft is a separate act (#124).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readProject: vi.fn(),
  readTree: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'x', name: 'X', records: [], tasks: [] })),
  writeWorkstream: vi.fn(),
  writeTree: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  listWorkstreamIds: vi.fn(() => []),
  writeRoleFile: vi.fn(),
  readContributions: vi.fn(() => []),
}));
vi.mock('../../src/ai.js', () => ({
  callClaude: vi.fn(),
  extractJson: (raw) => JSON.parse(raw),
}));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => ({ key: 'k', name: 'Ada' })) }));
vi.mock('../../src/prefs.js', () => ({ resolveActiveWorkstream: vi.fn(async () => null), writePrefs: vi.fn() }));

const { proposeStructure } = await import('./workstream.core.js');
const { readConfig, readProject, readContributions, writeConfig, writeWorkstream, writeTree } = await import('../../src/storage.js');
const { callClaude } = await import('../../src/ai.js');

const PROJECT = {
  name: 'Party', goal: { text: "Leo's first birthday" },
  records: [{ id: 'r1', type: 'rule', text: 'No nuts', status: 'active' }], tasks: [],
};
const DRAFT = {
  goal: "A relaxed first birthday",
  whys: ['Family first'],
  workstreams: [
    { name: 'Food & cake', parent: null, rationale: 'one person bakes', tasks: ['Bake the cake'],
      records: [{ type: 'decision', text: 'Banana cake' }, { type: 'fact', text: 'dropped' }],
      membership: { model: 'workstream-position', rationale: 'Mum owns it' } },
    { name: 'Cake', parent: 'Food & cake', tasks: [], records: [], membership: { model: 'nonsense' } },
    { name: '', tasks: ['nameless'] },
  ],
  questions: ['Invite the daycare friends?'],
};

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue({ project: 'Party', roles: [], workstreams: [] });
  readProject.mockReturnValue(PROJECT);
  readContributions.mockReturnValue([{ id: 'c1', text: 'planning notes' }]);
});

describe('proposeStructure', () => {
  it('sends the current goal, records and contributions, and asks for the governed draft', async () => {
    callClaude.mockResolvedValueOnce(JSON.stringify(DRAFT));
    await proposeStructure({});
    const { prompt } = callClaude.mock.calls[0][0];
    expect(prompt).toContain("Leo's first birthday");
    expect(prompt).toContain('No nuts');
    expect(prompt).toContain('planning notes');
    expect(prompt).not.toMatch(/whyIds|Why \/ What \/ How/);
  });

  it('returns a cleaned draft: valid record types only, nameless parts dropped, membership normalised', async () => {
    callClaude.mockResolvedValueOnce(JSON.stringify(DRAFT));
    const r = await proposeStructure({});
    expect(r.goal).toBe('A relaxed first birthday');
    expect(r.whys).toEqual(['Family first']);
    expect(r.workstreams.map(w => w.name)).toEqual(['Food & cake', 'Cake']);
    expect(r.workstreams[0].records).toEqual([{ type: 'decision', text: 'Banana cake' }]);
    expect(r.workstreams[0].tasks).toEqual(['Bake the cake']);
    expect(r.workstreams[1].parent).toBe('Food & cake');
    expect(typeof r.workstreams[1].membership.means).toBe('string');
    expect(r.questions).toEqual(['Invite the daycare friends?']);
  });

  it('writes nothing', async () => {
    callClaude.mockResolvedValueOnce(JSON.stringify(DRAFT));
    await proposeStructure({});
    expect(writeConfig).not.toHaveBeenCalled();
    expect(writeWorkstream).not.toHaveBeenCalled();
    expect(writeTree).not.toHaveBeenCalled();
  });

  it('says so instead of guessing when there is nothing to organise', async () => {
    readProject.mockReturnValue({ name: 'Party', goal: null, records: [], tasks: [] });
    readContributions.mockReturnValue([]);
    const r = await proposeStructure({});
    expect(callClaude).not.toHaveBeenCalled();
    expect(r.workstreams).toEqual([]);
    expect(r.why).toMatch(/no context yet/i);
  });
});
