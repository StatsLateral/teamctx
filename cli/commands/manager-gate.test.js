import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));
vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'github:2002', name: 'Ravi', login: 'ravi', source: 'github' })),
}));
vi.mock('../../src/prefs.js', () => ({
  writePrefs: vi.fn(),
  readPrefs: vi.fn(async () => ({})),
  resolveIdentity: vi.fn(async () => ({ name: 'Ravi', source: 'github' })),
  resolveDisplayName: vi.fn(async () => 'Ravi'),
  resolveActiveWorkstream: vi.fn(async () => 'main'),
}));
vi.mock('../../src/ai.js', () => ({
  getModelsFor: vi.fn(() => []),
  getDefaultModelFor: vi.fn(() => 'claude-sonnet-4-6'),
}));

const { setConfig } = await import('./config.core.js');
const { readConfig, writeConfig } = await import('../../src/storage.js');

const MANAGED = { project: 'p', me: 'Ada', managerKey: 'github:1001' };

beforeEach(() => vi.clearAllMocks());

describe('the manager gate is not settable through config', () => {
  it('refuses manager as an unknown key', async () => {
    // Off the writable surface entirely: a member who can write the gate can
    // grant themselves approval and sign off their own submissions, which is
    // the trust they were deliberately invited with less of.
    readConfig.mockReturnValue(MANAGED);
    await expect(setConfig({ key: 'manager', value: 'Ravi' })).rejects.toThrow(/unknown config key/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses managerKey too', async () => {
    readConfig.mockReturnValue(MANAGED);
    await expect(setConfig({ key: 'managerKey', value: 'github:2002' })).rejects.toThrow(/unknown config key/);
  });

  it('still writes the keys that are meant to be settable', async () => {
    readConfig.mockReturnValue(MANAGED);
    const r = await setConfig({ key: 'managerEmail', value: 'ada@example.com' });
    expect(r.value).toBe('ada@example.com');
  });

  it('names what is settable when it refuses', async () => {
    // The error is what a caller reads; listing the writable keys is what makes
    // it actionable rather than a dead end.
    readConfig.mockReturnValue(MANAGED);
    await expect(setConfig({ key: 'manager', value: 'Ravi' })).rejects.toThrow(/Writable:/);
  });
});
