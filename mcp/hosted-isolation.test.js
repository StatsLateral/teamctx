import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { makeHandlers, TOOLS } from './server.js';
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
  // Already migrated, so the tests below exercise the server rather than the
  // migration. The legacy shape is a fixture of its own, at the end of the file.
  projectLayerMigrated: true,
};

/** Stands in for a prefetched GithubSession — same surface storage.js uses. */
function fakeSession() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: 'a' }],
    ['.teamctx/contributions.jsonl', { content: '', sha: 'b' }],
    // Non-empty: nobody can be brought onto a project with nothing in it, so a
    // fixture with an empty tree would be testing that gate in every test here.
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Ledger', whys: [{ id: 'p1', text: 'ship the ledger' }] }), sha: 'p' }],
    ['.teamctx/workstreams/main.json', { content: JSON.stringify({ id: 'main', name: 'Ledger', whys: [] }), sha: 'c' }],
    ['.teamctx/workstreams/engineering-hiring.json', { content: JSON.stringify({ id: 'engineering-hiring', name: 'Engineering Hiring', whys: [] }), sha: 'd' }],
  ]);
  const commits = [];
  const commitOpts = [];
  return {
    owner: OWNER,
    repo: REPO,
    // Without this, `creatorViaApi` bails before it ever calls fetch and the
    // repair tests below pass on the display-name fallback instead of the
    // history — which is the escalation they exist to rule out.
    ghToken: 'gh-lent-token',
    commits,
    commitOpts,
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
    commit: async (msg, opts) => { commits.push(msg); commitOpts.push(opts || {}); return { committed: true }; },
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
    // Nobody has chosen a workstream, so both are at project level.
    expect(alice.activeWorkstream).toBe(null);
    expect(bob.activeWorkstream).toBe(null);

    // Alice switches.
    await asUser(session, ALICE, h => h.workstream_use({ id: 'engineering-hiring' }));

    const aliceAfter = await asUser(session, ALICE, h => json(h.get_status()));
    const bobAfter = await asUser(session, BOB, h => json(h.get_status()));

    expect(aliceAfter.activeWorkstream).toBe('engineering-hiring');
    // The whole point of the change: Bob stays where he was, which is the
    // project, because he never chose anything.
    expect(bobAfter.activeWorkstream).toBe(null);
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
    expect([b.me, b.activeWorkstream]).toEqual(['Bob Example', null]);
    expect([a2.me, a2.activeWorkstream]).toEqual(['Alice Example', 'engineering-hiring']);
    expect([b2.me, b2.activeWorkstream]).toEqual(['Bob Example', null]);
  });
});


describe('a config change made over the hosted server', () => {
  // It reported success and vanished. A hosted write lands in the session's
  // in-memory copy of the repo; without a commit the request ended and the
  // change was gone, while the tool still said it had worked.
  it('reaches the repository rather than only the session', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.config_set({ key: 'deployUrl', value: 'https://x.vercel.app' })));
    expect(session.configJson().deployUrl).toBe('https://x.vercel.app');
    expect(session.commits.some(m => /config: deployUrl/.test(m))).toBe(true);
  });

  it('says whether it committed, so a caller cannot claim more than happened', async () => {
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.config_set({ key: 'deployUrl', value: 'https://x.vercel.app' })));
    expect(r.committed).toBe(true);
  });

  it('says in the sentence a client reads out whether it persisted', async () => {
    // The tool description tells callers to report `reportBack` verbatim, so a
    // success string that does not depend on the write is a false success said
    // out loud — which is how the missing commit went unnoticed.
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.config_set({ key: 'deployUrl', value: 'https://x.vercel.app' })));
    expect(r.reportBack).toMatch(/Committed to the repo/);
  });

  it('reports the commit it actually made, not the one it attempted', async () => {
    // Writing the value already stored leaves nothing to commit. Claiming
    // otherwise hands back a success only a read-back could disprove.
    const session = fakeSession();
    session.commit = async () => ({ committed: false });
    const r = await asUser(session, ALICE, h => json(h.config_set({ key: 'deployUrl', value: 'https://x.vercel.app' })));
    expect(r.committed).toBe(false);
    expect(r.reportBack).toMatch(/Nothing was committed/);
  });

  it('does not commit a personal setting, which never belonged in the repo', async () => {
    // A display name is stored against the caller, not the project. Committing
    // it would rename them for everyone.
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.config_set({ key: 'name', value: 'Alice A.' })));
    expect(r.committed).toBe(false);
    expect(session.commits).toEqual([]);
  });
});

describe('handing a member the connector URL', () => {
  it('builds it from the repository the request is already for', async () => {
    // The hosted server has no clone and no git remote to read; the owner and
    // repo are in the request URL it was reached on.
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.config_set({ key: 'deployUrl', value: 'https://x.vercel.app/' })));
    const r = await asUser(session, ALICE, h => json(h.get_connect_url()));
    expect(r.url).toBe(`https://x.vercel.app/api/mcp/${OWNER}/${REPO}`);
  });

  it('says what to set when no deploy URL is recorded', async () => {
    // The usual reason it is missing, and unanswerable without being told.
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.get_connect_url()));
    expect(r.url).toBeUndefined();
    expect(r.reportBack).toMatch(/deployUrl/);
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

describe('asking who the manager is', () => {
  // `config.manager` is the legacy display-name field and is empty on every
  // project created since the gate moved to `managerKey` — so reading it
  // answered "no manager" for a project that had one. Both tools are asserted
  // together because fixing one and not the other is how this survived twice.
  it('get_status reports the gate, not the empty legacy field', async () => {
    const session = fakeSession();
    const s = await asUser(session, ALICE, h => json(h.get_status()));
    expect(s.manager).toBe(CONFIG.managerKey);
    expect(s.manager).not.toBeNull();
  });

  it('get_config reports the same answer', async () => {
    const session = fakeSession();
    const c = await asUser(session, ALICE, h => json(h.get_config()));
    expect(c.manager).toBe(CONFIG.managerKey);
  });

  it('keeps the display name available under its own name', async () => {
    // Still worth returning — it is just not the answer to "who is the manager".
    const session = fakeSession();
    const s = await asUser(session, ALICE, h => json(h.get_status()));
    expect(s).toHaveProperty('managerDisplayName');
  });
});

