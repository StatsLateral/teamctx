import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';

/**
 * An invited member's first run against a project that already exists.
 *
 * The manager's own setup was verified when hosted MCP shipped; this path —
 * somebody else joining afterwards — was first exercised live on a client call
 * (#44). What it needs is not a new mechanism but a record of what "it worked"
 * meant, so the next person to change this code finds out here instead of
 * there.
 *
 * The caller here is neither the repository owner nor the manager: an ordinary
 * collaborator, which is what an invited member is.
 */

// The distiller is the one AI call on the contribute path. Faked so the test is
// about who may contribute and what happens to it, not about what a model says.
vi.mock('../src/context.js', async (importOriginal) => ({
  ...(await importOriginal()),
  updateShared: vi.fn(async (workstream) => ({
    workstream,
    summary: 'Noted the pricing constraint.',
    operations: [{ op: 'add', path: 'whys', value: 'Pricing has to survive a renewal' }],
  })),
}));

const { makeHandlers } = await import('./server.js');

const OWNER = 'acme';
const REPO = 'ledger';

/** The manager, who owns the repo and is pinned as the gate. */
const MANAGER = { key: 'github:1001', name: 'Ada Manager', login: 'ada', source: 'github' };
/** An invited collaborator: not the owner, not the manager. */
const MEMBER = { key: 'github:2002', name: 'Ravi Member', login: 'ravi', source: 'github' };

const CONFIG = {
  project: 'Ledger',
  me: 'whoever-ran-init',
  managerKey: 'github:1001',
  model: 'claude-sonnet-4-6',
  autoPush: false,
  roles: [],
  workstreams: [{ id: 'main', name: 'Ledger' }],
  activeWorkstream: 'main',
  workstreamsMigrated: true,
};

function fakeSession() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: 'a' }],
    ['.teamctx/contributions.jsonl', { content: '', sha: 'b' }],
    ['.teamctx/workstreams/main.json', {
      content: JSON.stringify({ id: 'main', name: 'Ledger', whys: ['Ship a ledger people trust'] }), sha: 'c',
    }],
  ]);
  const commits = [];
  return {
    owner: OWNER, repo: REPO, commits, files,
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c), sha: null }),
    del: p => files.delete(p),
    listDir: d => {
      const prefix = d.endsWith('/') ? d : `${d}/`;
      return [...files.keys()]
        .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    },
    commit: async msg => { commits.push(msg); return { committed: true }; },
  };
}

const HOSTED = { __backend: 'github', owner: OWNER, repo: REPO };
const asUser = (session, actor, fn) =>
  runWithSession(session, () => runWithActor(actor, () => fn(makeHandlers(HOSTED))));
const json = async (p) => JSON.parse((await p).content[0].text);

beforeEach(() => __resetMemory());

describe('an invited member joining a project that already exists', () => {
  it('reads the project without being its owner or manager', async () => {
    // The first thing anyone does after connecting, and the check that the
    // session built from their own token actually reaches the repo.
    const session = fakeSession();
    const ctx = await asUser(session, MEMBER, h => json(h.get_context()));
    expect(JSON.stringify(ctx)).toContain('Ship a ledger people trust');
  });

  it('is identified by their own account, not by config.me', async () => {
    // `config.me` is the manager's machine name. A member inheriting it would
    // make every contribution look like the manager's.
    const session = fakeSession();
    const status = await asUser(session, MEMBER, h => json(h.get_status()));
    expect(status.me).toBe('Ravi Member');
    expect(status.me).not.toBe(CONFIG.me);
  });

  it('queues a contribution for review rather than applying it', async () => {
    const session = fakeSession();
    const r = await asUser(session, MEMBER, h => json(h.contribute({ text: 'Pricing has to survive a renewal' })));
    expect(r.mode).toBe('queued');
    expect(r.author).toBe('Ravi Member');
  });

  it('leaves the shared context untouched until the manager approves', async () => {
    // The property that makes a shared context worth trusting: a member can
    // propose anything and change nothing.
    const session = fakeSession();
    const before = session.read('.teamctx/workstreams/main.json').content;
    await asUser(session, MEMBER, h => json(h.contribute({ text: 'Pricing has to survive a renewal' })));
    expect(session.read('.teamctx/workstreams/main.json').content).toBe(before);
  });

  it("shows the manager the submission, under the member's name", async () => {
    const session = fakeSession();
    await asUser(session, MEMBER, h => json(h.contribute({ text: 'Pricing has to survive a renewal' })));
    const { pending } = await asUser(session, MANAGER, h => json(h.list_pending_reviews()));
    expect(pending).toHaveLength(1);
    expect(pending[0].author).toBe('Ravi Member');
    expect(pending[0].status).toBe('pending');
  });

  it('cannot approve its own submission', async () => {
    // Already true of any non-manager; asserted here because it is the one
    // thing a member must not be able to do on their first run.
    const session = fakeSession();
    const r = await asUser(session, MEMBER, h => json(h.contribute({ text: 'Pricing has to survive a renewal' })));
    await expect(asUser(session, MEMBER, h => h.review_approve({ id: r.id })))
      .rejects.toThrow();
  });
});
