/**
 * Splitting the project itself.
 *
 * After the project layer this is the ordinary case: a project has one tree
 * and no workstreams, and the first split is what creates one. The split used
 * to read and write through `readWorkstream`, which at project level meant a
 * workstream whose id was the string "null" — so a valid proposal could not be
 * accepted at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'x', name: 'X', whys: [] })),
  readTree: vi.fn(),
  writeTree: vi.fn(),
  writeTreeMd: vi.fn(),
  readProject: vi.fn(() => ({ name: 'Ledger', whys: [] })),
  writeWorkstream: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  listWorkstreamIds: vi.fn(() => []),
  writeRoleFile: vi.fn(),
  readContributions: vi.fn(() => []),
}));
vi.mock('../../src/context.js', () => ({
  proposeSubworkstreams: vi.fn(async () => ({ splits: [], leftover: [] })),
  serializeToMd: vi.fn(() => '# md'),
  generateRoleFile: vi.fn(async () => '# role'),
}));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => ({ key: 'k', name: 'Ada' })) }));
vi.mock('../../src/prefs.js', () => ({
  resolveActiveWorkstream: vi.fn(async () => null),
  writePrefs: vi.fn(),
}));

const { splitWorkstreams, suggestWorkstreamSplits } = await import('./workstream.core.js');
const {
  readConfig, readTree, writeTree, writeTreeMd, writeWorkstream, writeWorkstreamMd,
  readProject, readWorkstream, writeConfig,
} = await import('../../src/storage.js');
const { serializeToMd, generateRoleFile, proposeSubworkstreams } = await import('../../src/context.js');
const { resolveActiveWorkstream } = await import('../../src/prefs.js');

const TREE = {
  name: 'Ledger',
  whys: [
    { id: 'w1', text: 'ship to three customers', whats: [] },
    { id: 'w2', text: 'keep the importer honest', whats: [] },
  ],
};

const accepted = [{ name: 'Delivery', whyIds: ['w1'] }];

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue({ project: 'Ledger', roles: [], workstreams: [] });
  readTree.mockReturnValue(TREE);
  readProject.mockReturnValue(TREE);
  resolveActiveWorkstream.mockResolvedValue(null);
});

describe('splitting when the caller is at project level', () => {
  it('reads the project tree rather than a workstream', async () => {
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    expect(readTree).toHaveBeenCalledWith(null, '/x');
    expect(readWorkstream).not.toHaveBeenCalled();
  });

  it('creates the workstream with the Whys that moved', async () => {
    const r = await splitWorkstreams({ accepted, teamctxDir: '/x' });
    expect(writeWorkstream).toHaveBeenCalledWith('delivery',
      expect.objectContaining({ id: 'delivery', whys: [TREE.whys[0]] }), '/x');
    expect(r.results[0].movedWhyCount).toBe(1);
  });

  it('writes the shortened source back to the project, not to a workstream file', async () => {
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    expect(writeTree).toHaveBeenCalledWith(null, expect.objectContaining({ whys: [TREE.whys[1]] }), '/x');
    expect(writeWorkstream).not.toHaveBeenCalledWith(null, expect.anything(), '/x');
  });

  it('recompiles the project page rather than a workstream page', async () => {
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    expect(writeTreeMd).toHaveBeenCalledWith(null, expect.any(String), '/x');
    expect(writeWorkstreamMd).not.toHaveBeenCalledWith(null, expect.anything(), '/x');
  });

  it('titles the project page with the project name, not the word null', async () => {
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    const sourceCall = serializeToMd.mock.calls.find(c => c[1] === 'Ledger');
    expect(sourceCall).toBeTruthy();
  });

  it('gives the new workstream the project as its inherited half', async () => {
    // And the project as it stands *after* the move: a Why that is both
    // inherited and owned would be printed twice in one file.
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    const newCall = serializeToMd.mock.calls.find(c => c[0]?.id === 'delivery');
    expect(newCall[4].project.whys.map(w => w.id)).toEqual(['w2']);
  });

  it('refuses in words that name the project when there is too little to split', async () => {
    readTree.mockReturnValue({ name: 'Ledger', whys: [TREE.whys[0]] });
    await expect(splitWorkstreams({ accepted, teamctxDir: '/x' }))
      .rejects.toThrow(/Ledger has fewer than 2 Why nodes/);
  });
});

describe('roles when the project is the source', () => {
  beforeEach(() => {
    readConfig.mockReturnValue({
      project: 'Ledger', workstreams: [],
      roles: [{ slug: 'ops', name: 'Ops', workstream: null }],
    });
  });

  it('does not hand a project-level role the project again as inheritance', async () => {
    // Its own tree *is* the project tree; passing it as the inherited half
    // would render every Why twice.
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    const call = generateRoleFile.mock.calls.find(c => c[1].slug === 'ops');
    expect(call[5]?.project).toBeUndefined();
  });

  it('moves a role onto the new workstream when asked, with the project above it', async () => {
    await splitWorkstreams({
      accepted: [{ name: 'Delivery', whyIds: ['w1'], moveRoles: ['ops'] }], teamctxDir: '/x',
    });
    const call = generateRoleFile.mock.calls.find(c => c[0]?.id === 'delivery');
    expect(call[5].project.whys.map(w => w.id)).toEqual(['w2']);
    expect(writeConfig.mock.calls[0][0].roles[0].workstream).toBe('delivery');
  });
});

describe('a workstream is still splittable', () => {
  beforeEach(() => {
    resolveActiveWorkstream.mockResolvedValue('engineering');
    readConfig.mockReturnValue({
      project: 'Ledger', roles: [],
      workstreams: [{ id: 'engineering', name: 'Engineering' }],
    });
  });

  it('reads and writes that workstream, and names it in the refusal', async () => {
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    expect(readTree).toHaveBeenCalledWith('engineering', '/x');
    expect(writeTree).toHaveBeenCalledWith('engineering', expect.anything(), '/x');

    readTree.mockReturnValue({ name: 'Engineering', whys: [TREE.whys[0]] });
    await expect(splitWorkstreams({ accepted, teamctxDir: '/x' }))
      .rejects.toThrow(/engineering has fewer than 2 Why nodes/);
  });

  it('gives the new workstream the project tree to inherit', async () => {
    readProject.mockReturnValue({ name: 'Ledger', whys: [{ id: 'p1', text: 'no new vendors', whats: [] }] });
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    const newCall = serializeToMd.mock.calls.find(c => c[0]?.id === 'delivery');
    expect(newCall[4].project.whys.map(w => w.id)).toEqual(['p1']);
  });
});

describe('proposing a split at project level', () => {
  it('analyses the project tree, which is where the Whys are', async () => {
    await suggestWorkstreamSplits({ teamctxDir: '/x' });
    expect(readTree).toHaveBeenCalledWith(null, '/x');
    expect(proposeSubworkstreams.mock.calls[0][0]).toBe(TREE);
  });
});

describe('the page of the workstream being split from', () => {
  beforeEach(() => {
    resolveActiveWorkstream.mockResolvedValue('engineering');
    readConfig.mockReturnValue({
      project: 'Ledger', roles: [],
      workstreams: [{ id: 'engineering', name: 'Engineering' }],
    });
    readProject.mockReturnValue({ name: 'Ledger', whys: [{ id: 'p1', text: 'no new vendors' }] });
  });

  it('keeps its inherited project section', async () => {
    // It was rewritten without one, and stayed that way until something else
    // happened to touch it.
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    const sourceCall = serializeToMd.mock.calls.find(c => c[1] === 'Engineering');
    expect(sourceCall[4].project.whys[0].id).toBe('p1');
  });

  it('does not give the project itself one', async () => {
    resolveActiveWorkstream.mockResolvedValue(null);
    readConfig.mockReturnValue({ project: 'Ledger', roles: [], workstreams: [] });
    await splitWorkstreams({ accepted, teamctxDir: '/x' });
    const sourceCall = serializeToMd.mock.calls.find(c => c[1] === 'Ledger');
    expect(sourceCall[4]?.project).toBeUndefined();
  });
});
