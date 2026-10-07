/**
 * The brief a member reads before they start.
 *
 * The pair to the context gate: that one guarantees there is something to
 * read, this is the reading. Before it, the best answer to "what should I be
 * doing" was a bare list of task titles, so an assistant began contributing to
 * a project it had never read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  readProject: vi.fn(() => ({ name: 'Ledger', goal: { text: 'ship the ledger' }, records: [], tasks: [] })),
  readWorkstream: vi.fn((id) => ({ id, name: id, records: [{ id: `r-${id}`, type: 'decision', text: `${id} decision`, status: 'active', attachedTo: { kind: 'workstream', id }, links: {} }], tasks: [] })),
  readRoleFile: vi.fn(() => '# role file'),
  listTasks: vi.fn(() => []),
  listWorkstreamIds: vi.fn(() => ['delivery', 'docs']),
  // The brief now also asks what rests on a broken assumption, which needs every
  // record in the project rather than the reader's own chain — so the whole-tree
  // read is part of this path. `null` is the project's own tree.
  readTree: vi.fn((id) => (id
    ? { id, name: id, records: [{ id: `r-${id}`, type: 'decision', text: `${id} decision`, status: 'active', attachedTo: { kind: 'workstream', id }, links: {} }], tasks: [] }
    : { name: 'Ledger', goal: { text: 'ship the ledger' }, records: [], tasks: [] })),
}));
vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'git:priya@example.com', name: 'Priya' })),
}));
vi.mock('../../src/prefs.js', () => ({ resolveDisplayName: vi.fn(async () => 'Priya') }));

const { buildBrief } = await import('./brief.core.js');
const { readConfig, readProject, readWorkstream, readRoleFile, listTasks, readTree } = await import('../../src/storage.js');
const { resolveActor } = await import('../../src/actor.js');

const PRIYA = { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com' };

const config = {
  project: 'Ledger',
  workstreams: [{ id: 'delivery', name: 'Delivery' }, { id: 'docs', name: 'Documentation' }],
  roles: [{ slug: 'lead', name: 'Delivery Lead', workstream: 'delivery' }],
};

const TASKS = [
  { id: 't1', title: 'book the venue', status: 'open', workstream: null, ownerKey: 'git:priya@example.com' },
  { id: 't2', title: 'draft the email', status: 'open', workstream: 'delivery', owner: 'Priya' },
  { id: 't3', title: 'old one', status: 'done', workstream: 'delivery', ownerKey: 'git:priya@example.com' },
  { id: 't4', title: 'someone else', status: 'open', workstream: 'delivery', owner: 'Dev' },
];

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue(config);
  listTasks.mockReturnValue(TASKS);
  // Re-seeded every test: `clearAllMocks` clears calls, not implementations, so
  // a caller set by one test would otherwise leak into the next.
  resolveActor.mockResolvedValue(PRIYA);
});

describe('whose brief it is', () => {
  it('takes no name — the caller is already known', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.me).toBe('Priya');
  });

  it('carries only their own tasks', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    const ids = r.tasks.open.flatMap(g => g.tasks.map(t => t.id));
    expect(ids).toEqual(['t1', 't2']);
    expect(ids).not.toContain('t4');
  });

  it('matches on the key and on the name, since older tasks carry no key', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    const ids = r.tasks.open.flatMap(g => g.tasks.map(t => t.id));
    expect(ids).toContain('t1');
    expect(ids).toContain('t2');
  });

  it('keeps finished work apart from what is still open', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.tasks.done.flatMap(g => g.tasks.map(t => t.id))).toEqual(['t3']);
    expect(r.tasks.openCount).toBe(2);
  });
});

describe('how the work is laid out', () => {
  it('groups tasks by where the work sits', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.tasks.open.map(g => g.workstream)).toEqual([null, 'delivery']);
  });

  it('names a project-level group after the project, not "null"', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.tasks.open[0].name).toBe('Ledger');
  });

  it('names a workstream group the way a person would say it', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.tasks.open[1].name).toBe('delivery');
  });
});

describe('the context it carries', () => {
  it('renders the workstream under the project, at the moment it is asked for', async () => {
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.context[0].markdown).toContain('ship the ledger');
    expect(r.context[0].markdown).toContain('We decided: delivery decision');
    expect(readWorkstream).toHaveBeenCalledWith('delivery', '/x');
  });

  it('reads the project when the caller stands there', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.context[0].workstream).toBe(null);
    expect(r.context[0].markdown).toContain('ship the ledger');
  });

  it('gives a scoped member their own workstreams and no sibling', async () => {
    const r = await buildBrief({ scope: ['docs'], teamctxDir: '/x' });
    expect(r.context.map(c => c.workstream)).toEqual(['docs']);
    expect(r.context[0].markdown).not.toContain('delivery decision');
  });

  it('says so plainly when there is nothing yet', async () => {
    readProject.mockReturnValueOnce({ name: 'Ledger', goal: null, records: [], tasks: [] });
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.context[0].markdown).toContain('No context yet');
  });
});

describe('the role, if they hold one', () => {
  it('names a role bound to where they are', async () => {
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.role.name).toBe('Delivery Lead');
    expect(r.role.markdown).toBe('# role file');
  });

  it('is null when no role sits there', async () => {
    const r = await buildBrief({ scope: ['docs'], teamctxDir: '/x' });
    expect(r.role).toBe(null);
    expect(readRoleFile).not.toHaveBeenCalled();
  });

  it('survives a role whose file was never generated', async () => {
    readRoleFile.mockImplementation(() => { throw new Error('missing'); });
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.role.markdown).toBe('');
  });
});

describe('the line of framing', () => {
  it('says where they are and points at their open work', async () => {
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.frame).toMatch(/You are on delivery/);
    // Two: the one on delivery and the one at project level. Standing in a
    // workstream does not hide your own work elsewhere — `--mine` never did.
    expect(r.frame).toMatch(/pick up one of your 2 open tasks/);
  });

  it('says something useful when they have nothing assigned', async () => {
    listTasks.mockReturnValue([]);
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.frame).toMatch(/no tasks assigned yet/);
    expect(r.frame).not.toMatch(/undefined|null/);
  });

  it('names the project rather than "null" at project level', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.frame).toMatch(/You are on Ledger/);
  });
});

describe('what it costs', () => {
  it('imports nothing that can spend an AI call', async () => {
    // Stated as a property, not an accident: a member's assistant opens this
    // first, every time, so the read-before-you-write step has to stay the
    // cheapest call in the product.
    //
    // This checks direct imports only — it would not catch a call reached
    // through another module — so it is a tripwire on the obvious regression
    // rather than a proof.
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const subject = fileURLToPath(new URL('./brief.core.js', import.meta.url));
    expect(readFileSync(subject, 'utf-8')).not.toMatch(/from '[^']*\/(ai|context)\.js'/);
  });
});

describe('whose role it is', () => {
  const withEmails = {
    ...config,
    roles: [
      { slug: 'lead', name: 'Delivery Lead', workstream: 'delivery', email: 'dev@example.com' },
      { slug: 'writer', name: 'Writer', workstream: 'delivery', email: 'priya@example.com' },
    ],
  };

  it('prefers the role that carries their address', async () => {
    // Naming somebody else's role as "your role" is worse than naming none.
    readConfig.mockReturnValue(withEmails);
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.role.name).toBe('Writer');
    expect(r.role.yours).toBe(true);
  });

  it('falls back to a role on their thread, and says it is not theirs', async () => {
    readConfig.mockReturnValue(withEmails);
    resolveActor.mockResolvedValue({ key: 'git:sam@example.com', name: 'Sam', email: 'sam@example.com' });
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.role.yours).toBe(false);
  });
});

describe('a scoped member and their own project-level work', () => {
  it('keeps the tasks they hold on the project', async () => {
    // A project-level task resolves to `null`, which is in no scope array and
    // in everybody's scope. Testing the array dropped their own work.
    const r = await buildBrief({ scope: ['delivery'], teamctxDir: '/x' });
    expect(r.tasks.open.flatMap(g => g.tasks.map(t => t.id))).toContain('t1');
  });

  it('still hides a sibling thread', async () => {
    listTasks.mockReturnValue([
      ...TASKS,
      { id: 't5', title: 'theirs elsewhere', status: 'open', workstream: 'docs', owner: 'Priya' },
    ]);
    const r = await buildBrief({ scope: ['delivery'], teamctxDir: '/x' });
    expect(r.tasks.open.flatMap(g => g.tasks.map(t => t.id))).not.toContain('t5');
  });
});

describe('a role that sits at project level', () => {
  // The shape every role has on a project that never split. Matching workstream
  // ids alone dropped it, the same mistake the task filter had.
  const projectRole = {
    ...config,
    roles: [{ slug: 'ops', name: 'Ops', workstream: null, email: 'priya@example.com' }],
  };

  it('is found by a member standing in a workstream', async () => {
    readConfig.mockReturnValue(projectRole);
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.role.name).toBe('Ops');
    expect(r.role.yours).toBe(true);
  });

  it('is found by a scoped member too', async () => {
    readConfig.mockReturnValue(projectRole);
    const r = await buildBrief({ scope: ['delivery'], teamctxDir: '/x' });
    expect(r.role.name).toBe('Ops');
  });

  it('does not drag in a role from a workstream they are not on', async () => {
    readConfig.mockReturnValue({
      ...config,
      roles: [{ slug: 'writer', name: 'Writer', workstream: 'docs' }],
    });
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.role).toBe(null);
  });
});

describe('the order tasks come back in', () => {
  it('is oldest first, the same as `task list`', async () => {
    listTasks.mockReturnValue([
      { id: 'b', title: 'second', status: 'open', workstream: null, owner: 'Priya', createdAt: '2026-02-01' },
      { id: 'a', title: 'first', status: 'open', workstream: null, owner: 'Priya', createdAt: '2026-01-01' },
    ]);
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.tasks.open[0].tasks.map(t => t.id)).toEqual(['a', 'b']);
  });
});

/**
 * What rests on an assumption that broke, in the first thing anyone reads.
 *
 * A member's assistant is told to open this before doing anything. If a decision
 * resting on a broken assumption reads here as settled, the assistant acts on it
 * — which is the whole failure #120 exists to stop, on the cheapest and most
 * frequent call in the product.
 */
