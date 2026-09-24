/**
 * The contribution that founds a project's context.
 *
 * It is usually a long conversation pasted in at once, and what came back was a
 * summary line and a list of typed operations — neither of which says what the
 * project's context now *is*. So the one person who could correct it had no way
 * to check it, at the one moment when checking is cheap.
 *
 * "Founding" is a property of the project, not of the tree being written: a new
 * workstream on a running project starts empty and is not the project starting.
 * The storage here answers per tree for exactly that reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The project's trees: `null` is the project's own, ids are workstreams. */
const repo = vi.hoisted(() => ({ trees: new Map() }));

vi.mock('../../src/storage.js', () => ({
  readTree: vi.fn(id => repo.trees.get(id ?? null) || { id: id ?? null, name: 'Ledger', whys: [] }),
  readProject: vi.fn(() => repo.trees.get(null) || { name: 'Ledger', whys: [] }),
  readWorkstream: vi.fn(id => repo.trees.get(id) || { id, name: id, whys: [] }),
  listWorkstreamIds: vi.fn(() => [...repo.trees.keys()].filter(k => k !== null)),
  writeTree: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  readTreeMd: vi.fn(() => ''),
  writeTreeMd: vi.fn(),
  readConfig: vi.fn(() => ({ project: 'Ledger', me: 'Maya', autoPush: false, roles: [], reviewPolicy: 'none' })),
  appendContribution: vi.fn(),
  writeRoleFile: vi.fn(),
  writeQueueItem: vi.fn(),
  readContributions: vi.fn(() => []),
}));
vi.mock('../../src/context.js', () => ({
  updateShared: vi.fn(async workstream => ({
    workstream: {
      ...workstream,
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

const withContext = [{ id: 'w0', text: 'Already here', whats: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  repo.trees = new Map();
});

describe('the first contribution to a project', () => {
  it('hands back what the context now holds, not just what changed', async () => {
    repo.trees.set(null, { name: 'Ledger', whys: [] });
    const r = await contributeCore({ text: 'a long conversation', apply: true });
    expect(r.founding).toBe(true);
    expect(r.digest.whys.map(w => w.text)).toEqual(['Ship the ledger by March', 'Stay audit-ready']);
    expect(r.digest.whys[0].whats[0]).toEqual({ text: 'Reconcile daily', hows: ['Import the bank feed'] });
    expect(r.digest.totals).toEqual({ whys: 2, whats: 1, hows: 1 });
  });

  it('is still the ordinary applied result underneath', async () => {
    const r = await contributeCore({ text: 'a long conversation', apply: true });
    expect(r.mode).toBe('applied');
    expect(r.summary).toBe('adds two goals');
  });

  it('counts a project whose only content is in a workstream as already started', async () => {
    repo.trees.set(null, { name: 'Ledger', whys: [] });
    repo.trees.set('product', { id: 'product', name: 'Product', whys: withContext });
    const r = await contributeCore({ text: 'a note for the project', apply: true });
    expect(r.founding).toBeUndefined();
  });
});

describe('every contribution after it', () => {
  it('says nothing of the sort — the team already knows what is in there', async () => {
    repo.trees.set(null, { name: 'Ledger', whys: withContext });
    const r = await contributeCore({ text: 'one more note', apply: true });
    expect(r.founding).toBeUndefined();
    expect(r.digest).toBeUndefined();
  });

  it('says nothing for the first contribution to a new workstream on a running project', async () => {
    // Splitting a live project and filling the new thread is an ordinary thing
    // to do, and calling it the project's first context is simply wrong.
    repo.trees.set(null, { name: 'Ledger', whys: withContext });
    repo.trees.set('billing', { id: 'billing', name: 'Billing', whys: [] });
    const r = await contributeCore({ text: 'what billing is for', workstreamId: 'billing', apply: true });
    expect(r.workstream).toBe('billing');
    expect(r.founding).toBeUndefined();
    expect(r.digest).toBeUndefined();
  });

  it('says nothing when the first one goes to review instead of landing', async () => {
    repo.trees.set(null, { name: 'Ledger', whys: [] });
    const r = await contributeCore({ text: 'a long conversation', reviewRequired: true });
    expect(r.mode).toBe('queued');
    expect(r.digest).toBeUndefined();
  });
});
