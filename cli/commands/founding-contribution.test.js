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
  writeChange: vi.fn(), listChanges: vi.fn(() => []),
  readTree: vi.fn(id => repo.trees.get(id ?? null) || (id ? { id, name: id, records: [], tasks: [] } : { name: 'Ledger', goal: null, records: [], tasks: [] })),
  readProject: vi.fn(() => repo.trees.get(null) || { name: 'Ledger', goal: null, records: [], tasks: [] }),
  readWorkstream: vi.fn(id => repo.trees.get(id) || { id, name: id, records: [], tasks: [] }),
  listWorkstreamIds: vi.fn(() => [...repo.trees.keys()].filter(k => k !== null)),
  writeTree: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  readTreeMd: vi.fn(() => ''),
  writeTreeMd: vi.fn(),
  writeConfig: vi.fn(),
  withCounters: vi.fn((dir, write) => write({ nextKey: {} })),
  readConfig: vi.fn(() => ({ project: 'Ledger', me: 'Maya', autoPush: false, roles: [], reviewPolicy: 'none' })),
  appendContribution: vi.fn(),
  writeRoleFile: vi.fn(),
  writeQueueItem: vi.fn(),
  writeApproved: vi.fn(),
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
    operations: [{ type: 'setGoal', text: 'Ship the ledger by March' }, { type: 'addRecord', record: { type: 'decision', text: 'Stay audit-ready' } }, { type: 'addRecord', record: { type: 'decision', text: 'Reconcile daily' } }, { type: 'addTask', title: 'Import the bank feed' }],
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
    // The proposal included a task, but a task belongs to a workstream and this
    // contribution is to the project itself, so it is dropped and said so.
    expect(r.digest.counts).toMatchObject({ decision: 2, tasks: 0 });
    expect(r.dropped.map(d => d.reason).join(' ')).toMatch(/belongs to a workstream/);
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
    const { readConfig, withCounters } = await import('../../src/storage.js');
    readConfig.mockImplementation(() => ({ ...base, ...over }));
    // The counters are kept in the config, so the lock hands over the same one.
    withCounters.mockImplementation((dir, write) => write({ ...base, ...over, nextKey: {} }));
  };
  afterEach(() => withConfig({}));

  it('lands without apply:true, so the project is joinable at once', async () => {
    // Review everything, as a new project does: only the founding rule lets it land.
    await withConfig({ reviewPolicy: 'all' });
    const r = await contributeCore({ text: "We are planning Leo's first birthday" });
    expect(r.mode).toBe('applied');
    expect(r.founding).toBe(true);
  });

  it('names the part of the work it went to by its number', async () => {
    await withConfig({ workstreams: [{ id: 'itinerary', name: 'Itinerary', number: 1 }] });
    repo.trees.set(null, { name: 'Ledger', goal: null, records: [], tasks: [] });
    repo.trees.set('itinerary', { id: 'itinerary', name: 'Itinerary', records: [], tasks: [] });
    const r = await contributeCore({ text: 'the trip', workstreamId: 'itinerary', apply: true });
    expect(r.founding).toBe(true);
    expect(r.digest.workstreams).toEqual([expect.objectContaining({ number: 1, name: 'Itinerary' })]);
  });

  // The mocked proposal carries a goal and a task, as a founding message does.
  const written = async (id) => {
    const { writeTree } = await import('../../src/storage.js');
    return writeTree.mock.calls.filter(([tid]) => tid === id).map(([, tree]) => tree).pop();
  };

  it('sent to a workstream, still gives the project its goal', async () => {
    await withConfig({ workstreams: [{ id: 'itinerary', name: 'Itinerary', number: 1 }] });
    repo.trees.set(null, { name: 'Ledger', goal: null, records: [], tasks: [] });
    repo.trees.set('itinerary', { id: 'itinerary', name: 'Itinerary', records: [], tasks: [] });
    const r = await contributeCore({ text: 'the trip', workstreamId: 'itinerary', apply: true });
    expect((await written(null)).goal.text).toBe('Ship the ledger by March');
    expect((await written('itinerary')).tasks.map(t => t.title)).toEqual(['Import the bank feed']);
    expect(r.dropped).toEqual([]);
  });

  it("sent to the project, puts its tasks in the project's only part of the work", async () => {
    await withConfig({ workstreams: [{ id: 'itinerary', name: 'Itinerary', number: 1 }] });
    repo.trees.set(null, { name: 'Ledger', goal: null, records: [], tasks: [] });
    repo.trees.set('itinerary', { id: 'itinerary', name: 'Itinerary', records: [], tasks: [] });
    const r = await contributeCore({ text: 'the trip', apply: true });
    expect((await written('itinerary')).tasks.map(t => t.key)).toEqual(['1.1']);
    expect(r.tasks).toEqual([expect.objectContaining({ key: '1.1' })]);
    expect(r.digest.workstreams).toEqual([expect.objectContaining({ name: 'Itinerary', tasks: 1 })]);
    expect(r.dropped).toEqual([]);
  });

  it('with several parts of the work, leaves a task out and says to name its part', async () => {
    await withConfig({ workstreams: [{ id: 'a', name: 'A', number: 1 }, { id: 'b', name: 'B', number: 2 }] });
    repo.trees.set(null, { name: 'Ledger', goal: null, records: [], tasks: [] });
    const r = await contributeCore({ text: 'the trip', apply: true });
    expect(r.dropped.map(d => d.reason).join(' ')).toMatch(/send it to the part it is for/);
    expect(r.dropped.map(d => d.reason).join(' ')).not.toMatch(/add a workstream first/);
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
