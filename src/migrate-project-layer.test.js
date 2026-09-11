import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./storage.js', () => ({
  readProject: vi.fn(() => ({ name: '', whys: [] })),
  readProjectMd: vi.fn(() => ''),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readWorkstream: vi.fn(),
  readWorkstreamMd: vi.fn(() => ''),
  deleteWorkstream: vi.fn(),
  writeProject: vi.fn(),
  writeProjectMd: vi.fn(),
  listWorkstreamIds: vi.fn(() => []),
  readContributions: vi.fn(() => []),
  writeWorkstreamMd: vi.fn(),
}));

const { migrateProjectLayer } = await import('./migrate-project-layer.js');
const {
  readConfig, writeConfig, readWorkstream, readWorkstreamMd, readProject, readProjectMd,
  deleteWorkstream, writeProject, writeProjectMd, listWorkstreamIds, writeWorkstreamMd,
} = await import('./storage.js');

const MAIN_TREE = { id: 'main', name: 'Ledger', whys: [{ id: 'w1', text: 'ship it', whats: [] }] };

const config = (over = {}) => ({
  project: 'Ledger',
  workstreams: [{ id: 'main', name: 'Ledger' }, { id: 'engineering', name: 'Engineering' }],
  activeWorkstream: 'main',
  roles: [{ slug: 'eng', workstream: 'main' }, { slug: 'ops', workstream: 'engineering' }],
  ...over,
});

const written = () => writeConfig.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue(config());
  readWorkstream.mockReturnValue(MAIN_TREE);
  listWorkstreamIds.mockReturnValue(['main', 'engineering']);
  readWorkstreamMd.mockReturnValue('# Project Context — Ledger\n');
});