describe('repairing a manager gate over the hosted server', () => {
  // Exposed here because the creator check refuses by identity, whatever
  // credential the request runs on — a member acting on the project's lent
  // token is still not the person who created it.
  const brokenSession = () => {
    const s = fakeSession();
    const c = { ...CONFIG, managerKey: 'name:Alice Example', managerKeys: [] };
    s.write('.teamctx/config.json', JSON.stringify(c));
    return s;
  };

  it('lets the creator re-pin a gate nobody can match', async () => {
    const session = brokenSession();
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ([{ commit: { author: { email: '1001+alice@users.noreply.github.com' } } }]),
    });
    const r = await asUser(session, ALICE, h => json(h.repair_manager_gate()));
    expect(r).toMatchObject({ from: 'name:Alice Example', to: ALICE.key });
    expect(session.configJson().managerKey).toBe(ALICE.key);
  });

  it('refuses somebody who did not create the project', async () => {
    // The reason this is safe to expose at all. Bob reaches the repo on the
    // project's lent credential, which has push access — the check is on who he
    // is, not on what token carried the request.
    const session = brokenSession();
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ([{ commit: { author: { email: '1001+alice@users.noreply.github.com' } } }]),
    });
    await expect(asUser(session, BOB, h => h.repair_manager_gate())).rejects.toThrow();
    expect(session.configJson().managerKey).toBe('name:Alice Example');
  });


  it('refuses a member who renamed themselves to the gate', async () => {
    // The escalation as it would actually be run: Mallory reads the gate's
    // display name from get_config, sets her own to match, and catches the
    // commits API on a bad minute. Nothing here is privileged.
    const session = brokenSession();
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const mallory = { key: 'github:9999', name: 'Alice Example', login: 'mallory', source: 'github' };
    await expect(asUser(session, mallory, h => h.repair_manager_gate())).rejects.toThrow();
    expect(session.configJson().managerKey).toBe('name:Alice Example');
  });

  it('tells the real creator to try again when GitHub is unreachable', async () => {
    // The same refusal, reaching the person the command is for. It has to read
    // as temporary, because on a connector there is no config.json to edit and
    // a permanent no would strand them.
    const session = brokenSession();
    globalThis.fetch = async () => { throw new Error('offline'); };
    await expect(asUser(session, ALICE, h => h.repair_manager_gate())).rejects.toThrow(/try again/i);
  });

  it('walks past the first page to find the commit that created the file', async () => {
    // A config.json touched more than a hundred times used to yield the
    // hundredth-newest commit's author — a confidently wrong creator.
    const session = brokenSession();
    const page = (email, n) => Array.from({ length: n }, () => ({ commit: { author: { email } } }));
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      return {
        ok: true,
        json: async () => (call === 1
          ? page('someone-else@example.com', 100)
          : page('1001+alice@users.noreply.github.com', 3)),
      };
    };
    const r = await asUser(session, ALICE, h => json(h.repair_manager_gate()));
    expect(call).toBe(2);
    expect(r).toMatchObject({ to: ALICE.key });
  });

  it('refuses a gate that already works', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.repair_manager_gate())).rejects.toThrow(/real identity/i);
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
    // is still current. A task with no workstream lives in the project tree.
    session.write('.teamctx/context/tasks/t-ship-the-ledger.md', '# already compiled');
    const ws = JSON.parse(session.read('.teamctx/project.json').content);
    ws.tasks = ws.tasks.map(t => t.id === added.task.id
      ? { ...t, compiledAt: '2026-01-01T00:00:00.000Z', compiledFromHash: hashOf(ws) }
      : t);
    session.write('.teamctx/project.json', JSON.stringify(ws));

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

    // Bob never switched, so he is still at project level and sees only what
    // lives there.
    expect(forBob.scope).toBe('the project');
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

describe('project members on the hosted server', () => {
  it('lets the manager add someone, and records who added them', async () => {
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.member_add({ ref: 'priyar' })));
    expect(r.member.login).toBe('priyar');
    expect(session.configJson().members).toHaveLength(1);
  });

  it('refuses a non-manager, and leaves the roster alone', async () => {
    // Adding yourself to the roster would otherwise be the way past every
    // other gate on the project.
    const session = fakeSession();
    await expect(asUser(session, BOB, h => h.member_add({ ref: 'priyar' })))
      .rejects.toThrow(/manager/i);
    expect(session.configJson().members || []).toHaveLength(0);
  });

  it('attributes the commit to the caller, not to the token', async () => {
    // Without this every hosted commit is authored by whoever's credential
    // made the write, so a whole team shows up as one contributor in git log.
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.member_add({ ref: 'priyar' })));
    const author = session.commitOpts[0]?.author;
    expect(author?.name).toBe(ALICE.name);
    expect(author?.email).toMatch(/@users\.noreply\.github\.com$/);
  });

  it('does not invite anyone unless asked', async () => {
    const session = fakeSession();
    globalThis.fetch = vi.fn();
    await asUser(session, ALICE, h => json(h.member_add({ ref: 'priyar' })));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('lists members back', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.member_add({ ref: 'priyar', name: 'Priya Raman' })));
    const { members } = await asUser(session, BOB, h => json(h.list_members({})));
    expect(members[0].name).toBe('Priya Raman');
  });

  it('removing from the roster does not claim to revoke access', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.member_add({ ref: 'priyar' })));
    const r = await asUser(session, ALICE, h => json(h.member_rm({ ref: 'priyar' })));
    expect(r.stillHasRepoAccess).toBe(true);
    expect(r.reportBack).toMatch(/GitHub access is unchanged/);
  });
});

