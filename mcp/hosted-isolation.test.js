import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { makeHandlers } from './server.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';

/**
 * Two people on the hosted server at the same time.
 *
 * This is the claim the whole change rests on and the one that cannot be made
 * from the CLI: that when Alice switches workstream, Bob — a different GitHub
 * account, hitting the same repo — still sees his own. Everything else is
 * circumstantial evidence for it.
 *
 * The GitHub network layer is faked (a Map standing in for the prefetched
 * repo); the actor context, the storage dispatch, the preference store and
 * the resolution ladder are all the real thing.
 */

const OWNER = 'acme';
const REPO = 'ledger';

const ALICE = { key: 'github:1001', name: 'Alice Example', login: 'alice', source: 'github' };
const BOB = { key: 'github:2002', name: 'Bob Example', login: 'bob', source: 'github' };

const CONFIG = {
  project: 'Ledger',
  me: 'whoever-ran-init',
  // Gate pinned to Alice's GitHub identity.
  managerKey: 'github:1001',
  model: 'claude-sonnet-4-6',
  autoPush: false,
  roles: [],
  workstreams: [
    { id: 'main', name: 'Ledger' },
    { id: 'engineering-hiring', name: 'Engineering Hiring' },
  ],
  activeWorkstream: 'main',
  workstreamsMigrated: true,
};

/** Stands in for a prefetched GithubSession — same surface storage.js uses. */
function fakeSession() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: 'a' }],
    ['.teamctx/contributions.jsonl', { content: '', sha: 'b' }],
    ['.teamctx/workstreams/main.json', { content: JSON.stringify({ id: 'main', name: 'Ledger', whys: [] }), sha: 'c' }],
    ['.teamctx/workstreams/engineering-hiring.json', { content: JSON.stringify({ id: 'engineering-hiring', name: 'Engineering Hiring', whys: [] }), sha: 'd' }],
  ]);
  const commits = [];
  return {
    owner: OWNER,
    repo: REPO,
    commits,
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c), sha: null }),
    del: p => files.delete(p),
    listDir: dirPath => {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      return [...files.keys()]
        .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length))
        .sort();
    },
    commit: async msg => { commits.push(msg); return { committed: true }; },
    configJson: () => JSON.parse(files.get('.teamctx/config.json').content),
  };
}

const HOSTED_ROOT = { __backend: 'github', owner: OWNER, repo: REPO };

/** One request: an actor, inside a session, against the hosted handlers. */
function asUser(session, actor, fn) {
  return runWithSession(session, () => runWithActor(actor, () => fn(makeHandlers(HOSTED_ROOT))));
}

const json = async (promise) => JSON.parse((await promise).content[0].text);

beforeEach(() => __resetMemory());

describe('two identities on the hosted server', () => {
  it('keeps each person on their own workstream', async () => {
    const session = fakeSession();

    const alice = await asUser(session, ALICE, h => json(h.get_status()));
    const bob = await asUser(session, BOB, h => json(h.get_status()));
    expect(alice.activeWorkstream).toBe('main');
    expect(bob.activeWorkstream).toBe('main');

    // Alice switches.
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));

    const aliceAfter = await asUser(session, ALICE, h => json(h.get_status()));
    const bobAfter = await asUser(session, BOB, h => json(h.get_status()));

    expect(aliceAfter.activeWorkstream).toBe('engineering-hiring');
    // The whole point of the change.
    expect(bobAfter.activeWorkstream).toBe('main');
  });

  it('does not write the switch to the repo or make a commit', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));

    expect(session.configJson().activeWorkstream).toBe('main');
    expect(session.commits).toEqual([]);
  });

  it('identifies each caller by their own GitHub account, not config.me', async () => {
    const session = fakeSession();
    const alice = await asUser(session, ALICE, h => json(h.get_status()));
    const bob = await asUser(session, BOB, h => json(h.get_status()));

    expect(alice.me).toBe('Alice Example');
    expect(bob.me).toBe('Bob Example');
    expect(alice.meSource).toBe('github');
    expect(alice.projectDefaults.me).toBe('whoever-ran-init');
  });

  it('keeps display-name overrides separate', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => h.config_set({ key: 'name', value: 'alice' }));

    const alice = await asUser(session, ALICE, h => json(h.get_status()));
    const bob = await asUser(session, BOB, h => json(h.get_status()));

    expect(alice.me).toBe('alice');
    expect(alice.meSource).toBe('override');
    // Bob never set one, so he still resolves from his own GitHub account.
    expect(bob.me).toBe('Bob Example');
    expect(bob.meSource).toBe('github');
    expect(session.configJson().me).toBe('whoever-ran-init');
  });

  it('interleaves concurrent requests without leaking identity between them', async () => {
    // Vercel reuses an instance across overlapping requests; AsyncLocalStorage
    // is what keeps them apart. Run both users' work at once and check neither
    // sees the other's actor.
    const session = fakeSession();
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));

    const [a, b, a2, b2] = await Promise.all([
      asUser(session, ALICE, h => json(h.get_status())),
      asUser(session, BOB, h => json(h.get_status())),
      asUser(session, ALICE, h => json(h.get_config())),
      asUser(session, BOB, h => json(h.get_config())),
    ]);

    expect([a.me, a.activeWorkstream]).toEqual(['Alice Example', 'engineering-hiring']);
    expect([b.me, b.activeWorkstream]).toEqual(['Bob Example', 'main']);
    expect([a2.me, a2.activeWorkstream]).toEqual(['Alice Example', 'engineering-hiring']);
    expect([b2.me, b2.activeWorkstream]).toEqual(['Bob Example', 'main']);
  });
});


