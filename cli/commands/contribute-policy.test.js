/**
 * What the policy is actually for: whether a member's contribution waits.
 *
 * These drive `contributeCore` rather than the decision function, because the
 * bug worth catching is the wiring — a correct policy the write path never
 * asks. Every case here is a member, not the manager, since the manager was
 * never the one being held up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEMBER = { key: 'github:2002', name: 'Ravi', login: 'ravi', source: 'github' };
const MANAGER = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };
let caller = MEMBER;
let operations = [];

vi.mock('../../src/storage.js', () => ({
  writeWorkstreamMd: vi.fn(),
  readTree: vi.fn(() => ({ id: 'main', name: 'M', whys: [] })),
  writeTree: vi.fn(),
  readTreeMd: vi.fn(() => ''),
  writeTreeMd: vi.fn(),
  readProject: vi.fn(() => ({ name: '', whys: [] })),
  readConfig: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'main', name: 'p', whys: [] })),
  writeTree: vi.fn(),
  writeTreeMd: vi.fn(),
  appendContribution: vi.fn(),
  writeRoleFile: vi.fn(),
  writeQueueItem: vi.fn(),
  readContributions: vi.fn(() => []),
  listWorkstreamIds: vi.fn(() => ['main']),
}));
vi.mock('../../src/context.js', () => ({
  updateShared: vi.fn(async () => ({
    workstream: { id: 'main', name: 'p', whys: [] },
    summary: 'a summary',
    operations,
  })),
  generateRoleFile: vi.fn(async () => '# role'),
  serializeToMd: vi.fn(() => '# md'),
}));
vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(async () => ({ committed: true })),
  pushContext: vi.fn(async () => {}),
}));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => caller) }));
vi.mock('../../src/prefs.js', () => ({
  resolveActiveWorkstream: vi.fn(async () => 'main'),
  resolveDisplayName: vi.fn(async () => caller.name),
}));

const { contributeCore } = await import('./contribute.core.js');
const { NEW_PROJECT_POLICY } = await import('../../src/review-policy.js');
const {
  readConfig, writeQueueItem, writeTree,
  writeWorkstreamMd, readWorkstream, listWorkstreamIds,
} = await import('../../src/storage.js');

const project = (over = {}) => ({ project: 'p', me: 'Ada', managerKey: 'github:1001', ...over });
const ADDS = [{ type: 'addWhy', text: 'go to vietnam' }, { type: 'addWhat', text: 'pick dates' }];
const WITH_DELETE = [{ type: 'addWhy', text: 'x' }, { type: 'deleteStatement', id: 'abc' }];

const contribute = () => contributeCore({ text: 'something', source: 'mcp' });

beforeEach(() => { vi.clearAllMocks(); caller = MEMBER; operations = ADDS; });

describe('a project that has never heard of the policy', () => {
  it('queues a member\'s contribution exactly as it always did', async () => {
    readConfig.mockReturnValue(project());
    const r = await contribute();
    expect(r.mode).toBe('queued');
    expect(writeQueueItem).toHaveBeenCalled();
    expect(writeTree).not.toHaveBeenCalled();
  });
});

describe('under additive', () => {
  beforeEach(() => readConfig.mockReturnValue(project({ reviewPolicy: 'additive' })));

  it('lets a member\'s additions land without the manager', async () => {
    // The point of the whole change: nobody waits to add what they know.
    const r = await contribute();
    expect(r.mode).toBe('applied');
    expect(writeTree).toHaveBeenCalled();
    expect(writeQueueItem).not.toHaveBeenCalled();
  });

  it('still queues a contribution that deletes someone else\'s statement', async () => {
    operations = WITH_DELETE;
    const r = await contribute();
    expect(r.mode).toBe('queued');
    expect(writeTree).not.toHaveBeenCalled();
  });

  it('queues an edit as well as a delete', async () => {
    operations = [{ type: 'editStatement', id: 'abc', text: 'reworded' }];
    expect((await contribute()).mode).toBe('queued');
  });

  it('does not make the member a manager by letting them through', async () => {
    // Landing without review is not approval rights. `apply: true` is still the
    // manager's; a member reaching for it gets the ordinary path, and is told the
    // flag was not honoured rather than being handed it.
    const r = await contributeCore({ text: 'x', apply: true });
    expect(r.applyRefused).toBe(true);
  });
});

describe('under all', () => {
  it('queues even a pure addition', async () => {
    readConfig.mockReturnValue(project({ reviewPolicy: 'all' }));
    expect((await contribute()).mode).toBe('queued');
  });
});

describe('under none', () => {
  beforeEach(() => readConfig.mockReturnValue(project({ reviewPolicy: 'none' })));

  it('applies a member who asked to bypass a queue that is not there', async () => {
    // It lands because the project requires review of nothing, not because they
    // asked — and the result still says the flag was not honoured, so nobody
    // reads this as `apply` having worked for a member.
    const r = await contributeCore({ text: 'x', apply: true });
    expect(r.mode).toBe('applied');
    expect(r.applyRefused).toBe(true);
  });

  it('applies a member\'s additions', async () => {
    expect((await contribute()).mode).toBe('applied');
  });

  it('applies a member\'s deletions too, which is the cost of choosing it', async () => {
    operations = WITH_DELETE;
    expect((await contribute()).mode).toBe('applied');
    expect(writeTree).toHaveBeenCalled();
  });
});

describe('things the policy must not change', () => {
  it('leaves a no-op a no-op under every policy', async () => {
    operations = [];
    for (const p of ['all', 'additive', 'none']) {
      vi.clearAllMocks();
      readConfig.mockReturnValue(project({ reviewPolicy: p }));
      expect((await contribute()).mode).toBe('no-op');
      expect(writeQueueItem).not.toHaveBeenCalled();
      expect(writeTree).not.toHaveBeenCalled();
    }
  });

  it('still lets the manager apply directly under the strictest policy', async () => {
    caller = MANAGER;
    readConfig.mockReturnValue(project({ reviewPolicy: 'all' }));
    const r = await contributeCore({ text: 'x', apply: true, source: 'cli' });
    expect(r.mode).toBe('applied');
  });

  it('attributes a policy-applied contribution to whoever sent it', async () => {
    // It landed without review; it did not land as the manager.
    readConfig.mockReturnValue(project({ reviewPolicy: 'additive' }));
    expect((await contribute()).author).toBe('Ravi');
  });
});

describe('a project-level contribution reaching the workstreams', () => {
  // The compiled page of every workstream carries the project above its own,
  // written at compile time. Nothing re-reads it, so without this a member's
  // page kept showing the project as it was before the manager's change.
  beforeEach(() => {
    readConfig.mockReturnValue({
      project: 'Ledger', reviewPolicy: 'none',
      workstreams: [{ id: 'delivery', name: 'Delivery' }],
      roles: [],
    });
    listWorkstreamIds.mockReturnValue(['delivery']);
    readWorkstream.mockReturnValue({ id: 'delivery', name: 'Delivery', whys: [] });
  });

  it('rewrites the page of a workstream it did not touch', async () => {
    await contributeCore({ text: 'no new vendors', apply: true, teamctxDir: '/x' });
    expect(writeWorkstreamMd).toHaveBeenCalledWith('delivery', expect.any(String), '/x');
  });

  it('leaves them alone when the contribution was to a workstream', async () => {
    await contributeCore({ text: 'ship it', workstreamId: 'delivery', apply: true, teamctxDir: '/x' });
    expect(writeWorkstreamMd).not.toHaveBeenCalled();
  });
});

/**
 * A new project reviews everything, and an existing one keeps what it recorded.
 *
 * `NEW_PROJECT_POLICY` and `DEFAULT_POLICY` are now the same value, which makes
 * it easy to believe the migration question answered itself. It did not: the two
 * were separate so that a project could record `additive` and go on running on
 * it. That it still can is the thing worth a test, because nothing else would
 * fail if a later change quietly tightened it.
 */