describe('adding someone hands over the link that lets them in', () => {
  // Observed on a real project: two people were added, the tool reported
  // success twice, and neither was ever sent anything — the connector URL took
  // a second call nobody made. Roster entry plus no link invites nobody.
  it('returns the connect URL alongside the new member', async () => {
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.config_set({ key: 'deployUrl', value: 'https://x.vercel.app' })));
    const r = await asUser(session, ALICE, h => json(h.member_add({ ref: 'ravi@example.com', name: 'Ravi' })));
    expect(r.member.name).toBe('Ravi');
    expect(r.connectUrl).toContain('x.vercel.app');
    expect(r.reportBack).toContain(r.connectUrl);
  });

  it('never claims there is no link, because the caller is holding one', async () => {
    // "Added to the project" on its own is the failure the manager hit. But
    // "there is no link" would be its own lie: whoever is calling reached this
    // project through a connector, so a link demonstrably exists — the server
    // just could not build it. So the guidance points at the one they have
    // rather than reporting a dead end.
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.member_add({ ref: 'ravi@example.com', name: 'Ravi' })));
    expect(r.connectUrl).toBe(null);
    expect(r.reportBack).not.toMatch(/no link/i);
    expect(r.reportBack).toMatch(/connector this conversation is using/i);
    expect(r.reportBack).toMatch(/deployUrl/);
  });

  it('still reports the roster entry when there is no link', async () => {
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.member_add({ ref: 'ravi@example.com', name: 'Ravi' })));
    expect(r.reportBack).toMatch(/Ravi added to the project/);
    expect(session.configJson().members.some(m => m.email === 'ravi@example.com')).toBe(true);
  });

  it('gives get_connect_url and member_add the same link', async () => {
    // One resolution, so the two cannot drift into disagreeing about the URL.
    const session = fakeSession();
    await asUser(session, ALICE, h => json(h.config_set({ key: 'deployUrl', value: 'https://x.vercel.app' })));
    const added = await asUser(session, ALICE, h => json(h.member_add({ ref: 'ravi@example.com', name: 'Ravi' })));
    const direct = await asUser(session, ALICE, h => json(h.get_connect_url()));
    expect(added.connectUrl).toBe(direct.url);
  });
});