describe('the manager gate cannot be talked around', () => {
  it('lets the pinned manager approve', async () => {
    const session = fakeSession();
    session.write('.teamctx/queue/q-1.json', JSON.stringify({
      id: 'q-1', status: 'pending', workstream: 'main', author: 'bob',
      operations: [{ type: 'addWhy', text: 't', summary: 's' }],
    }));
    const r = await asUser(session, ALICE, h => json(h.review_approve({ id: 'q-1' })));
    expect(r.approvedBy).toBe('Alice Example');
  });

  it('refuses someone who is not the manager', async () => {
    const session = fakeSession();
    await expect(asUser(session, BOB, h => h.review_approve({ id: 'q-1' })))
      .rejects.toThrow(/only the configured manager/);
  });

  it("refuses even when the caller claims the manager's name", async () => {
    // The old hole: `author` was taken at face value and used for the gate.
    const session = fakeSession();
    await expect(asUser(session, BOB, h => h.review_approve({ id: 'q-1', author: 'Alice Example' })))
      .rejects.toThrow(/only the configured manager/);
  });

  it('refuses even after the caller renames themselves to the manager', async () => {
    // The hole this PR would otherwise have opened: config_set name is
    // self-service, so a name-based gate would hand Bob the keys.
    const session = fakeSession();
    await asUser(session, BOB, h => h.config_set({ key: 'name', value: 'Alice Example' }));

    const bob = await asUser(session, BOB, h => json(h.get_status()));
    expect(bob.me).toBe('Alice Example');          // he really is called that now

    await expect(asUser(session, BOB, h => h.review_approve({ id: 'q-1' })))
      .rejects.toThrow(/only the configured manager/);   // and it buys him nothing
  });
});

