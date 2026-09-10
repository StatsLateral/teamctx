/**
 * Reflect replaces the whole tree with whatever the model returns — no diff, no
 * confirmation, and no smaller unit of it to queue. It had no gate at all, so
 * any member from any client could trigger an unreviewed full rewrite. It now
 * follows the project's review policy rather than carrying a gate of its own,
 * which keeps the old behaviour reachable instead of removing it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MANAGER = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };
const MEMBER = { key: 'github:2002', name: 'Ravi', login: 'ravi', source: 'github' };
let caller = MANAGER;

vi.mock('../../src/storage.js', () => ({
  readProject: vi.fn(() => ({ name: '', whys: [] })),
  readConfig: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'main', name: 'p', whys: [] })),
  writeWorkstream: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  readContributions: vi.fn(() => []),
  writeRoleFile: vi.fn(),
  listWorkstreamIds: vi.fn(() => ['main']),
}));
vi.mock('../../src/context.js', () => ({
  generateReflection: vi.fn(async () => '{}'),
  serializeToMd: vi.fn(() => '# md'),
  generateRoleFile: vi.fn(async () => '# role'),
}));
vi.mock('../../src/ai.js', () => ({ extractJson: vi.fn(() => ({ whys: [] })) }));
vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(async () => ({ committed: true })),
  pushContext: vi.fn(async () => {}),
}));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => caller) }));
vi.mock('../../src/prefs.js', () => ({
  resolveActiveWorkstream: vi.fn(async () => 'main'),
  resolveDisplayName: vi.fn(async () => caller.name),
}));

const { reflectWorkstream } = await import('./reflect.core.js');
const { readConfig, writeWorkstream } = await import('../../src/storage.js');

const project = (over = {}) => ({ project: 'p', me: 'Ada', managerKey: 'github:1001', ...over });

beforeEach(() => { vi.clearAllMocks(); caller = MANAGER; });

describe('who may rewrite the whole shared context', () => {
  it('refuses a member under additive', async () => {
    caller = MEMBER;
    readConfig.mockReturnValue(project({ reviewPolicy: 'additive' }));
    await expect(reflectWorkstream({})).rejects.toThrow(/only the configured manager/);
    expect(writeWorkstream).not.toHaveBeenCalled();
  });

  it('refuses a member under all', async () => {
    caller = MEMBER;
    readConfig.mockReturnValue(project({ reviewPolicy: 'all' }));
    await expect(reflectWorkstream({})).rejects.toThrow(/only the configured manager/);
    expect(writeWorkstream).not.toHaveBeenCalled();
  });

  it('refuses a member on a project with no policy recorded', async () => {
    // The upgrade case, and the one behaviour change this ships: an existing
    // project tightens reflect without anyone editing its config.
    caller = MEMBER;
    readConfig.mockReturnValue(project());
    await expect(reflectWorkstream({})).rejects.toThrow(/only the configured manager/);
  });

  it('lets a member run it under none, which is what it did before', async () => {
    caller = MEMBER;
    readConfig.mockReturnValue(project({ reviewPolicy: 'none' }));
    await reflectWorkstream({});
    expect(writeWorkstream).toHaveBeenCalled();
  });

  it('lets a member run it on a project with no manager pinned', async () => {
    // Same bootstrap case the approval gate has: with nobody pinned there is
    // nobody to assert against, and refusing everyone would strand the project.
    caller = MEMBER;
    readConfig.mockReturnValue({ project: 'p', me: 'Ada', reviewPolicy: 'all' });
    await reflectWorkstream({});
    expect(writeWorkstream).toHaveBeenCalled();
  });

  it('lets the manager run it under every policy', async () => {
    for (const p of ['all', 'additive', 'none']) {
      vi.clearAllMocks();
      readConfig.mockReturnValue(project({ reviewPolicy: p }));
      await reflectWorkstream({});
      expect(writeWorkstream).toHaveBeenCalled();
    }
  });
});