describe('a member scoped to one workstream', () => {
  // The claim this change rests on and the one that cannot be made from the
  // CLI: Bob signs in with Google, has no repository access of his own, and
  // every read he makes goes through this server. So for him the scope is a
  // boundary rather than a label — which is exactly what has to be proven.
  const RAVI = { key: 'git:ravi@example.com', name: 'Ravi', login: null, email: 'ravi@example.com', source: 'google' };

  const scoped = (workstreams = ['engineering']) => {
    const s = fakeSession();
    s.write('.teamctx/config.json', JSON.stringify({
      ...CONFIG,
      // Two real workstreams: `main` is project level now, so it would always
      // be in scope and could not stand in for one that is not.
      workstreams: [{ id: 'product', name: 'Product' }, { id: 'engineering', name: 'Engineering' }],
      members: [{ key: RAVI.key, name: 'Ravi', email: RAVI.email, login: null, workstreams }],
    }));
    s.write('.teamctx/workstreams/engineering.json', JSON.stringify({ id: 'engineering', name: 'Engineering', whys: [] }));
    s.write('.teamctx/workstreams/product.json', JSON.stringify({ id: 'product', name: 'Product', whys: [] }));
    return s;
  };

  it('sees the project tree and their own workstream, and nothing else', async () => {
    // Both halves matter: without the project tree their brief is incoherent,
    // and with a sibling workstream it is a leak.
    const r = await asUser(scoped(), RAVI, h => json(h.get_context()));
    expect(r.workstreams.map(w => w.id)).toEqual([null, 'engineering']);
    expect(r.scopedTo).toEqual(['engineering']);
  });

  it('sees only their own in the listing', async () => {
    const r = await asUser(scoped(), RAVI, h => json(h.list_workstreams()));
    expect(r.workstreams.map(w => w.id)).toEqual(['engineering']);
  });

  it('cannot read another workstream by naming it', async () => {
    await expect(asUser(scoped(), RAVI, h => h.get_workstream({ id: 'product' })))
      .rejects.toThrow(/no workstream "product"/);
  });

  it('cannot switch to one outside the scope', async () => {
    await expect(asUser(scoped(), RAVI, h => h.workstream_use({ id: 'product' })))
      .rejects.toThrow(/no workstream "product"/);
  });

  it('cannot reach one by asking about it', async () => {
    // The decision worth writing down: omitting the argument must not widen
    // anything, so the server clamps rather than trusting what was passed.
    await expect(asUser(scoped(), RAVI, h => h.ask({ question: 'what?', workstream: 'product' })))
      .rejects.toThrow(/no workstream "product"/);
  });

  it('still reads the one they are on', async () => {
    const r = await asUser(scoped(), RAVI, h => json(h.get_workstream({ id: 'engineering' })));
    expect(r.id).toBe('engineering');
  });

  it('leaves an unscoped member seeing everything', async () => {
    const s = scoped();
    const cfg = s.configJson();
    delete cfg.members[0].workstreams;
    s.write('.teamctx/config.json', JSON.stringify(cfg));
    const r = await asUser(s, RAVI, h => json(h.get_context()));
    expect(r.workstreams.map(w => w.id)).toContain('product');
    expect(r.workstreams.map(w => w.id)).toContain('engineering');
    expect(r.scopedTo).toBeUndefined();
  });

  it('reads the project itself, which is not a workstream to be scoped out of', async () => {
    // Their own workstream inherits the project tree, so a member refused it
    // would be reading half of their own context.
    const r = await asUser(scoped(), RAVI, h => json(h.get_workstream({})));
    expect(r).toBeTruthy();
  });

  it('reads a role that sits at project level', async () => {
    const s = scoped();
    const cfg = s.configJson();
    cfg.roles = [{ slug: 'ops', name: 'Ops', workstream: null }];
    s.write('.teamctx/config.json', JSON.stringify(cfg));
    s.write('.teamctx/context/roles/ops.md', '# Ops');
    const r = await asUser(s, RAVI, h => h.get_role_context({ role: 'ops' }));
    expect(r.content[0].text).toMatch(/# Ops/);
  });

  it('still cannot read a role bound to a workstream outside the scope', async () => {
    const s = scoped();
    const cfg = s.configJson();
    cfg.roles = [{ slug: 'pm', name: 'PM', workstream: 'product' }];
    s.write('.teamctx/config.json', JSON.stringify(cfg));
    s.write('.teamctx/context/roles/pm.md', '# PM');
    await expect(asUser(s, RAVI, h => h.get_role_context({ role: 'pm' })))
      .rejects.toThrow(/no workstream "product"/);
  });

  it('keeps project-level tasks in their list and drops a sibling one', async () => {
    const s = scoped();
    s.write('.teamctx/project.json', JSON.stringify({
      name: 'Demo', whys: [],
      tasks: [{ id: 't-proj', title: 'book the venue', status: 'open' }],
    }));
    s.write('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', whys: [],
      tasks: [{ id: 't-prod', title: 'pricing page', status: 'open' }],
    }));
    const r = await asUser(s, RAVI, h => json(h.list_tasks({ all: true })));
    const ids = r.tasks.map(t => t.id);
    expect(ids).toContain('t-proj');
    expect(ids).not.toContain('t-prod');
  });

  /** Two tasks, one either side of the boundary. */
  const withTasks = () => {
    const s = scoped();
    s.write('.teamctx/workstreams/engineering.json', JSON.stringify({
      id: 'engineering', name: 'Engineering', whys: [{ id: 'e1', text: 'hire two' }],
      tasks: [{ id: 't-eng', title: 'write the ad', status: 'open', workstream: 'engineering' }],
    }));
    s.write('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', whys: [{ id: 'pr1', text: 'pricing' }],
      tasks: [{ id: 't-prod', title: 'pricing page', status: 'open', workstream: 'product' }],
    }));
    return s;
  };

  const refused = (fn) => expect(asUser(withTasks(), RAVI, fn)).rejects.toThrow(/no workstream "product"/);

  it('cannot read a sibling task by naming its id', async () => {
    await refused(h => h.get_task({ id: 't-prod' }));
  });

  it('cannot compile a sibling task, which would hand over its whole tree', async () => {
    // The same bypass `get_role_context` had, and the widest one: a compiled
    // prompt carries the workstream's entire why/what/how.
    await refused(h => h.task_compile({ id: 't-prod' }));
  });

  it('cannot mark a sibling task done, reopen it, reassign it or delete it', async () => {
    await refused(h => h.task_done({ id: 't-prod' }));
    await refused(h => h.task_reopen({ id: 't-prod' }));
    await refused(h => h.task_assign({ id: 't-prod', owner: 'Ravi' }));
    await refused(h => h.task_rm({ id: 't-prod' }));
  });

  it('cannot write a new task into a workstream it cannot read', async () => {
    await refused(h => h.task_add({ title: 'sneak', workstream: 'product' }));
  });

  it('cannot rewrite a sibling workstream through reflect', async () => {
    await refused(h => h.reflect({ workstream: 'product' }));
  });

  it('cannot read a sibling through suggest_roles or get_stats', async () => {
    await refused(h => h.suggest_roles({ workstream: 'product' }));
    await refused(h => h.get_stats({ workstream: 'product' }));
  });

  it('still reaches its own tasks', async () => {
    const r = await asUser(withTasks(), RAVI, h => json(h.get_task({ id: 't-eng' })));
    expect(r.id).toBe('t-eng');
  });

  it('still reaches a task on the project, which it inherits', async () => {
    const s = withTasks();
    s.write('.teamctx/project.json', JSON.stringify({
      name: 'Ledger', whys: [{ id: 'p1', text: 'ship it' }],
      tasks: [{ id: 't-proj', title: 'book the venue', status: 'open' }],
    }));
    const r = await asUser(s, RAVI, h => json(h.get_task({ id: 't-proj' })));
    expect(r.id).toBe('t-proj');
  });

  it('is not told a sibling task exists, only that the workstream does not', async () => {
    // The same wording an unknown workstream gets, so probing learns nothing.
    let message = '';
    try { await asUser(withTasks(), RAVI, h => h.get_task({ id: 't-prod' })); }
    catch (err) { message = err.message; }
    expect(message).not.toMatch(/pricing page|t-prod/);
  });

  it('does not see the roles of a sibling workstream in the listing', async () => {
    const s = withTasks();
    const cfg = s.configJson();
    cfg.roles = [
      { slug: 'pm', name: 'PM', workstream: 'product' },
      { slug: 'recruiter', name: 'Recruiter', workstream: 'engineering' },
      { slug: 'ops', name: 'Ops', workstream: null },
    ];
    s.write('.teamctx/config.json', JSON.stringify(cfg));
    const r = await asUser(s, RAVI, h => json(h.list_roles()));
    expect(r.roles.map(x => x.slug).sort()).toEqual(['ops', 'recruiter']);
  });

  it('gets a snapshot with the siblings filtered out of it', async () => {
    const s = withTasks();
    await asUser(s, ALICE, h => json(h.snapshot_create({ message: 'before the split' })));
    const list = await asUser(s, ALICE, h => json(h.list_snapshots()));
    const id = list.snapshots[0].id;
    const r = await asUser(s, RAVI, h => json(h.get_snapshot({ id })));
    const ids = r.workstreams.map(w => w.id);
    expect(ids).not.toContain('product');
    expect(ids).toContain('engineering');
  });

  it('cannot create or move a role onto a sibling workstream', async () => {
    await refused(h => h.role_add({ name: 'PM', responsibilities: 'pricing', workstream: 'product' }));
    await refused(h => h.role_assign({ slug: 'pm', workstream: 'product' }));
  });

  it('is still told which argument is missing when role_assign gets none', async () => {
    await expect(asUser(withTasks(), RAVI, h => h.role_assign({ slug: 'pm' })))
      .rejects.toThrow(/workstreamId is required|no role "pm"/);
  });

  it('does not see a sibling contribution waiting for review', async () => {
    const s = withTasks();
    s.write('.teamctx/queue/q1.json', JSON.stringify({
      id: 'q1', author: 'Sam', workstream: 'product', summary: 'pricing rethink', operations: [],
    }));
    s.write('.teamctx/queue/q2.json', JSON.stringify({
      id: 'q2', author: 'Sam', workstream: 'engineering', summary: 'ad copy', operations: [],
    }));
    const r = await asUser(s, RAVI, h => json(h.list_pending_reviews()));
    expect(r.pending.map(x => x.id)).toEqual(['q2']);
  });

  it('cannot read a sibling tree through a snapshot listing', async () => {
    // Wider than get_snapshot: this hands back whole snapshots, trees included.
    const s = withTasks();
    await asUser(s, ALICE, h => json(h.snapshot_create({ message: 'before' })));
    const r = await asUser(s, RAVI, h => json(h.list_snapshots()));
    const ids = r.snapshots.flatMap(sn => (sn.workstreams || []).map(w => w.id));
    expect(ids).not.toContain('product');
    expect(ids).toContain('engineering');
  });

  it('cannot read a sibling tree by taking a snapshot of its own', async () => {
    const r = await asUser(withTasks(), RAVI, h => json(h.snapshot_create({ message: 'mine' })));
    const ids = (r.snapshot.workstreams || []).map(w => w.id);
    expect(ids).not.toContain('product');
  });

  it('cannot reach a sibling role by asking a question as it', async () => {
    // `get_role_context` refuses this; `ask` was reading the same file.
    const s = withTasks();
    const cfg = s.configJson();
    cfg.roles = [{ slug: 'pm', name: 'PM', workstream: 'product' }];
    s.write('.teamctx/config.json', JSON.stringify(cfg));
    s.write('.teamctx/context/roles/pm.md', '# PM');
    await expect(asUser(s, RAVI, h => h.ask({ question: 'what?', role: 'pm' })))
      .rejects.toThrow(/no workstream "product"/);
  });

  it('never scopes the manager, even if the roster tries to', async () => {
    // A manager who could not read half the project could not review
    // contributions to that half, which is the one thing only they can do.
    const s = scoped();
    const cfg = s.configJson();
    cfg.members.push({ key: ALICE.key, name: 'Alice Example', login: 'alice', workstreams: ['engineering'] });
    s.write('.teamctx/config.json', JSON.stringify(cfg));
    const r = await asUser(s, ALICE, h => json(h.get_context()));
    expect(r.workstreams.map(w => w.id)).toContain('product');
    expect(r.scopedTo).toBeUndefined();
  });
});

