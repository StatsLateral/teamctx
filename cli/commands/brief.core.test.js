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
  readTreeMd: vi.fn(),
  readRoleFile: vi.fn(() => '# role file'),
  listTasks: vi.fn(() => []),
  listWorkstreamIds: vi.fn(() => ['delivery', 'docs']),
}));
vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'git:priya@example.com', name: 'Priya' })),
}));
vi.mock('../../src/prefs.js', () => ({ resolveDisplayName: vi.fn(async () => 'Priya') }));

const { buildBrief } = await import('./brief.core.js');
const { readConfig, readTreeMd, readRoleFile, listTasks } = await import('../../src/storage.js');

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
  readTreeMd.mockImplementation(id => (id === null ? '# Project page' : `# ${id} page`));
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
  it('serves the compiled page, which already holds the project above the workstream', async () => {
    const r = await buildBrief({ activeWorkstream: 'delivery', teamctxDir: '/x' });
    expect(r.context[0].markdown).toBe('# delivery page');
    expect(readTreeMd).toHaveBeenCalledWith('delivery', '/x');
  });

  it('reads the project when the caller stands there', async () => {
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.context[0].workstream).toBe(null);
    expect(r.context[0].markdown).toBe('# Project page');
  });

  it('gives a scoped member their own workstreams and no sibling', async () => {
    const r = await buildBrief({ scope: ['docs'], teamctxDir: '/x' });
    expect(r.context.map(c => c.workstream)).toEqual(['docs']);
  });

  it('says so plainly when nothing has been compiled yet', async () => {
    readTreeMd.mockReturnValue('');
    const r = await buildBrief({ teamctxDir: '/x' });
    expect(r.context[0].markdown).toBe('');
  });

  it('survives a compiled page that cannot be read', async () => {
    readTreeMd.mockImplementation(() => { throw new Error('gone'); });
    await expect(buildBrief({ teamctxDir: '/x' })).resolves.toBeTruthy();
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
  it('spends no AI call', async () => {
    // Stated as a property, not an accident: a member's assistant opens this
    // first, every time. The read-before-you-write step must stay the cheapest
    // call in the product, so the module imports nothing that can spend one.
    const src = await import('fs').then(fs => fs.readFileSync('cli/commands/brief.core.js', 'utf-8'));
    expect(src).not.toMatch(/from '.*\/(ai|context)\.js'/);
  });
});