describe('what a new project does, and what an older one keeps', () => {
  it('queues a member\'s pure addition on a project created now', async () => {
    readConfig.mockReturnValue(project({ reviewPolicy: NEW_PROJECT_POLICY }));
    const r = await contribute();
    expect(r.mode).toBe('queued');
    expect(writeTree).not.toHaveBeenCalled();
  });

  it('leaves a project that recorded additive exactly where it was', async () => {
    // The regression test for "no migration". Without it, that is an intention.
    readConfig.mockReturnValue(project({ reviewPolicy: 'additive' }));
    const r = await contribute();
    expect(r.mode).toBe('applied');
    expect(writeQueueItem).not.toHaveBeenCalled();
  });

  it('still queues a destructive contribution on that older project', async () => {
    // So the test above is not passing because the policy stopped being read.
    readConfig.mockReturnValue(project({ reviewPolicy: 'additive' }));
    operations = WITH_DELETE;
    expect((await contribute()).mode).toBe('queued');
  });
});

/**
 * The founding contribution, which is the one thing the new default could break.
 *
 * `apply: true` short-circuits the gate before the policy is consulted, so the
 * manager's opening message still lands. What used to cover a client that forgot
 * the flag was the old default itself — an add-only founding contribution landed
 * anyway. That cover is gone, so both paths are pinned here rather than left to
 * whether a client read the instructions.
 */
describe('founding a project under the new default', () => {
  beforeEach(() => {
    readConfig.mockReturnValue(project({ reviewPolicy: NEW_PROJECT_POLICY }));
    caller = MANAGER;
  });

  it('lands the manager\'s first contribution immediately with apply', async () => {
    const r = await contributeCore({ text: 'what this is about', source: 'mcp', apply: true });
    expect(r.mode).toBe('applied');
    expect(r.applyRefused).toBeUndefined();
    expect(writeTree).toHaveBeenCalled();
  });

  it('queues it when the client forgets apply, rather than losing it', async () => {
    // Worth knowing rather than worth preventing: the project is then waiting on
    // its manager to approve their own opening message, and `member_add` refuses
    // until they do. The instructions and the tool description are what keep a
    // client from getting here; the contribution is safe either way.
    const r = await contributeCore({ text: 'what this is about', source: 'mcp' });
    expect(r.mode).toBe('queued');
    expect(writeQueueItem).toHaveBeenCalled();
  });

  it('refuses a member who asks to found it, without dropping their words', async () => {
    caller = MEMBER;
    const r = await contributeCore({ text: 'what I think this is about', source: 'mcp', apply: true });
    expect(r.mode).toBe('queued');
    expect(r.applyRefused).toBe(true);
    expect(writeTree).not.toHaveBeenCalled();
  });
});