describe('a decision resting on something that broke', () => {
  const broken = {
    id: 'a1', type: 'assumption', text: 'buyers need SSO before a pilot',
    status: 'broken', brokenAt: '2026-10-05T09:00:00.000Z',
    owner: { key: 'git:o@x', name: 'O' }, reviewBy: '2026-12-01',
    attachedTo: { kind: 'project' }, links: {},
  };
  const resting = (over = {}) => ({
    id: 'd1', type: 'decision', text: 'build SSO first', status: 'active',
    attachedTo: { kind: 'workstream', id: 'delivery' },
    links: { restsOn: ['a1'] }, ...over,
  });

  const withRecords = (projectRecords, wsRecords) => {
    readProject.mockReturnValue({ name: 'Ledger', goal: { text: 'ship the ledger' }, records: projectRecords, tasks: [] });
    readWorkstream.mockImplementation((id) => ({ id, name: id, records: id === 'delivery' ? wsRecords : [], tasks: [] }));
    readTree.mockImplementation((id) => (id
      ? { id, name: id, records: id === 'delivery' ? wsRecords : [], tasks: [] }
      : { name: 'Ledger', goal: { text: 'ship the ledger' }, records: projectRecords, tasks: [] }));
  };

  it('is marked needing review in the brief', async () => {
    withRecords([broken], [resting()]);
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.context[0].markdown).toContain('We decided: build SSO first');
    expect(r.context[0].markdown).toContain('rests on a broken assumption');
  });

  it('is marked even though the assumption sits in a part of the work, not here', async () => {
    // The reason the flag is worked out from every record in the project rather
    // than from what this brief renders. The assumption is on the project tree;
    // a walk over the reader's chain alone would call this decision sound.
    withRecords([broken], [resting()]);
    const r = await buildBrief({ scope: ['delivery'], teamctxDir: '/x' });
    expect(r.context[0].markdown).toContain('rests on a broken assumption');
  });

  it('does not name the assumption, which the reader may not be allowed to see', async () => {
    withRecords([broken], [resting()]);
    const r = await buildBrief({ scope: ['delivery'], teamctxDir: '/x' });
    expect(r.context[0].markdown).not.toContain('buyers need SSO');
  });

  it('is not marked once the manager has re-confirmed it', async () => {
    withRecords([broken], [resting({ reviewedAt: '2026-10-05T10:00:00.000Z' })]);
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.context[0].markdown).toContain('We decided: build SSO first');
    expect(r.context[0].markdown).not.toContain('rests on a broken assumption');
  });

  it('is gone from the brief entirely once it is replaced', async () => {
    // The other way out, which needed nothing built: a replaced record is not
    // active, so it leaves every brief on its own.
    withRecords([broken], [resting({ status: 'replaced' })]);
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.context[0].markdown).not.toContain('build SSO first');
  });

  it('says nothing about a decision resting on an assumption that still holds', async () => {
    withRecords([{ ...broken, status: 'active' }], [resting()]);
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.context[0].markdown).not.toContain('rests on a broken assumption');
  });
});
