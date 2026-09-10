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
const { readConfig, writeQueueItem, writeTree } = await import('../../src/storage.js');

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
    // manager's, and a member reaching for it is still refused.
    await expect(contributeCore({ text: 'x', apply: true }))
      .rejects.toThrow(/only the configured manager/);
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