describe('changing a scope from a chat client', () => {
  // A manager scoping somebody is far likelier to be in a chat than a
  // terminal, so leaving this CLI-only would have made the feature reachable
  // mainly from the surface its users are not on.
  const withTwo = () => {
    const s = fakeSession();
    s.write('.teamctx/config.json', JSON.stringify({
      ...CONFIG,
      workstreams: [{ id: 'main', name: 'Main' }, { id: 'engineering', name: 'Engineering' }],
      members: [{ key: 'git:ravi@example.com', name: 'Ravi', email: 'ravi@example.com', login: null }],
    }));
    // Somebody can only be put on a workstream that has something to read.
    s.write('.teamctx/workstreams/engineering.json', JSON.stringify({
      id: 'engineering', name: 'Engineering', whys: [{ id: 'e1', text: 'hire two engineers' }],
    }));
    return s;
  };

  it('scopes a member and commits', async () => {
    const s = withTwo();
    const r = await asUser(s, ALICE, h => json(h.member_scope({ ref: 'ravi@example.com', workstreams: ['engineering'] })));
    expect(r.member.workstreams).toEqual(['engineering']);
    expect(s.configJson().members[0].workstreams).toEqual(['engineering']);
    expect(r.reportBack).toMatch(/now on engineering/);
  });

  it('clears the scope when no workstreams are given', async () => {
    const s = withTwo();
    await asUser(s, ALICE, h => json(h.member_scope({ ref: 'ravi@example.com', workstreams: ['engineering'] })));
    const r = await asUser(s, ALICE, h => json(h.member_scope({ ref: 'ravi@example.com' })));
    expect('workstreams' in r.member).toBe(false);
    expect(r.reportBack).toMatch(/whole project/);
  });

  it('refuses a member who is not the manager', async () => {
    // Scope decides what a member may read, so one who can widen their own is
    // not scoped at all.
    const s = withTwo();
    await expect(asUser(s, BOB, h => h.member_scope({ ref: 'ravi@example.com', workstreams: ['engineering'] })))
      .rejects.toThrow(/only the configured manager/);
    expect(s.configJson().members[0].workstreams).toBeUndefined();
  });

  it('refuses a workstream the project does not have', async () => {
    const s = withTwo();
    await expect(asUser(s, ALICE, h => h.member_scope({ ref: 'ravi@example.com', workstreams: ['nope'] })))
      .rejects.toThrow(/no workstream "nope"/);
  });

  it('says the scope is advisory for a collaborator with a clone', async () => {
    const s = withTwo();
    const cfg = s.configJson();
    cfg.members = [{ key: 'github:7', name: 'Priya', login: 'priyar', email: null }];
    s.write('.teamctx/config.json', JSON.stringify(cfg));
    const r = await asUser(s, ALICE, h => json(h.member_scope({ ref: 'priyar', workstreams: ['engineering'] })));
    expect(r.reportBack).toMatch(/advisory/i);
  });

  it('does not call it advisory for somebody with no clone', async () => {
    const s = withTwo();
    const r = await asUser(s, ALICE, h => json(h.member_scope({ ref: 'ravi@example.com', workstreams: ['engineering'] })));
    expect(r.reportBack).not.toMatch(/advisory/i);
  });
});

