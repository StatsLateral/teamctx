/**
 * `teamctx manager` in the terminal.
 *
 * A clone cannot run the hosted checks, so the terminal says what it cannot see
 * and asks before changing who manages a project — and on a deployed project it
 * does not ask at all, because the core refuses there and points at the
 * connector.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../prompt.js', () => ({ ask: vi.fn() }));
vi.mock('../../src/storage.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
vi.mock('./manager.core.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    listManagers: vi.fn(() => ({ primary: { key: 'git:maya@example.com', email: 'maya@example.com' }, coManagers: [] })),
    addManager: vi.fn(async () => ({ primary: { email: 'maya@example.com' }, coManagers: [{ email: 'priya@example.com' }] })),
    removeManager: vi.fn(async () => ({ primary: { email: 'maya@example.com' }, coManagers: [] })),
    transferManager: vi.fn(async () => ({ primary: { email: 'priya@example.com' }, coManagers: [] })),
  };
});

const { ask } = await import('../prompt.js');
const { readConfig } = await import('../../src/storage.js');
const core = await import('./manager.core.js');
const { managerAddCommand, managerTransferCommand, managerListCommand } = await import('./manager.js');

let out, exit;
const printed = () => out.mock.calls.map(c => c.join(' ')).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue({ project: 'Ledger' });
  out = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

describe('on a project with no deployment', () => {
  it('says what it cannot check before a transfer', async () => {
    ask.mockResolvedValue('y');
    await managerTransferCommand('priya@example.com');
    expect(printed()).toMatch(/cannot check/);
    expect(printed()).toMatch(/new primary manager has a working AI key/);
    expect(printed()).toMatch(/hold the GitHub access the project lends/);
  });

  it('changes nothing when the answer is no', async () => {
    ask.mockResolvedValue('n');
    await managerTransferCommand('priya@example.com');
    expect(core.transferManager).not.toHaveBeenCalled();
    expect(printed()).toMatch(/Nothing changed/);
  });

  it('goes ahead on yes', async () => {
    ask.mockResolvedValue('y');
    await managerTransferCommand('priya@example.com');
    expect(core.transferManager).toHaveBeenCalledWith({ ref: 'priya@example.com', stepDown: false });
  });

  it('skips the question with --yes', async () => {
    await managerTransferCommand('priya@example.com', { yes: true });
    expect(ask).not.toHaveBeenCalled();
    expect(core.transferManager).toHaveBeenCalled();
  });

  it('refuses without --yes when there is no terminal to ask', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(managerTransferCommand('priya@example.com')).rejects.toThrow(/exit 1/);
    expect(core.transferManager).not.toHaveBeenCalled();
  });

  it('passes a step-down through to the transfer', async () => {
    await managerTransferCommand('priya@example.com', { yes: true, stepDown: true });
    expect(core.transferManager).toHaveBeenCalledWith({ ref: 'priya@example.com', stepDown: true });
  });

  it('adds a co-manager without asking, since there is nothing it cannot check', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await managerAddCommand('priya@example.com');
    expect(ask).not.toHaveBeenCalled();
    expect(core.addManager).toHaveBeenCalledWith({ ref: 'priya@example.com' });
  });
});

describe('on a deployed project', () => {
  it('does not ask, and leaves the refusal to the core', async () => {
    readConfig.mockReturnValue({ project: 'Ledger', deployUrl: 'https://team.vercel.app' });
    core.transferManager.mockRejectedValueOnce(new core.ManagerChangeError('through the teamctx connector', 'MANAGER_NEEDS_CONNECTOR'));
    await expect(managerTransferCommand('priya@example.com')).rejects.toThrow(/exit 1/);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('listing', () => {
  it('names the primary and says what being primary means', async () => {
    await managerListCommand();
    expect(printed()).toMatch(/Primary: +maya@example\.com/);
    expect(printed()).toMatch(/runs on the primary manager's key/);
  });
});