describe('tasks on the hosted server', () => {
  // Hosted mode has no filesystem: `dir()` hands back a project descriptor, not
  // a path. Every other storage reader already branches on the session; the
  // task *file* helpers did not, so task_compile threw
  // "The path argument must be of type string. Received an instance of Object"
  // the first time anyone reached it over a hosted connector.
  it('adds a task without touching the filesystem', async () => {
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.task_add({ title: 'Ship the ledger' })));
    expect(r.task.id).toBe('t-ship-the-ledger');
    expect(r.committed).toBe(true);
    expect(session.commits.some(m => /task: add t-ship-the-ledger/.test(m))).toBe(true);
  });

  it('reads a task back through the session', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.task_add({ title: 'Ship the ledger' })));
    const got = await asUser(session, ALICE, h => json(h.get_task({ id: 't-ship-the-ledger' })));
    expect(got.title).toBe('Ship the ledger');
    // Nothing has been compiled, so there is no prompt to point at.
    expect(got.promptPath).toBe(null);
  });

  it('reports a compiled prompt as a repo path, never a local one', async () => {
    // There is no local file to open here. A drive letter in this value would
    // mean the caller had been handed a path that does not exist for them.
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.task_add({ title: 'Ship the ledger' })));
    session.write('.teamctx/context/tasks/t-ship-the-ledger.md', '# compiled');

    const got = await asUser(session, ALICE, h => json(h.get_task({ id: 't-ship-the-ledger' })));
    expect(got.promptPath).toBe('.teamctx/context/tasks/t-ship-the-ledger.md');
    expect(got.promptPath).not.toMatch(/^[A-Za-z]:|^\//);
  });

  it('returns the cached prompt from the session rather than spending an AI call', async () => {
    const session = fakeSession();
    const added = await asUser(session, ALICE, h => json(h.task_add({ title: 'Ship the ledger' })));

    // Simulate a previous compile: the prompt file plus the hash that says it
    // is still current for this workstream.
    session.write('.teamctx/context/tasks/t-ship-the-ledger.md', '# already compiled');
    const ws = JSON.parse(session.read('.teamctx/workstreams/main.json').content);
    ws.tasks = ws.tasks.map(t => t.id === added.task.id
      ? { ...t, compiledAt: '2026-01-01T00:00:00.000Z', compiledFromHash: hashOf(ws) }
      : t);
    session.write('.teamctx/workstreams/main.json', JSON.stringify(ws));

    const r = await asUser(session, ALICE, h => json(h.task_compile({ id: 't-ship-the-ledger' })));
    expect(r.alreadyCompiled).toBe(true);
    expect(r.markdown).toBe('# already compiled');
    expect(r.committed).toBe(false);
  });

  // Task tools are deliberately ungated — any member can act on any task, the
  // same as the CLI. The risk that buys is not a permission leak but a *scope*
  // leak: `list_tasks` with no arguments has to mean "my workstream", and the
  // active workstream is per-person preference, not repo state. If it resolved
  // from the config instead of the caller, Bob would open his task list and
  // find Alice's.
  it('scopes an unfiltered list to the caller, not to whoever switched last', async () => {
    const session = fakeSession();

    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));
    await asUser(session, ALICE, h => json(h.task_add({ title: 'Draft the hiring rubric' })));
    await asUser(session, BOB, h => json(h.task_add({ title: 'Reconcile the ledger' })));

    const forAlice = await asUser(session, ALICE, h => json(h.list_tasks()));
    const forBob = await asUser(session, BOB, h => json(h.list_tasks()));

    expect(forAlice.scope).toBe('workstream engineering-hiring');
    expect(forAlice.tasks.map(t => t.id)).toEqual(['t-draft-the-hiring-rubric']);

    // Bob never switched, so he is still on main and sees only what lives there.
    expect(forBob.scope).toBe('workstream main');
    expect(forBob.tasks.map(t => t.id)).toEqual(['t-reconcile-the-ledger']);
  });

  it('gives each caller their own task by default, and both of them --all', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));
    await asUser(session, ALICE, h => json(h.task_add({ title: 'Draft the hiring rubric' })));
    await asUser(session, BOB, h => json(h.task_add({ title: 'Reconcile the ledger' })));

    const everything = await asUser(session, BOB, h => json(h.list_tasks({ all: true })));
    expect(everything.tasks.map(t => t.id).sort())
      .toEqual(['t-draft-the-hiring-rubric', 't-reconcile-the-ledger']);
  });

  it('records the owner as the caller, not as config.me', async () => {
    // `config.me` is 'whoever-ran-init' — a value neither of them should ever
    // be labelled with.
    const session = fakeSession();
    const a = await asUser(session, ALICE, h => json(h.task_add({ title: 'Ship the ledger' })));
    const b = await asUser(session, BOB, h => json(h.task_add({ title: 'Close the books' })));
    expect(a.task.owner).toBe('Alice Example');
    expect(b.task.owner).toBe('Bob Example');
  });

  it('lets Bob act on a task Alice raised', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.task_add({ title: 'Ship the ledger' })));

    // Ungated on purpose: picking up a colleague's task is the ordinary case,
    // and the manager gate exists for approving work, not for doing it.
    const assigned = await asUser(session, BOB,
      h => json(h.task_assign({ id: 't-ship-the-ledger', owner: 'Bob Example' })));
    expect(assigned.task.owner).toBe('Bob Example');

    const done = await asUser(session, BOB, h => json(h.task_done({ id: 't-ship-the-ledger' })));
    expect(done.task.status).toBe('done');

    // And Alice sees the change — one repo, two callers, no per-person copy.
    const seen = await asUser(session, ALICE, h => json(h.get_task({ id: 't-ship-the-ledger' })));
    expect(seen.status).toBe('done');
    expect(seen.owner).toBe('Bob Example');
  });

  it('deletes a task and its prompt through the session', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.task_add({ title: 'Ship the ledger' })));
    session.write('.teamctx/context/tasks/t-ship-the-ledger.md', '# compiled');

    await asUser(session, ALICE, h => json(h.task_rm({ id: 't-ship-the-ledger' })));
    expect(session.read('.teamctx/context/tasks/t-ship-the-ledger.md')).toBe(null);
  });
});

/** The same fingerprint compileTask uses to decide whether a prompt is stale. */
function hashOf(ws) {
  return createHash('sha1')
    .update(JSON.stringify({ name: ws?.name || '', whys: ws?.whys || [] }))
    .digest('hex').slice(0, 16);
}