describe('the project itself is always reachable', () => {
  // Inherited, read-only background. A scoped member whose brief omits it is
  // reading a branch with no idea what it hangs off — the incoherent brief this
  // whole layer exists to remove.
  const RAVI = { key: 'git:ravi@example.com', name: 'Ravi', login: null, email: 'ravi@example.com', source: 'google' };

  const scoped = () => {
    const s = fakeSession();
    s.write('.teamctx/config.json', JSON.stringify({
      ...CONFIG,
      workstreams: [{ id: 'product', name: 'Product' }, { id: 'engineering', name: 'Engineering' }],
      members: [{ key: RAVI.key, name: 'Ravi', email: RAVI.email, login: null, workstreams: ['engineering'] }],
    }));
    s.write('.teamctx/project.json', JSON.stringify({ name: 'Ledger', whys: [{ id: 'p1', text: 'ship it', whats: [] }] }));
    s.write('.teamctx/workstreams/engineering.json', JSON.stringify({ id: 'engineering', name: 'Engineering', whys: [] }));
    s.write('.teamctx/workstreams/product.json', JSON.stringify({ id: 'product', name: 'Product', whys: [] }));
    return s;
  };

  it('lets a scoped member read the project tree', async () => {
    const r = await asUser(scoped(), RAVI, h => json(h.get_workstream({})));
    expect(r.whys[0].text).toBe('ship it');
  });

  it('lets them read it by the name it used to have', async () => {
    const r = await asUser(scoped(), RAVI, h => json(h.get_workstream({ id: 'main' })));
    expect(r.whys[0].text).toBe('ship it');
  });

  it('lets them move back to it after switching', async () => {
    // Otherwise picking a workstream is a one-way door out of the whole picture.
    const s = scoped();
    await asUser(s, RAVI, h => h.workstream_use({ id: 'engineering' }));
    const back = await asUser(s, RAVI, h => json(h.workstream_use({})));
    expect(back.activeWorkstream).toBe(null);
  });

  it('still refuses a workstream they are not on', async () => {
    await expect(asUser(scoped(), RAVI, h => h.workstream_use({ id: 'product' })))
      .rejects.toThrow(/no workstream "product"/);
  });
});

describe('what a hosted read must not miss', () => {
  // Each of these was live on a real project at once, and together they made it
  // look corrupted: contributions landed correctly and then read as lost, a
  // scoped member saw a workstream they could not open, and every agent was
  // told the project had no manager.
  const RAVI = { key: 'git:ravi@example.com', name: 'Ravi', login: null, email: 'ravi@example.com', source: 'google' };

  const withProject = (members = []) => {
    const s = fakeSession();
    s.write('.teamctx/config.json', JSON.stringify({
      ...CONFIG,
      workstreams: [{ id: 'product', name: 'Product' }, { id: 'engineering', name: 'Engineering' }],
      members,
    }));
    // Replaces the fixture's project tree rather than adding to it, so the
    // counts below are this test's own.
    s.write('.teamctx/project.json', JSON.stringify({
      name: 'Ledger', whys: [{ id: 'p1', text: 'nobody ships before Q3', whats: [] }],
    }));
    s.write('.teamctx/workstreams/engineering.json', JSON.stringify({ id: 'engineering', name: 'Engineering', whys: [] }));
    s.write('.teamctx/workstreams/product.json', JSON.stringify({ id: 'product', name: 'Product', whys: [] }));
    return s;
  };

  it('counts the project tree in totalWhys', async () => {
    // It did not, so a contribution to the project moved nothing on screen and
    // read as an orphaned write.
    const r = await asUser(withProject(), ALICE, h => json(h.get_status()));
    expect(r.projectWhys).toBe(1);
    expect(r.totalWhys).toBe(1);
  });

  it('returns the project tree from get_context', async () => {
    const r = await asUser(withProject(), ALICE, h => json(h.get_context()));
    expect(r.workstreams[0].id).toBe(null);
    expect(r.workstreams[0].tree.whys[0].text).toBe('nobody ships before Q3');
  });

  it('does not list a workstream in status that the caller cannot open', async () => {
    // Listing one and then refusing it is what made a member's agent conclude
    // the data was corrupt rather than that they were scoped.
    const s = withProject([{ key: RAVI.key, name: 'Ravi', email: RAVI.email, login: null, workstreams: ['engineering'] }]);
    const r = await asUser(s, RAVI, h => json(h.get_status()));
    expect(r.workstreams.map(w => w.id)).toEqual(['engineering']);
    expect(r.scopedTo).toEqual(['engineering']);
  });

  it('still shows the manager everything', async () => {
    const s = withProject([{ key: RAVI.key, name: 'Ravi', email: RAVI.email, login: null, workstreams: ['engineering'] }]);
    const r = await asUser(s, ALICE, h => json(h.get_status()));
    const ids = r.workstreams.map(w => w.id);
    expect(ids).toContain('engineering');
    expect(ids).toContain('product');
    expect(r.scopedTo).toBeUndefined();
  });

  it('reports the gate, not the empty legacy field', async () => {
    // Reading `config.manager` alone said "no manager" on every project created
    // since it stopped being written — and an agent told that says the gate is
    // open, which is both alarming and false.
    const r = await asUser(withProject(), ALICE, h => json(h.get_status()));
    expect(r.manager).toBe(CONFIG.managerKey);
  });
});

