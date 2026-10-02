/**
 * What the configuration tells somebody about a project they are only part of.
 *
 * `get_status` and `list_roles` both filter the workstreams and roles they
 * return, and say why: a role name and the workstream it belongs to are among
 * the things a scope exists to keep back. `get_config` returned the lot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { makeHandlers } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const OWNER = 'acme';
const REPO = 'ledger';
const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const PRIYA = { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', source: 'google' };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', name: 'Product' }, { id: 'tech', name: 'Secret Skunkworks' }],
  roles: [
    { slug: 'pm', name: 'Product lead', workstream: 'product', email: 'priya@example.com' },
    { slug: 'eng', name: 'Platform lead', workstream: 'tech', email: 'dev@example.com' },
  ],
  members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] }],
};

function session() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Ledger', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/workstreams/product.json', { content: JSON.stringify({ id: 'product', name: 'Product', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/workstreams/tech.json', { content: JSON.stringify({ id: 'tech', name: 'Secret Skunkworks', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/contributions.jsonl', { content: '', sha: null }],
  ]);
  return {
    owner: OWNER,
    repo: REPO,
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

const call = (tool, actor) => runWithSession(session(), () => runWithActor(actor, async () => {
  const handlers = makeHandlers({ __backend: 'github', owner: OWNER, repo: REPO });
  return JSON.parse((await handlers[tool]()).content[0].text);
}));

beforeEach(() => __resetMemory());

describe('the configuration a scoped member can read', () => {
  it('names only the parts of the work they are on', async () => {
    const r = await call('get_config', PRIYA);
    expect(r.workstreams.map(w => w.id)).toEqual(['product']);
    expect(JSON.stringify(r)).not.toContain('Secret Skunkworks');
  });

  it('names only the roles on those parts', async () => {
    const r = await call('get_config', PRIYA);
    expect(r.roles.map(role => role.slug)).toEqual(['pm']);
    // The role carried an address with it, which is somebody else's.
    expect(JSON.stringify(r)).not.toContain('dev@example.com');
  });

  it('says what it was scoped to, so nothing looks like the whole project', async () => {
    expect((await call('get_config', PRIYA)).scopedTo).toEqual(['product']);
  });

  it('gives the manager all of it, because a manager has no scope', async () => {
    const r = await call('get_config', MAYA);
    expect(r.workstreams.map(w => w.id).sort()).toEqual(['product', 'tech']);
    expect(r.roles).toHaveLength(2);
    expect(r.scopedTo).toBeUndefined();
  });
});
