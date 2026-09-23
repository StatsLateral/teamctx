/**
 * The contribution that founds a project's context.
 *
 * It is usually a long conversation pasted in at once, and what came back was a
 * summary line and a list of typed operations — neither of which says what the
 * project's context now *is*. So the one person who could correct it had no way
 * to check it, at the one moment when checking is cheap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readTree: vi.fn(),
  writeTree: vi.fn(),
  readTreeMd: vi.fn(() => ''),
  writeTreeMd: vi.fn(),
  readProject: vi.fn(() => ({ name: '', whys: [] })),
  readConfig: vi.fn(() => ({ project: 'Ledger', me: 'Maya', autoPush: false, roles: [], reviewPolicy: 'none' })),
  readWorkstream: vi.fn(() => ({ id: 'main', name: 'M', whys: [] })),
  appendContribution: vi.fn(),
  writeRoleFile: vi.fn(),
  writeQueueItem: vi.fn(),
  readContributions: vi.fn(() => []),
  listWorkstreamIds: vi.fn(() => []),
}));
vi.mock('../../src/context.js', () => ({
  updateShared: vi.fn(async () => ({
    workstream: {
      id: null,
      name: 'Ledger',
      whys: [
        { id: 'w1', text: 'Ship the ledger by March', whats: [{ id: 'a1', text: 'Reconcile daily', hows: [{ id: 'h1', text: 'Import the bank feed' }] }] },
        { id: 'w2', text: 'Stay audit-ready', whats: [] },
      ],
    },
    summary: 'adds two goals',
    operations: [{ type: 'addWhy', text: 'Ship the ledger by March' }, { type: 'addWhy', text: 'Stay audit-ready' }],
  })),
  generateRoleFile: vi.fn(async () => '# role'),
  serializeToMd: vi.fn(() => '# md'),
}));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => ({ key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com' })) }));
vi.mock('../../src/prefs.js', () => ({
  readPrefs: vi.fn(async () => ({})),
  writePrefs: vi.fn(),
  resolveActiveWorkstream: vi.fn(async () => null),
  resolveDisplayName: vi.fn(async ({ actor }) => actor?.name || 'unknown'),
}));

const { contributeCore } = await import('./contribute.core.js');
const { readTree } = await import('../../src/storage.js');

const empty = () => readTree.mockReturnValue({ id: null, name: 'Ledger', whys: [] });
const started = () => readTree.mockReturnValue({ id: null, name: 'Ledger', whys: [{ id: 'w0', text: 'Already here' }] });

beforeEach(() => vi.clearAllMocks());

describe('the first contribution to a project', () => {
  it('hands back what the context now holds, not just what changed', async () => {
    empty();
    const r = await contributeCore({ text: 'a long conversation', apply: true });
    expect(r.founding).toBe(true);
    expect(r.digest.whys.map(w => w.text)).toEqual(['Ship the ledger by March', 'Stay audit-ready']);
    expect(r.digest.whys[0].whats[0]).toEqual({ text: 'Reconcile daily', hows: ['Import the bank feed'] });
    expect(r.digest.totals).toEqual({ whys: 2, whats: 1, hows: 1 });
  });

  it('is still the ordinary applied result underneath', async () => {
    empty();
    const r = await contributeCore({ text: 'a long conversation', apply: true });
    expect(r.mode).toBe('applied');
    expect(r.summary).toBe('adds two goals');
  });
});

describe('every contribution after it', () => {
  it('says nothing of the sort — the team already knows what is in there', async () => {
    started();
    const r = await contributeCore({ text: 'one more note', apply: true });
    expect(r.founding).toBeUndefined();
    expect(r.digest).toBeUndefined();
  });

  it('says nothing when the first one goes to review instead of landing', async () => {
    // Nothing is in the context yet, so there is nothing to read back.
    empty();
    const r = await contributeCore({ text: 'a long conversation', reviewRequired: true });
    expect(r.mode).toBe('queued');
    expect(r.digest).toBeUndefined();
  });
});