describe('the project layer migration, run through a hosted session', () => {
  /**
   * Every other migration test runs against a real filesystem. Hosted projects
   * are where most projects now are, and they reach storage through the session
   * buffer instead — a path that was skipped entirely until this branch, so a
   * hosted project would have sat unmigrated forever.
   */
  const legacy = () => {
    const files = new Map([
      ['.teamctx/config.json', { content: JSON.stringify({
        ...CONFIG,
        workstreams: [{ id: 'main', name: 'Ledger' }, { id: 'engineering', name: 'Engineering' }],
        activeWorkstream: 'main',
        roles: [{ slug: 'cpo', name: 'CPO', workstream: 'main' }],
        workstreamsMigrated: true,
        // The point of this fixture: a project from before the project layer.
        projectLayerMigrated: undefined,
      }), sha: 'a' }],
      ['.teamctx/contributions.jsonl', { content: '', sha: 'b' }],
      ['.teamctx/workstreams/main.json', { content: JSON.stringify({
        id: 'main', name: 'Ledger',
        whys: [{ id: 'w1', text: 'ship the ledger', whats: [] }],
        tasks: [{ id: 't-old', title: 'book the venue', status: 'open', workstream: 'main' }],
      }), sha: 'c' }],
      ['.teamctx/workstreams/engineering.json', { content: JSON.stringify({
        id: 'engineering', name: 'Engineering', whys: [{ id: 'e1', text: 'hire two' }],
      }), sha: 'd' }],
      ['.teamctx/context/workstreams/main.md', { content: '# Project Context — Ledger\n', sha: 'e' }],
    ]);
    const s = fakeSession();
    s.read = p => files.get(p) || null;
    s.write = (p, c) => files.set(p, { content: String(c), sha: null });
    s.del = p => files.delete(p);
    s.listDir = dirPath => {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      return [...files.keys()]
        .filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(k => k.slice(prefix.length)).sort();
    };
    s.configJson = () => JSON.parse(files.get('.teamctx/config.json').content);
    s.projectJson = () => JSON.parse(files.get('.teamctx/project.json').content);
    s.has = p => files.has(p);
    return s;
  };

  it('runs on the first tool call rather than leaving the project half-migrated', async () => {
    const s = legacy();
    await asUser(s, ALICE, h => json(h.get_status()));
    expect(s.has('.teamctx/project.json')).toBe(true);
    expect(s.configJson().projectLayerMigrated).toBe(true);
  });

  it('moves the context off main onto the project, and deletes main', async () => {
    const s = legacy();
    await asUser(s, ALICE, h => json(h.get_status()));
    expect(s.projectJson().whys.map(w => w.id)).toEqual(['w1']);
    expect(s.has('.teamctx/workstreams/main.json')).toBe(false);
    expect(s.configJson().workstreams.map(w => w.id)).toEqual(['engineering']);
  });

  it('carries the tasks main was holding', async () => {
    const s = legacy();
    await asUser(s, ALICE, h => json(h.get_status()));
    expect(s.projectJson().tasks.map(t => t.id)).toEqual(['t-old']);
  });

  it('rebinds a main-bound role and unsets the active workstream', async () => {
    const s = legacy();
    await asUser(s, ALICE, h => json(h.get_status()));
    expect(s.configJson().roles[0].workstream).toBe(null);
    expect(s.configJson().activeWorkstream).toBe(null);
  });

  it('leaves the caller reading the same context afterwards', async () => {
    const s = legacy();
    const r = await asUser(s, ALICE, h => json(h.get_context()));
    expect(r.workstreams[0].id).toBe(null);
    expect(r.workstreams[0].tree.whys[0].text).toBe('ship the ledger');
    expect(r.workstreams.map(w => w.id)).not.toContain('main');
  });

  it('leaves the task reachable, not stranded in a file that is gone', async () => {
    const s = legacy();
    const r = await asUser(s, ALICE, h => json(h.get_task({ id: 't-old' })));
    expect(r.title).toBe('book the venue');
  });

  it('does nothing the second time', async () => {
    const s = legacy();
    await asUser(s, ALICE, h => json(h.get_status()));
    const after = JSON.stringify(s.projectJson());
    await asUser(s, BOB, h => json(h.get_status()));
    expect(JSON.stringify(s.projectJson())).toBe(after);
  });
});

describe('a broken gate is visible before anything fails', () => {
  // #73 asks for this by name: without it the only way to learn the gate is
  // unmatchable is to be refused an approval, which is late and reads as a bug.
  const brokenConfig = () => {
    const s = fakeSession();
    s.write('.teamctx/config.json', JSON.stringify({ ...CONFIG, managerKey: 'name:Alice Example', managerKeys: [] }));
    return s;
  };

  it('get_status says so', async () => {
    const r = await asUser(brokenConfig(), ALICE, h => json(h.get_status()));
    expect(r.managerGateBroken).toBe(true);
  });

  it('get_config says so', async () => {
    const r = await asUser(brokenConfig(), ALICE, h => json(h.get_config()));
    expect(r.managerGateBroken).toBe(true);
  });

  it('stays false for a gate that works', async () => {
    const s = fakeSession();
    const r = await asUser(s, ALICE, h => json(h.get_status()));
    expect(r.managerGateBroken).toBe(false);
  });
});

