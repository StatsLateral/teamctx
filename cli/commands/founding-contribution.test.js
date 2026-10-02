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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The project's trees: `null` is the project's own, ids are workstreams. */
const repo = vi.hoisted(() => ({ trees: new Map() }));

vi.mock('../../src/storage.js', () => ({
  readTree: vi.fn(id => repo.trees.get(id ?? null) || (id ? { id, name: id, records: [], tasks: [] } : { name: 'Ledger', goal: null, records: [], tasks: [] })),
  readProject: vi.fn(() => repo.trees.get(null) || { name: 'Ledger', goal: null, records: [], tasks: [] }),
  readWorkstream: vi.fn(id => repo.trees.get(id) || { id, name: id, records: [], tasks: [] }),
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
  updateShared: vi.fn(async tree => ({
    workstream: {
      ...tree,
      goal: { text: 'Ship the ledger by March' },
      records: [
        { id: 'w1', type: 'decision', text: 'Stay audit-ready', status: 'active' },
        { id: 'd1', type: 'decision', text: 'Reconcile daily', status: 'active' },
      ],
      tasks: [{ id: 'h1', title: 'Import the bank feed', status: 'open' }],
    },
    summary: 'sets the goal',
    operations: [{ type: 'setGoal', text: 'Ship the ledger by March' }, { type: 'addRecord', record: { type: 'decision', text: 'Stay audit-ready' } }],
    dropped: [],
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

const withContext = [{ id: 'w0', type: 'decision', text: 'Already here', status: 'active' }];

beforeEach(() => {
  vi.clearAllMocks();
  repo.trees = new Map();
});

describe('the first contribution to a project', () => {
  it('hands back what the context now holds, not just what changed', async () => {
    repo.trees.set(null, { name: 'Ledger', goal: null, records: [], tasks: [] });
    const r = await contributeCore({ text: 'a long conversation', apply: true });
    expect(r.founding).toBe(true);
    expect(r.digest.goal).toBe('Ship the ledger by March');
    expect(r.digest.settled).toEqual(['Stay audit-ready', 'Reconcile daily']);
    expect(r.digest.counts).toMatchObject({ decision: 2, tasks: 1 });
  });

  it('is still the ordinary applied result underneath', async () => {
    const r = await contributeCore({ text: 'a long conversation', apply: true });
    expect(r.mode).toBe('applied');
    expect(r.summary).toBe('sets the goal');
  });

  it('counts a project whose only content is in a workstream as already started', async () => {
    repo.trees.set(null, { name: 'Ledger', goal: null, records: [], tasks: [] });
    repo.trees.set('product', { id: 'product', name: 'Product', records: withContext, tasks: [] });
    const r = await contributeCore({ text: 'a note for the project', apply: true });
    expect(r.founding).toBeUndefined();
  });
});

describe("the manager's opening message", () => {
  const base = { project: 'Ledger', me: 'Maya', autoPush: false, roles: [], reviewPolicy: 'none' };
  const withConfig = async (over) => {
    const { readConfig } = await import('../../src/storage.js');
    readConfig.mockImplementation(() => ({ ...base, ...over }));
  };
  afterEach(() => withConfig({}));

  it('lands without apply:true, so the project is joinable at once', async () => {
    // Review everything, as a new project does: only the founding rule lets it land.
    await withConfig({ reviewPolicy: 'all' });
    const r = await contributeCore({ text: "We are planning Leo's first birthday" });
    expect(r.mode).toBe('applied');
    expect(r.founding).toBe(true);
  });

  it("still queues a member's first contribution to an empty project", async () => {
    await withConfig({ reviewPolicy: 'all', managerKey: 'git:boss@example.com' });
    const r = await contributeCore({ text: 'hello' });
    expect(r.mode).toBe('queued');
  });

  it("still queues an agent's first contribution", async () => {
    await withConfig({ reviewPolicy: 'all' });
    const r = await contributeCore({ text: 'agent note', reviewRequired: true });
    expect(r.mode).toBe('queued');
  });
});

describe('every contribution after it', () => {
  it('says nothing of the sort — the team already knows what is in there', async () => {
    repo.trees.set(null, { name: 'Ledger', goal: null, records: withContext, tasks: [] });
    const r = await contributeCore({ text: 'one more note', apply: true });
    expect(r.founding).toBeUndefined();
    expect(r.digest).toBeUndefined();
  });

  it('says nothing for the first contribution to a new workstream on a running project', async () => {
    // Splitting a live project and filling the new thread is an ordinary thing
    // to do, and calling it the project's first context is simply wrong.
    repo.trees.set(null, { name: 'Ledger', goal: null, records: withContext, tasks: [] });
    repo.trees.set('billing', { id: 'billing', name: 'Billing', records: [], tasks: [] });
    const r = await contributeCore({ text: 'what billing is for', workstreamId: 'billing', apply: true });
    expect(r.workstream).toBe('billing');
    expect(r.founding).toBeUndefined();
    expect(r.digest).toBeUndefined();
  });

  it('says nothing when the first one goes to review instead of landing', async () => {
    repo.trees.set(null, { name: 'Ledger', goal: null, records: [], tasks: [] });
    const r = await contributeCore({ text: 'a long conversation', reviewRequired: true });
    expect(r.mode).toBe('queued');
    expect(r.digest).toBeUndefined();
  });
});
