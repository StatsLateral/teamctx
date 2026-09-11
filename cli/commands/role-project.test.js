/**
 * Roles on a project that has not split.
 *
 * Which is every project on the day it is created. `role_add` checked the
 * target against the workstream list, and the project is not in that list and
 * never will be — so the first role anyone tried to create was refused as an
 * unknown workstream.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'x', name: 'X', whys: [] })),
  readTree: vi.fn(),
  readProject: vi.fn(),
  listWorkstreamIds: vi.fn(() => []),
  writeRoleFile: vi.fn(),
  readContributions: vi.fn(() => []),
}));
vi.mock('../../src/context.js', () => ({ generateRoleFile: vi.fn(async () => '# role') }));
vi.mock('../../src/roles.js', async (orig) => {
  const actual = await orig();
  return { ...actual, suggestRoles: vi.fn(async () => [{ name: 'Lead' }]) };
});
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', () => ({
  callClaude: vi.fn(), extractJson: vi.fn(), getFastModelFor: vi.fn(() => 'm'),
}));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => ({ key: 'k', name: 'Ada' })) }));
vi.mock('../../src/prefs.js', () => ({ resolveActiveWorkstream: vi.fn(async () => null) }));

const { addRoleFull, suggestRoles, assignRole } = await import('./role.core.js');
const { readConfig, writeConfig, readTree, readProject, listWorkstreamIds } = await import('../../src/storage.js');
const { generateRoleFile } = await import('../../src/context.js');
const { resolveActiveWorkstream } = await import('../../src/prefs.js');

const PROJECT = { name: 'Ledger', whys: [{ id: 'p1', text: 'no new vendors', whats: [] }] };
const WS = { id: 'delivery', name: 'Delivery', whys: [] };

const role = () => writeConfig.mock.calls[0][0].roles[0];

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue({ project: 'Ledger', roles: [], workstreams: [] });
  readTree.mockReturnValue(PROJECT);
  readProject.mockReturnValue(PROJECT);
  resolveActiveWorkstream.mockResolvedValue(null);
});

describe('creating a role at project level', () => {
  const args = { name: 'Ops', responsibilities: 'keeps the lights on', teamctxDir: '/x' };

  it('is allowed, rather than refused as an unknown workstream', async () => {
    await expect(addRoleFull(args)).resolves.toMatchObject({ slug: 'ops' });
  });

  it('records the role at project level, not on a workstream called main', async () => {
    await addRoleFull(args);
    expect(role().workstream).toBe(null);
  });

  it('compiles it from the project tree', async () => {
    await addRoleFull(args);
    expect(readTree).toHaveBeenCalledWith(null, '/x');
    expect(generateRoleFile.mock.calls[0][0]).toBe(PROJECT);
  });

  it('does not also pass the project as the inherited half', async () => {
    await addRoleFull(args);
    expect(generateRoleFile.mock.calls[0][5]?.project).toBeUndefined();
  });
});

describe('creating a role on a workstream', () => {
  const args = { name: 'Lead', responsibilities: 'ships it', workstreamId: 'delivery', teamctxDir: '/x' };

  beforeEach(() => {
    readConfig.mockReturnValue({
      project: 'Ledger', roles: [], workstreams: [{ id: 'delivery', name: 'Delivery' }],
    });
    listWorkstreamIds.mockReturnValue(['delivery']);
    readTree.mockReturnValue(WS);
  });

  it('compiles it with the project tree above its own', async () => {
    await addRoleFull(args);
    expect(generateRoleFile.mock.calls[0][5].project).toBe(PROJECT);
  });

  it('still refuses a workstream that does not exist', async () => {
    await expect(addRoleFull({ ...args, workstreamId: 'finance' }))
      .rejects.toThrow(/no workstream "finance"/);
  });
});

describe('suggesting roles', () => {
  it('reads the project tree when that is where the caller stands', async () => {
    // It read a workstream, so a project holding all its context suggested
    // roles as though it held none.
    await suggestRoles({ teamctxDir: '/x' });
    expect(readTree).toHaveBeenCalledWith(null, '/x');
  });
});

describe('reassigning a role', () => {
  it('treats a project-level role and one recorded as main as the same place', async () => {
    readConfig.mockReturnValue({
      project: 'Ledger', workstreams: [{ id: 'delivery', name: 'Delivery' }],
      roles: [{ slug: 'ops', workstream: 'main' }],
    });
    listWorkstreamIds.mockReturnValue(['delivery']);
    const r = await assignRole({ slug: 'ops', workstreamId: 'main', teamctxDir: '/x' });
    expect(r.changed).toBe(false);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

describe('moving a role back to the project', () => {
  beforeEach(() => {
    readConfig.mockReturnValue({
      project: 'Ledger', workstreams: [{ id: 'delivery', name: 'Delivery' }],
      roles: [{ slug: 'ops', workstream: 'delivery' }],
    });
    listWorkstreamIds.mockReturnValue(['delivery']);
  });

  it('is a destination, not a missing argument', async () => {
    const r = await assignRole({ slug: 'ops', workstreamId: 'main', teamctxDir: '/x' });
    expect(r.changed).toBe(true);
    expect(writeConfig.mock.calls[0][0].roles[0].workstream).toBe(null);
  });

  it('recompiles the role from the project tree', async () => {
    await assignRole({ slug: 'ops', workstreamId: 'main', teamctxDir: '/x' });
    expect(readTree).toHaveBeenCalledWith(null, '/x');
    expect(generateRoleFile.mock.calls[0][5]?.project).toBeUndefined();
  });

  it('still says which argument is missing when none was given', async () => {
    await expect(assignRole({ slug: 'ops', teamctxDir: '/x' }))
      .rejects.toThrow(/workstreamId is required/);
  });
});