describe('nobody is brought onto an empty project, over the server', () => {
  // The hosted path is where this has to hold: the manager is in a chat
  // client, the person they are adding will open their brief in another one,
  // and neither of them will ever see a terminal.
  const emptyProject = () => {
    const s = fakeSession();
    s.write('.teamctx/project.json', JSON.stringify({ name: 'Ledger', whys: [] }));
    return s;
  };

  it('refuses member_add while there is nothing to read', async () => {
    await expect(asUser(emptyProject(), ALICE, h => h.member_add({ ref: 'priyar' })))
      .rejects.toThrow(/This project has nothing written down yet/);
  });

  it('writes no roster entry when it refuses', async () => {
    const s = emptyProject();
    await expect(asUser(s, ALICE, h => h.member_add({ ref: 'priyar' }))).rejects.toThrow();
    expect(s.configJson().members || []).toEqual([]);
    expect(s.commits).toEqual([]);
  });

  it('tells the manager what to do, in words with no teamctx in them', async () => {
    let message = '';
    try {
      await asUser(emptyProject(), ALICE, h => h.member_add({ ref: 'priyar' }));
    } catch (err) { message = err.message; }
    expect(message).toMatch(/Tell me what it's about and I'll add it/);
    expect(message).not.toMatch(/workstream|why|context tree|contribution/i);
  });

  it('allows it once the project has something in it', async () => {
    const r = await asUser(fakeSession(), ALICE, h => json(h.member_add({ ref: 'priyar' })));
    expect(r.member.name).toBe('priyar');
  });

  it('refuses when the workstream they would join is the empty half', async () => {
    // The project is fine here; `engineering-hiring` is the one with nothing.
    await expect(asUser(fakeSession(), ALICE,
      h => h.member_add({ ref: 'priyar', workstreams: ['engineering-hiring'] })))
      .rejects.toThrow(/"Engineering Hiring" has nothing written down yet/);
  });

  it('lets member_add scope somebody at the moment they join', async () => {
    // The handler always passed `workstreams` through; the tool schema never
    // declared it, so no client could send one.
    const s = fakeSession();
    s.write('.teamctx/workstreams/engineering-hiring.json', JSON.stringify({
      id: 'engineering-hiring', name: 'Engineering Hiring', whys: [{ id: 'e1', text: 'hire two engineers' }],
    }));
    const r = await asUser(s, ALICE, h => json(h.member_add({ ref: 'priyar', workstreams: ['engineering-hiring'] })));
    expect(r.member.workstreams).toEqual(['engineering-hiring']);
  });

  it('declares workstreams on the tool, so a client knows it can send them', () => {
    const tool = TOOLS.find(t => t.name === 'member_add');
    expect(tool.inputSchema.properties.workstreams).toBeTruthy();
  });
});

describe('the brief a member opens first', () => {
  // The pair to the context gate: that one guarantees there is something to
  // read, this is the reading. It has to hold over the server, because the
  // member is in a chat client and will never see a terminal.
  const RAVI = { key: 'git:ravi@example.com', name: 'Ravi', login: null, email: 'ravi@example.com', source: 'google' };

  const project = () => {
    const s = fakeSession();
    s.write('.teamctx/config.json', JSON.stringify({
      ...CONFIG,
      workstreams: [{ id: 'product', name: 'Product' }, { id: 'engineering', name: 'Engineering' }],
      roles: [{ slug: 'recruiter', name: 'Recruiter', workstream: 'engineering' }],
      members: [{ key: RAVI.key, name: 'Ravi', email: RAVI.email, login: null, workstreams: ['engineering'] }],
    }));
    s.write('.teamctx/project.json', JSON.stringify({
      name: 'Ledger', whys: [{ id: 'p1', text: 'no new vendors' }],
      tasks: [{ id: 't-proj', title: 'book the venue', status: 'open', owner: 'Ravi' }],
    }));
    s.write('.teamctx/workstreams/engineering.json', JSON.stringify({
      id: 'engineering', name: 'Engineering', whys: [{ id: 'e1', text: 'hire two' }],
      tasks: [{ id: 't-eng', title: 'write the ad', status: 'open', owner: 'Ravi' }],
    }));
    s.write('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', whys: [{ id: 'pr1', text: 'pricing' }],
      tasks: [{ id: 't-prod', title: 'pricing page', status: 'open', owner: 'Ravi' }],
    }));
    s.write('.teamctx/context/workstreams/engineering.md',
      ['# Context — Ledger', '### Project context', 'no new vendors', '### Engineering', 'hire two'].join(String.fromCharCode(10)));
    s.write('.teamctx/context/workstreams/product.md',
      ['# Context — Ledger', '### Product', 'pricing'].join(String.fromCharCode(10)));
    s.write('.teamctx/context/roles/recruiter.md', '# Recruiter');
    return s;
  };

  it('answers without being told who is asking', async () => {
    const r = await asUser(project(), RAVI, h => json(h.my_brief()));
    expect(r.me).toBe('Ravi');
  });

  it('carries the compiled page for the part of the work they are on', async () => {
    const r = await asUser(project(), RAVI, h => json(h.my_brief()));
    expect(r.context.map(c => c.workstream)).toEqual(['engineering']);
    expect(r.context[0].markdown).toContain('no new vendors');
    expect(r.context[0].markdown).toContain('hire two');
  });

  it('does not hand a scoped member a sibling thread', async () => {
    const r = await asUser(project(), RAVI, h => json(h.my_brief()));
    const everything = JSON.stringify(r);
    expect(everything).not.toContain('pricing');
    expect(everything).not.toContain('t-prod');
  });

  it('gives them their own tasks, grouped by where the work sits', async () => {
    const r = await asUser(project(), RAVI, h => json(h.my_brief()));
    expect(r.tasks.open.flatMap(g => g.tasks.map(t => t.id))).toEqual(['t-eng']);
  });

  it('names their role when one sits on their thread', async () => {
    const r = await asUser(project(), RAVI, h => json(h.my_brief()));
    expect(r.role.name).toBe('Recruiter');
  });

  it('tells the client what to say, in words with no teamctx in them', async () => {
    const r = await asUser(project(), RAVI, h => json(h.my_brief()));
    expect(r.reportBack).toMatch(/You are on/);
    expect(r.reportBack).not.toMatch(/why-tree|contribution queue|compile/i);
  });

  it('gives the manager the whole project', async () => {
    const r = await asUser(project(), ALICE, h => json(h.my_brief()));
    expect(r.context.map(c => c.workstream)).toEqual([null]);
  });

  it('is offered to the client as the first thing a member does', async () => {
    expect(TOOLS.find(t => t.name === 'my_brief')).toBeTruthy();
  });
});
