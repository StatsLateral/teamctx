/**
 * `deployUrl` and the handover checks.
 *
 * The terminal refuses a manager change on a deployed project, because only the
 * hosted server can check the incoming primary's key, the GitHub access they
 * lend, and whether anyone still depends on the person stepping out. It knows a
 * project is deployed from `deployUrl` — so a member able to clear that value
 * could turn every one of those checks off. These pin the two together.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ config: null }));

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(() => store.config),
  writeConfig: vi.fn((next) => { store.config = next; }),
}));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => {}), pushContext: vi.fn(async () => {}) }));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn() }));
vi.mock('../../src/prefs.js', () => ({
  writePrefs: vi.fn(),
  resolveIdentity: vi.fn(async ({ actor }) => ({ name: actor?.name, source: 'git' })),
  resolveDisplayName: vi.fn(async ({ actor }) => actor?.name || 'unknown'),
  resolveActiveWorkstream: vi.fn(async () => null),
}));
vi.mock('../../src/ai.js', () => ({ getModelsFor: vi.fn(() => []), getDefaultModelFor: vi.fn(() => 'claude-sonnet-4-6') }));

const { setConfig, InvalidConfigValueError } = await import('./config.core.js');
const { transferManager } = await import('./manager.core.js');
const { resolveActor } = await import('../../src/actor.js');
const { writeConfig } = await import('../../src/storage.js');
const { ManagerGateError } = await import('./review.core.js');

const MAYA = { key: 'git:maya@example.com', email: 'maya@example.com', name: 'Maya' };
const SAM = { key: 'git:sam@example.com', email: 'sam@example.com', name: 'Sam' };
const DEPLOYED = { project: 'Ledger', managerKey: 'git:maya@example.com', deployUrl: 'https://team.example.app', autoPush: false };

beforeEach(() => {
  vi.clearAllMocks();
  store.config = { ...DEPLOYED };
  resolveActor.mockResolvedValue(MAYA);
});

describe('changing deployUrl', () => {
  it('is refused for somebody who is not a manager', async () => {
    resolveActor.mockResolvedValue(SAM);
    await expect(setConfig({ key: 'deployUrl', value: 'https://elsewhere.app' })).rejects.toBeInstanceOf(ManagerGateError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('cannot clear it once recorded, even as the manager', async () => {
    await expect(setConfig({ key: 'deployUrl', value: '' })).rejects.toBeInstanceOf(InvalidConfigValueError);
    await expect(setConfig({ key: 'deployUrl', value: '   ' })).rejects.toThrow(/cannot be cleared/);
    expect(store.config.deployUrl).toBe('https://team.example.app');
  });

  it('can be moved to a new address by a manager', async () => {
    const r = await setConfig({ key: 'deployUrl', value: 'https://team-v2.example.app' });
    expect(r.value).toBe('https://team-v2.example.app');
  });

  it('can be set for the first time on a project that never recorded one', async () => {
    store.config = { ...DEPLOYED, deployUrl: '' };
    expect((await setConfig({ key: 'deployUrl', value: 'https://team.example.app' })).value).toBe('https://team.example.app');
  });
});

describe('the handover checks, after an attempt to clear it', () => {
  it('still refuses a transfer from the terminal', async () => {
    await setConfig({ key: 'deployUrl', value: '' }).catch(() => {});
    await expect(transferManager({ ref: 'priya@example.com' })).rejects.toMatchObject({ code: 'MANAGER_NEEDS_CONNECTOR' });
    expect(store.config.managerKey).toBe('git:maya@example.com');
  });

  it('still refuses a step-down from the terminal', async () => {
    store.config = { ...DEPLOYED, managerKeys: ['git:priya@example.com'] };
    await setConfig({ key: 'deployUrl', value: '' }).catch(() => {});
    const { removeManager } = await import('./manager.core.js');
    await expect(removeManager({ ref: 'priya@example.com' })).rejects.toMatchObject({ code: 'MANAGER_NEEDS_CONNECTOR' });
  });
});
