/**
 * The setter, and the surface it is deliberately absent from.
 *
 * `reviewPolicy` decides whether writes are reviewed at all, so a caller who
 * can set it to `none` can then write anything — the same escalation
 * `managerKey` is kept off `WRITABLE` to prevent (#49). These cover both halves:
 * that the dedicated entry point is gated, and that the general one refuses it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MANAGER = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };
const MEMBER = { key: 'github:2002', name: 'Ravi', login: 'ravi', source: 'github' };
let caller = MANAGER;

vi.mock('../../src/storage.js', () => ({
  writeWorkstreamMd: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'w', name: 'W', whys: [] })),
  listWorkstreamIds: vi.fn(() => []),
  readProject: vi.fn(() => ({ name: '', whys: [] })),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => caller) }));
vi.mock('../../src/prefs.js', () => ({
  writePrefs: vi.fn(),
  readPrefs: vi.fn(async () => ({})),
  resolveIdentity: vi.fn(async () => ({ name: caller.name, source: 'github' })),
  resolveDisplayName: vi.fn(async () => caller.name),
  resolveActiveWorkstream: vi.fn(async () => 'main'),
}));
vi.mock('../../src/ai.js', () => ({
  getModelsFor: vi.fn(() => []),
  getDefaultModelFor: vi.fn(() => 'claude-sonnet-4-6'),
}));

const { setReviewPolicy, setConfig } = await import('./config.core.js');
const { readConfig, writeConfig } = await import('../../src/storage.js');

const project = (over = {}) => ({ project: 'p', me: 'Ada', managerKey: 'github:1001', ...over });

beforeEach(() => { vi.clearAllMocks(); caller = MANAGER; });

describe('setting the review policy', () => {
  it('lets the manager set it, and reports what it was', async () => {
    readConfig.mockReturnValue(project({ reviewPolicy: 'all' }));
    const r = await setReviewPolicy('additive');
    expect(r).toEqual({ from: 'all', to: 'additive' });
    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ reviewPolicy: 'additive' }), undefined);
  });

  it('refuses a member, and writes nothing', async () => {
    caller = MEMBER;
    readConfig.mockReturnValue(project({ reviewPolicy: 'all' }));
    await expect(setReviewPolicy('none')).rejects.toThrow(/only the configured manager/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses a value it does not recognise, before writing', async () => {
    readConfig.mockReturnValue(project());
    await expect(setReviewPolicy('sometimes')).rejects.toThrow(/unknown review policy/);
    await expect(setReviewPolicy('')).rejects.toThrow(/unknown review policy/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('reports a no-op rather than pretending something changed', async () => {
    readConfig.mockReturnValue(project({ reviewPolicy: 'additive' }));
    expect(await setReviewPolicy('additive')).toEqual({ from: 'additive', to: 'additive' });
  });
});

describe('it is not reachable through config_set', () => {
  it('refuses reviewPolicy as an unknown key', async () => {
    readConfig.mockReturnValue(project());
    await expect(setConfig({ key: 'reviewPolicy', value: 'none' }))
      .rejects.toThrow(/unknown config key/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('does not offer it among the keys it will write', async () => {
    readConfig.mockReturnValue(project());
    const err = await setConfig({ key: 'nonsense', value: 'x' }).catch(e => e);
    expect(err.message).not.toContain('reviewPolicy');
  });
});
