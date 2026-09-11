/**
 * Which Whys become workstreams and how people are placed in each are one
 * decision. These check that the proposal answers both in one pass, reads from
 * the project tree, and writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readProject: vi.fn(),
  readTree: vi.fn(() => ({ name: 'p', whys: [] })),
  readWorkstream: vi.fn(() => ({ id: 'x', name: 'X', whys: [] })),
  writeWorkstream: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  listWorkstreamIds: vi.fn(() => []),
  writeRoleFile: vi.fn(),
  readContributions: vi.fn(() => []),
}));
vi.mock('../../src/context.js', () => ({
  proposeSubworkstreams: vi.fn(),
  serializeToMd: vi.fn(() => '# md'),
  generateRoleFile: vi.fn(async () => '# role'),
}));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => ({ key: 'k', name: 'Ada' })) }));
vi.mock('../../src/prefs.js', () => ({
  resolveActiveWorkstream: vi.fn(async () => null),
  writePrefs: vi.fn(),
}));

const { proposeStructure } = await import('./workstream.core.js');
const { readConfig, readProject, writeConfig, writeWorkstream } = await import('../../src/storage.js');
const { proposeSubworkstreams } = await import('../../src/context.js');

const TREE = {
  name: 'Ledger',
  whys: [
    { id: 'w1', text: 'ship to three customers', whats: [] },
    { id: 'w2', text: 'keep the importer honest', whats: [] },
    { id: 'w3', text: 'stay inside the budget', whats: [] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue({ project: 'Ledger', roles: [] });
  readProject.mockReturnValue(TREE);
  proposeSubworkstreams.mockResolvedValue({
    splits: [{
      name: 'Delivery', rationale: 'customer-facing commitments', whyIds: ['w1'],
      membership: { model: 'workstream-position', rationale: 'open-ended judgement' },
    }],
    leftover: ['w2', 'w3'],
  });
});

describe('proposing how a project is structured', () => {
  it('reads the project tree, not a workstream', async () => {
    // After the project layer, "a project tree and no workstreams" is the
    // ordinary state — and the one where this is most useful.
    await proposeStructure({ teamctxDir: '/x' });
    expect(readProject).toHaveBeenCalledWith('/x');
    expect(proposeSubworkstreams.mock.calls[0][0]).toBe(TREE);
  });

  it('returns the membership model alongside each proposed workstream', async () => {
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams[0].membership.model).toBe('workstream-position');
    expect(r.workstreams[0].membership.rationale).toBe('open-ended judgement');
  });

  it('says what the model means in words a manager would use', async () => {
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams[0].membership.means).toMatch(/owns the workstream/);
    expect(r.workstreams[0].membership.means).not.toMatch(/workstream-position/);
  });

  it('hands back the Why nodes, not only their ids', async () => {
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams[0].whys[0].text).toBe('ship to three customers');
    expect(r.leftover.map(w => w.id)).toEqual(['w2', 'w3']);
  });

  it('writes nothing at all', async () => {
    // A split moves Whys; this also implies who works where. Applying a wrong
    // guess silently would put people the wrong side of a boundary #77 enforces.
    await proposeStructure({ teamctxDir: '/x' });
    expect(writeConfig).not.toHaveBeenCalled();
    expect(writeWorkstream).not.toHaveBeenCalled();
  });
});

describe('a project with nothing in it yet', () => {
  it('says so instead of proposing a structure for nothing', async () => {
    readProject.mockReturnValue({ name: 'Ledger', whys: [] });
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams).toEqual([]);
    expect(r.why).toMatch(/no context yet/i);
    expect(proposeSubworkstreams).not.toHaveBeenCalled();
  });

  it('asks for the context in plain words, with no teamctx vocabulary', async () => {
    readProject.mockReturnValue({ name: 'Ledger', whys: [] });
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.why).not.toMatch(/workstream|why-tree|contribution/i);
  });
});

describe('a membership model the AI invented', () => {
  it('falls back to the narrowest rather than passing it on', async () => {
    proposeSubworkstreams.mockResolvedValue({
      splits: [{ name: 'Delivery', rationale: '', whyIds: ['w1'], membership: { model: 'owner', rationale: '' } }],
      leftover: [],
    });
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams[0].membership.model).toBe('assigned-tasks');
  });
});

describe('roles come back in the same call', () => {
  // The issue asks for one "propose how this project is structured" call rather
  // than a third suggest surface. Two round trips would also mean the roles were
  // proposed against a workstream the split had not yet made.
  beforeEach(() => {
    proposeSubworkstreams.mockResolvedValue({
      splits: [{
        name: 'Delivery', rationale: 'customer commitments', whyIds: ['w1'],
        membership: { model: 'named-role', rationale: 'ongoing ownership' },
        roles: [
          { name: 'Delivery Lead', responsibilities: 'owns the rollout', excludes: 'infrastructure cost' },
          { name: '', responsibilities: 'nameless', excludes: '' },
        ],
      }],
      leftover: [],
    });
  });

  it('attaches the suggested roles to the workstream they belong to', async () => {
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams[0].roles.map(x => x.name)).toEqual(['Delivery Lead']);
  });

  it('keeps what makes a role useful, not just its name', async () => {
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams[0].roles[0]).toMatchObject({
      responsibilities: 'owns the rollout',
      excludes: 'infrastructure cost',
    });
  });

  it('creates none of them', async () => {
    // `role_add` is still what creates a role, and it cannot run until the
    // workstream a role binds to exists.
    await proposeStructure({ teamctxDir: '/x' });
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('gives a workstream with no suggested roles an empty list, not undefined', async () => {
    proposeSubworkstreams.mockResolvedValue({
      splits: [{ name: 'Delivery', rationale: '', whyIds: ['w1'], membership: { model: 'assigned-tasks' } }],
      leftover: [],
    });
    const r = await proposeStructure({ teamctxDir: '/x' });
    expect(r.workstreams[0].roles).toEqual([]);
  });
});
