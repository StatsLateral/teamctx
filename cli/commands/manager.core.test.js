/**
 * Changing who manages a project: the gated write path.
 *
 * The rules themselves are tested in src/managers.test.js. These check the
 * parts that touch the project: who may call, the checks that run before a
 * write, what gets written, and what the commit says.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => {}), pushContext: vi.fn(async () => {}) }));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn() }));
vi.mock('../../src/prefs.js', () => ({ resolveDisplayName: vi.fn(async ({ actor }) => actor?.name || 'unknown') }));

const { readConfig, writeConfig } = await import('../../src/storage.js');
const { commitContext } = await import('../../src/git.js');
const { resolveActor } = await import('../../src/actor.js');
const {
  addManager, removeManager, transferManager, listManagers, ManagerChangeError,
} = await import('./manager.core.js');
const { ManagerGateError } = await import('./review.core.js');

const MAYA = { key: 'git:maya@example.com', email: 'maya@example.com', name: 'Maya' };
const PRIYA = { key: 'git:priya@example.com', email: 'priya@example.com', name: 'Priya' };
const STRANGER = { key: 'git:sam@example.com', email: 'sam@example.com', name: 'Sam' };

const config = (over = {}) => ({ project: 'Ledger', managerKey: 'git:maya@example.com', autoPush: false, ...over });
const written = () => writeConfig.mock.calls[0][0];
const message = () => commitContext.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue(config());
  resolveActor.mockResolvedValue(MAYA);
});

describe('who may change the managers', () => {
  it('refuses somebody who is not a manager, on every operation', async () => {
    resolveActor.mockResolvedValue(STRANGER);
    await expect(addManager({ ref: 'priya@example.com' })).rejects.toThrow(ManagerGateError);
    await expect(removeManager({ ref: 'priya@example.com' })).rejects.toThrow(ManagerGateError);
    await expect(transferManager({ ref: 'priya@example.com' })).rejects.toThrow(ManagerGateError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('lets a co-manager add another co-manager', async () => {
    readConfig.mockReturnValue(config({ managerKeys: ['git:priya@example.com'] }));
    resolveActor.mockResolvedValue(PRIYA);
    await addManager({ ref: 'dev@example.com' });
    expect(written().managerKeys).toEqual(['git:priya@example.com', 'git:dev@example.com']);
  });

  it('does not let a co-manager take the primary role', async () => {
    readConfig.mockReturnValue(config({ managerKeys: ['git:priya@example.com'] }));
    resolveActor.mockResolvedValue(PRIYA);
    await expect(transferManager({ ref: 'priya@example.com' })).rejects.toThrow(/Only the primary manager/);
  });
});

describe('the key check before somebody becomes primary', () => {
  it('runs against the incoming primary', async () => {
    const checkKey = vi.fn(async () => ({ ok: true }));
    await transferManager({ ref: 'priya@example.com', checkKey });
    expect(checkKey).toHaveBeenCalledWith({ email: 'priya@example.com', key: 'git:priya@example.com' });
  });

  it('refuses the transfer, and writes nothing, when it fails', async () => {
    const checkKey = async () => ({ ok: false, why: 'priya@example.com has not added a project key.' });
    await expect(transferManager({ ref: 'priya@example.com', checkKey })).rejects.toThrow(/has not added a project key/);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(commitContext).not.toHaveBeenCalled();
  });

  it('does not run for a co-manager, whose key the project never runs on', async () => {
    const checkKey = vi.fn(async () => ({ ok: false, why: 'no key' }));
    await addManager({ ref: 'priya@example.com', checkKey });
    expect(checkKey).not.toHaveBeenCalled();
    expect(message()).toBe('manager: add priya@example.com as co-manager by Maya');
  });

  it('carries the failure as a manager change error with its own code', async () => {
    const checkKey = async () => ({ ok: false, why: 'no key' });
    await expect(transferManager({ ref: 'priya@example.com', checkKey }))
      .rejects.toMatchObject({ code: 'MANAGER_KEY_CHECK' });
  });

  it('records a passing check in the commit', async () => {
    await transferManager({
      ref: 'priya@example.com',
      checkKey: async () => ({ ok: true, note: 'key verified with anthropic' }),
      checkLend: async () => ({ ok: true, note: 'GitHub access lent by them' }),
    });
    expect(message()).toBe('manager: transfer primary to priya@example.com by Maya (key verified with anthropic; GitHub access lent by them)');
  });

  it('says plainly in the commit when no check ran', async () => {
    await transferManager({ ref: 'priya@example.com' });
    expect(message()).toMatch(/\(key not checked; GitHub access not checked\)$/);
  });

  it('does not run on a removal, which promotes nobody', async () => {
    readConfig.mockReturnValue(config({ managerKeys: ['git:priya@example.com'] }));
    const checkKey = vi.fn();
    await removeManager({ ref: 'priya@example.com', checkKey });
    expect(checkKey).not.toHaveBeenCalled();
  });
});

describe('the GitHub access check before somebody becomes primary', () => {
  it('runs against the incoming primary', async () => {
    const checkLend = vi.fn(async () => ({ ok: true }));
    await transferManager({ ref: 'priya@example.com', checkKey: async () => ({ ok: true }), checkLend });
    expect(checkLend).toHaveBeenCalledWith({ email: 'priya@example.com', key: 'git:priya@example.com' });
  });

  it('refuses the transfer, and writes nothing, when it fails', async () => {
    const checkLend = async () => ({ ok: false, why: 'acme/ledger lends GitHub access, and it is not theirs.' });
    await expect(transferManager({ ref: 'priya@example.com', checkKey: async () => ({ ok: true }), checkLend }))
      .rejects.toMatchObject({ code: 'MANAGER_LEND_CHECK' });
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('does not run for a co-manager', async () => {
    const checkLend = vi.fn(async () => ({ ok: false, why: 'no' }));
    await addManager({ ref: 'priya@example.com', checkLend });
    expect(checkLend).not.toHaveBeenCalled();
  });

  it('is required on a deployed project, like the key check', async () => {
    readConfig.mockReturnValue(config({ deployUrl: 'https://team.vercel.app' }));
    await expect(transferManager({ ref: 'priya@example.com', checkKey: async () => ({ ok: true }) }))
      .rejects.toMatchObject({ code: 'MANAGER_NEEDS_CONNECTOR' });
  });
});

describe('the step-out check', () => {
  it('runs against the person leaving when a co-manager is removed', async () => {
    readConfig.mockReturnValue(config({ managerKeys: ['git:priya@example.com'] }));
    const checkStepOut = vi.fn(async () => ({ ok: true }));
    await removeManager({ ref: 'priya@example.com', checkStepOut });
    expect(checkStepOut).toHaveBeenCalledWith({ email: 'priya@example.com', key: 'git:priya@example.com' });
  });

  it('runs against the outgoing primary when they step down on a transfer', async () => {
    const checkStepOut = vi.fn(async () => ({ ok: true }));
    await transferManager({ ref: 'priya@example.com', stepDown: true, checkKey: async () => ({ ok: true }), checkStepOut });
    expect(checkStepOut).toHaveBeenCalledWith({ email: 'maya@example.com', key: 'git:maya@example.com' });
  });

  it('does not run when the outgoing primary stays on as a co-manager', async () => {
    const checkStepOut = vi.fn();
    await transferManager({ ref: 'priya@example.com', checkKey: async () => ({ ok: true }), checkStepOut });
    expect(checkStepOut).not.toHaveBeenCalled();
  });

  it('refuses, and writes nothing, when the project still runs on them', async () => {
    readConfig.mockReturnValue(config({ managerKeys: ['git:priya@example.com'] }));
    const checkStepOut = async () => ({ ok: false, why: 'GitHub access for this project is still lent by priya@example.com.' });
    await expect(removeManager({ ref: 'priya@example.com', checkStepOut }))
      .rejects.toMatchObject({ code: 'MANAGER_STEP_OUT' });
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

describe('what is written and committed', () => {
  it('transfers the primary role and keeps the old primary on', async () => {
    const r = await transferManager({ ref: 'priya@example.com', checkKey: async () => ({ ok: true }) });
    expect(written()).toMatchObject({ managerKey: 'git:priya@example.com', managerKeys: ['git:maya@example.com'] });
    expect(r.primary.email).toBe('priya@example.com');
    expect(message()).toBe('manager: transfer primary to priya@example.com by Maya (key verified; GitHub access not checked)');
  });

  it('names a step-down in the commit', async () => {
    await transferManager({ ref: 'priya@example.com', stepDown: true, checkKey: async () => ({ ok: true }) });
    expect(message()).toMatch(/transfer primary to priya@example\.com, stepping down by Maya/);
  });

  it('attributes the commit to the caller', async () => {
    await addManager({ ref: 'priya@example.com' });
    expect(commitContext.mock.calls[0][1].author).toMatchObject({ name: 'Maya' });
  });

  it('lists the primary and co-managers by email', () => {
    readConfig.mockReturnValue(config({ managerKeys: ['git:priya@example.com'] }));
    expect(listManagers({})).toEqual({
      primary: { key: 'git:maya@example.com', email: 'maya@example.com' },
      coManagers: [{ key: 'git:priya@example.com', email: 'priya@example.com' }],
    });
  });

  it('lists a legacy primary written as a GitHub id without inventing an address', () => {
    readConfig.mockReturnValue(config({ managerKey: 'github:7' }));
    expect(listManagers({}).primary).toEqual({ key: 'github:7', email: null });
  });

  it('reports a rule failure as a manager change error', async () => {
    await expect(addManager({ ref: 'priyar' })).rejects.toThrow(ManagerChangeError);
  });
});

describe('a deployed project, changed from somewhere the checks cannot run', () => {
  const deployed = (over = {}) => config({ deployUrl: 'https://team.vercel.app', ...over });

  it('refuses a transfer without the key check, and points at the connector', async () => {
    readConfig.mockReturnValue(deployed());
    await expect(transferManager({ ref: 'priya@example.com' }))
      .rejects.toMatchObject({ code: 'MANAGER_NEEDS_CONNECTOR' });
    await expect(transferManager({ ref: 'priya@example.com' })).rejects.toThrow(/through the teamctx connector/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('adds a co-manager from anywhere, since there is nothing to check', async () => {
    readConfig.mockReturnValue(deployed());
    await addManager({ ref: 'priya@example.com' });
    expect(writeConfig).toHaveBeenCalled();
  });

  it('refuses a step-out without the step-out check', async () => {
    readConfig.mockReturnValue(deployed({ managerKeys: ['git:priya@example.com'] }));
    await expect(removeManager({ ref: 'priya@example.com' }))
      .rejects.toMatchObject({ code: 'MANAGER_NEEDS_CONNECTOR' });
  });

  it('goes through when the checks are supplied, as they are on the hosted server', async () => {
    readConfig.mockReturnValue(deployed());
    await transferManager({ ref: 'priya@example.com', checkKey: async () => ({ ok: true }), checkLend: async () => ({ ok: true }) });
    expect(writeConfig).toHaveBeenCalled();
  });

  it('allows the same change on a project with no deployment, where there is nothing to check', async () => {
    await transferManager({ ref: 'priya@example.com' });
    expect(writeConfig).toHaveBeenCalled();
  });
});

describe('a manager recorded before managers were identified by email', () => {
  it('still hands the step-out check something to match them by', async () => {
    // Handed only an address, a GitHub-id manager arrived as null and matched
    // nothing — so the check let them step out whatever they had lent.
    readConfig.mockReturnValue(config({ managerKey: 'github:7' }));
    resolveActor.mockResolvedValue({ key: 'github:7', login: 'maya', name: 'Maya' });
    const checkStepOut = vi.fn(async () => ({ ok: true }));
    await transferManager({ ref: 'priya@example.com', stepDown: true, checkKey: async () => ({ ok: true }), checkStepOut });
    expect(checkStepOut).toHaveBeenCalledWith({ email: null, key: 'github:7' });
  });
});