describe('folding main into the project tree', () => {
  it('moves main\'s whys to the project', () => {
    migrateProjectLayer('/x');
    expect(writeProject).toHaveBeenCalledWith(
      expect.objectContaining({ whys: MAIN_TREE.whys }), '/x');
  });

  it('names the project after the project, not after main', () => {
    // `main` was usually named after the project; where it was not, the
    // project's own name is the truthful one.
    readWorkstream.mockReturnValue({ ...MAIN_TREE, name: 'main' });
    migrateProjectLayer('/x');
    expect(writeProject.mock.calls[0][0].name).toBe('Ledger');
  });

  it('compiles the project page from the tree it just wrote', () => {
    // Not copied from main's markdown. Copying disagreed with the tree in both
    // directions; rendering is deterministic, so this always matches.
    migrateProjectLayer('/x');
    const md = writeProjectMd.mock.calls[0][0];
    expect(md).toContain('Ledger');
    expect(md).toContain('ship it');
  });

  it('removes main from the workstream list and leaves the others', () => {
    migrateProjectLayer('/x');
    expect(written().workstreams.map(w => w.id)).toEqual(['engineering']);
  });

  it('unsets the active workstream rather than picking another', () => {
    // Choosing a survivor would silently move where somebody works.
    migrateProjectLayer('/x');
    expect(written().activeWorkstream).toBe(null);
  });

  it('rebinds main-bound roles to project level, leaving others alone', () => {
    migrateProjectLayer('/x');
    expect(written().roles).toEqual([
      { slug: 'eng', workstream: null },
      { slug: 'ops', workstream: 'engineering' },
    ]);
  });

  it('deletes main only after everything else is written', () => {
    migrateProjectLayer('/x');
    const order = [
      writeProject.mock.invocationCallOrder[0],
      writeConfig.mock.invocationCallOrder[0],
      deleteWorkstream.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(deleteWorkstream).toHaveBeenCalledWith('main', '/x');
  });

  it('records that it ran', () => {
    migrateProjectLayer('/x');
    expect(written().projectLayerMigrated).toBe(true);
  });
});

describe('running it more than once', () => {
  it('does nothing on a project already migrated', () => {
    readConfig.mockReturnValue(config({ projectLayerMigrated: true }));
    expect(migrateProjectLayer('/x')).toBe(false);
    expect(writeProject).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
    expect(deleteWorkstream).not.toHaveBeenCalled();
  });

  it('reports whether it did anything', () => {
    expect(migrateProjectLayer('/x')).toBe(true);
  });
});

describe('projects that do not look like the common case', () => {
  it('still creates a project tree when there is no main at all', () => {
    // A project split before this shipped may have no `main` left.
    listWorkstreamIds.mockReturnValue(['engineering']);
    readConfig.mockReturnValue(config({ workstreams: [{ id: 'engineering', name: 'Engineering' }] }));
    migrateProjectLayer('/x');
    expect(writeProject).toHaveBeenCalledWith({ name: 'Ledger', whys: [] }, '/x');
    expect(deleteWorkstream).not.toHaveBeenCalled();
  });

  it('leaves a project with only main holding no workstreams', () => {
    // The case that must be invisible: same content, one fewer concept.
    listWorkstreamIds.mockReturnValue(['main']);
    readConfig.mockReturnValue(config({ workstreams: [{ id: 'main', name: 'Ledger' }] }));
    migrateProjectLayer('/x');
    expect(written().workstreams).toEqual([]);
    expect(writeProject.mock.calls[0][0].whys).toEqual(MAIN_TREE.whys);
  });

  it('survives a config with no workstreams or roles recorded', () => {
    readConfig.mockReturnValue({ project: 'Ledger' });
    listWorkstreamIds.mockReturnValue([]);
    expect(() => migrateProjectLayer('/x')).not.toThrow();
    expect(written().workstreams).toEqual([]);
    expect(written().roles).toEqual([]);
  });

  it('does nothing where there is no project to read', () => {
    readConfig.mockImplementation(() => { throw new Error('Not in a teamctx project.'); });
    expect(migrateProjectLayer('/x')).toBe(false);
    expect(writeProject).not.toHaveBeenCalled();
  });

  it('still writes a page when main had none compiled, because the tree has content', () => {
    readWorkstreamMd.mockReturnValue('');
    migrateProjectLayer('/x');
    expect(writeProjectMd.mock.calls[0][0]).toContain('ship it');
  });

  it('writes no page for a project with nothing in it and nothing compiled', () => {
    readWorkstreamMd.mockReturnValue('');
    listWorkstreamIds.mockReturnValue([]);
    readConfig.mockReturnValue({ project: 'Ledger' });
    migrateProjectLayer('/x');
    expect(writeProjectMd).not.toHaveBeenCalled();
  });
});

describe('a project that already has a tree when this runs', () => {
  // Should not happen — this migration is what creates one. But a build shipped
  // where a contribution could land at project level before the migration ran,
  // and overwriting would destroy exactly the writes made in that window.
  const ORPHAN = { id: 'o1', text: 'nobody flies before the 3rd', whats: [] };

  beforeEach(() => {
    readProject.mockReturnValue({ name: 'Ledger', whys: [ORPHAN] });
  });

  it('keeps what was already there', () => {
    migrateProjectLayer('/x');
    const whys = writeProject.mock.calls[0][0].whys;
    expect(whys.map(w => w.id)).toContain('o1');
  });

  it('appends main rather than replacing it', () => {
    migrateProjectLayer('/x');
    const whys = writeProject.mock.calls[0][0].whys;
    expect(whys.map(w => w.id)).toEqual(['o1', 'w1']);
  });

  it('does not duplicate a why that is in both', () => {
    readProject.mockReturnValue({ name: 'Ledger', whys: [{ id: 'w1', text: 'ship it', whats: [] }] });
    migrateProjectLayer('/x');
    expect(writeProject.mock.calls[0][0].whys.map(w => w.id)).toEqual(['w1']);
  });

  it('recompiles a project.md that already exists, rather than leaving it stale', () => {
    // The page was kept while main's whys were merged into the tree beneath it,
    // so the two disagreed about what the project says.
    readProjectMd.mockReturnValue('# Context — Ledger');
    migrateProjectLayer('/x');
    const md = writeProjectMd.mock.calls[0][0];
    expect(md).toContain('nobody flies before the 3rd');
    expect(md).toContain('ship it');
  });
});

describe('tasks that were sitting on main', () => {
  // Tasks live inside the tree file, so deleting `main` deleted them — every
  // open task on a project that had never split, gone at the moment of
  // upgrade, and tasks are the thing people actually act on.
  const TASK = { id: 't1', title: 'book the venue', status: 'open', workstream: 'main' };

  beforeEach(() => {
    readProject.mockReturnValue({ name: '', whys: [] });
    readWorkstream.mockReturnValue({ ...MAIN_TREE, tasks: [TASK] });
  });

  it('carries them onto the project', () => {
    migrateProjectLayer('/x');
    expect(writeProject.mock.calls[0][0].tasks).toEqual([TASK]);
  });

  it('keeps any the project already had, and appends the rest', () => {
    readProject.mockReturnValue({ name: 'Ledger', whys: [], tasks: [{ id: 't0', title: 'earlier' }] });
    migrateProjectLayer('/x');
    expect(writeProject.mock.calls[0][0].tasks.map(t => t.id)).toEqual(['t0', 't1']);
  });

  it('does not duplicate one recorded in both', () => {
    readProject.mockReturnValue({ name: 'Ledger', whys: [], tasks: [TASK] });
    migrateProjectLayer('/x');
    expect(writeProject.mock.calls[0][0].tasks.map(t => t.id)).toEqual(['t1']);
  });

  it('leaves the key off entirely when there were none', () => {
    readWorkstream.mockReturnValue(MAIN_TREE);
    migrateProjectLayer('/x');
    expect(writeProject.mock.calls[0][0]).not.toHaveProperty('tasks');
  });
});

describe('workstreams that survive the migration', () => {
  // They start inheriting the project tree the moment it exists, and a compiled
  // page does not re-read anything — so without this their page shows no
  // inherited section until something unrelated rewrites it.
  it('recompiles their pages, with the project above their own', () => {
    migrateProjectLayer('/x');
    expect(writeWorkstreamMd).toHaveBeenCalled();
  });

  it('does so after main is gone, so it is not one of them', () => {
    migrateProjectLayer('/x');
    expect(deleteWorkstream.mock.invocationCallOrder[0])
      .toBeLessThan(writeWorkstreamMd.mock.invocationCallOrder[0]);
  });
});
