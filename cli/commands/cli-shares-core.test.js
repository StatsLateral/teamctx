/**
 * The terminal and the MCP server run the same code.
 *
 * They did not. `contribute.js` held a second
 * implementation, and the copies drifted in both directions: the terminal never
 * learned about the review policy and would have kept writing to a workstream
 * the project layer removed, while the server's reflect quietly dropped the
 * provenance that the terminal's preserved.
 *
 * Nothing here checks output formatting. It checks that the commands delegate,
 * because delegating is the property that stops them diverging again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./contribute.core.js', () => ({ contributeCore: vi.fn() }));
vi.mock('../../src/storage.js', () => ({
  writeWorkstreamMd: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'w', name: 'W', records: [], tasks: [] })),
  listWorkstreamIds: vi.fn(() => []),
  readConfig: vi.fn(() => ({ project: 'Ledger' })),
  readContributions: vi.fn(() => []),
}));
vi.mock('../../src/context.js', () => ({ serializeToMd: vi.fn(() => '# md') }));
vi.mock('../prompt.js', () => ({ ask: vi.fn(async () => 'y') }));

const { contributeCommand } = await import('./contribute.js');
const { contributeCore } = await import('./contribute.core.js');
const { ask } = await import('../prompt.js');

beforeEach(() => {
  vi.clearAllMocks();
  ask.mockResolvedValue('y');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  contributeCore.mockResolvedValue({ id: 'c-1', mode: 'queued', workstream: null, operations: [], rolesRegenerated: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('teamctx contribute', () => {
  it('goes through contributeCore rather than writing anything itself', async () => {
    await contributeCommand('a note', {});
    expect(contributeCore).toHaveBeenCalledTimes(1);
  });

  it('passes the flags through unchanged', async () => {
    await contributeCommand('a note', { workstream: 'eng', decision: true, apply: true });
    expect(contributeCore).toHaveBeenCalledWith(expect.objectContaining({
      text: 'a note', workstreamId: 'eng', decision: true, apply: true,
    }));
  });

  it('sends no workstream when none was given, so the project is the target', async () => {
    await contributeCommand('a note', {});
    expect(contributeCore.mock.calls[0][0].workstreamId).toBeUndefined();
  });

  it('asks before anything is written, and can say no', async () => {
    ask.mockResolvedValue('n');
    await contributeCommand('a note', {});
    const { onProposed } = contributeCore.mock.calls[0][0];
    expect(await onProposed({ summary: 's', operations: [{ type: 'addWhy', text: 'x' }] })).toBe(false);
  });

  it('does not ask at all with --auto-approve', async () => {
    await contributeCommand('a note', { autoApprove: true });
    const { onProposed } = contributeCore.mock.calls[0][0];
    expect(await onProposed({ summary: 's', operations: [] })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

