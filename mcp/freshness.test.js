/**
 * How fresh the context is (#183), where an assistant reads it: `get_status`
 * says when something was last approved and how much is waiting, and a role
 * file carries the same as a line under its title.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const { makeHandlers } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');
const { emptyProject, emptyWorkstream } = await import('../src/model.js');

const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const PRIYA = { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', source: 'google' };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', name: 'Product' }, { id: 'tech', name: 'Tech' }],
  roles: [{ slug: 'pm', name: 'Product lead', workstream: 'product', email: 'priya@example.com' }],
  members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] }],
};

const day = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function session({ approvals = [], queue = [] } = {}) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify(emptyProject('Ledger')), sha: null }],
    ['.teamctx/workstreams/product.json', { content: JSON.stringify(emptyWorkstream('product', 'Product')), sha: null }],
    ['.teamctx/workstreams/tech.json', { content: JSON.stringify(emptyWorkstream('tech', 'Tech')), sha: null }],
    ['.teamctx/contributions.jsonl', { content: '', sha: null }],
    ['.teamctx/context/roles/pm.md', { content: '# Product lead Context — Ledger\n\n## Your Role\nShip it.', sha: null }],
    ...approvals.map(a => [`.teamctx/approved/${a.id}.json`, { content: JSON.stringify(a), sha: null }]),
    ...queue.map(q => [`.teamctx/queue/${q.id}.json`, { content: q.raw ?? JSON.stringify(q), sha: null }]),
  ]);
  return {
    owner: 'acme',
    repo: 'ledger',
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c), sha: null }),
    del: p => files.delete(p),
    listDir: (d) => {
      const prefix = d.endsWith('/') ? d : `${d}/`;
      return [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    },
    commit: async () => ({ committed: true }),
  };
}

const call = (files, actor, tool, args) => runWithSession(session(files), () => runWithActor(actor, async () => {
  const handlers = makeHandlers({ __backend: 'github', owner: 'acme', repo: 'ledger' });
  return (await handlers[tool](args)).content[0].text;
}));

const APPROVED = [{ id: 'c-1', approvedAt: day(30) }, { id: 'c-2', approvedAt: day(12) }];
const QUEUE = [
  { id: 'q-1', workstream: 'product', createdAt: day(1) },
  { id: 'q-2', workstream: 'tech', createdAt: day(1) },
  { id: 'q-3', workstream: 'tech', createdAt: day(0) },
];

beforeEach(() => __resetMemory());

describe('get_status says how fresh the context is', () => {
  it('the newest approval and everything waiting, for the manager', async () => {
    const r = JSON.parse(await call({ approvals: APPROVED, queue: QUEUE }, MAYA, 'get_status'));
    expect(r.lastApprovedAt).toBe(APPROVED[1].approvedAt);
    expect(r.waiting).toBe(3);
  });

  it('only what is waiting in their own parts, for a scoped member', async () => {
    const r = JSON.parse(await call({ approvals: APPROVED, queue: QUEUE }, PRIYA, 'get_status'));
    expect(r.waiting).toBe(1);
  });

  it('no date when none was recorded, and nothing waiting', async () => {
    const r = JSON.parse(await call({}, MAYA, 'get_status'));
    expect(r.lastApprovedAt).toBeNull();
    expect(r.waiting).toBe(0);
  });

  it('still answers when a queue file is broken, without the two facts', async () => {
    const r = JSON.parse(await call({ queue: [{ id: 'q-bad', raw: '{' }] }, MAYA, 'get_status'));
    expect(r.project).toBe('Ledger');
    expect(r).not.toHaveProperty('waiting');
  });
});

describe('a role file says how fresh it is', () => {
  it('under its title, from get_role_context', async () => {
    const md = await call({ approvals: APPROVED, queue: QUEUE }, PRIYA, 'get_role_context', { role: 'pm' });
    expect(md).toBe('# Product lead Context — Ledger\n\n*Context last approved 12 days ago; 1 item waiting for review.*\n\n## Your Role\nShip it.');
  });

  it('not freshened by an approval in a part of the work it does not cover', async () => {
    const approvals = [...APPROVED, { id: 'c-tech', workstream: 'tech', approvedAt: day(0) }];
    const md = await call({ approvals }, MAYA, 'get_role_context', { role: 'pm' });
    expect(md).toContain('*Context last approved 12 days ago;');
  });

  it('in my_brief', async () => {
    const r = JSON.parse(await call({ queue: QUEUE }, PRIYA, 'my_brief'));
    expect(r.role.markdown).toContain('*Context last approved: not recorded; 1 item waiting for review.*');
  });
});
