/**
 * The link a hosted request returns, and the floor under it.
 *
 * Most of this is end-to-end cover for what was already true and easy to doubt:
 * a project that never recorded a deploy URL — which is every project made
 * through the web flow — still gets a correct link from all seven tools, built
 * from the address the request arrived at. Worth pinning down, because the
 * alternative is reading three functions to convince yourself.
 *
 * The last test is the only one that exercises the stamp in `callTool`, and it is
 * what the stamp is for: no handler can return one of these seven results
 * without a link, however it was written. That is not hypothetical — task_add
 * with compile:true shipped without one, on the path its own description calls
 * the usual one, and nothing failed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const plan = vi.hoisted(() => ({ ops: null }));

vi.mock('../src/context.js', async (orig) => {
  const { applyOps } = await import('../src/ops.js');
  return {
    ...(await orig()),
    updateShared: vi.fn(async (workstream, contribution) => {
      const operations = plan.ops || [{ type: 'addWhy', text: 'tiers decided', summary: 'three tiers' }];
      return {
        workstream: applyOps(workstream, operations, contribution.id),
        summary: 'records the pricing decision',
        operations,
      };
    }),
    generateRoleFile: vi.fn(async () => '# role'),
    compileTaskPrompt: vi.fn(async () => '# the task'),
  };
});

const { makeHandlers, callTool } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const OWNER = 'satyagyasingh';
const REPO = 'webhacks02';
const HOST = 'https://teamctx-seven.vercel.app';
const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };

/** A project that never recorded where it is deployed, which is the common case. */
const CONFIG = (over = {}) => ({
  project: 'Webhacks',
  managerKey: 'git:maya@example.com',
  autoPush: false,
  reviewPolicy: 'all',
  workstreams: [{ id: 'finance', name: 'Finance' }],
  roles: [],
  members: [],
  ...over,
});

let written = null;

function session(config) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(config), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Webhacks', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/workstreams/finance.json', { content: JSON.stringify({ id: 'finance', name: 'Finance', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/contributions.jsonl', { content: '', sha: null }],
  ]);
  written = files;
  return {
    owner: OWNER,
    repo: REPO,
    files,
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

/**
 * One tool call, exactly as the hosted endpoint makes it: through `callTool`,
 * with the request's own address in the project context.
 */
async function hosted(tool, args, { config = CONFIG(), baseUrl = HOST } = {}) {
  const s = session(config);
  const root = { __backend: 'github', owner: OWNER, repo: REPO, ...(baseUrl ? { baseUrl } : {}) };
  return runWithSession(s, () => runWithActor(MAYA, async () => {
    const r = await callTool(makeHandlers(root), root, tool, args);
    return JSON.parse(r.content[0].text);
  }));
}

/** Several calls against one project, for the tools that act on what came before. */
async function inOneSession(fn, { config = CONFIG(), baseUrl = HOST } = {}) {
  const s = session(config);
  const root = { __backend: 'github', owner: OWNER, repo: REPO, ...(baseUrl ? { baseUrl } : {}) };
  const handlers = makeHandlers(root);
  const call = async (tool, args) => JSON.parse((await callTool(handlers, root, tool, args)).content[0].text);
  return runWithSession(s, () => runWithActor(MAYA, () => fn(call)));
}

const tree = () => JSON.parse(written.get('.teamctx/workstreams/finance.json').content);

beforeEach(() => {
  __resetMemory();
  plan.ops = null;
  written = null;
});

describe('a project that never recorded where it is deployed', () => {
  it('still returns a link for a contribution, pointing at what it wrote', async () => {
    const r = await hosted('contribute', { text: 'a sponsor at 25,000', workstream: 'finance', apply: true });
    const added = tree().whys.find(w => w.text === 'tiers decided');
    expect(r.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}?ws=finance&item=${added.id}`);
    expect(r.viewUrlError).toBe(null);
  });

  it('still returns a link for a task', async () => {
    const r = await hosted('task_add', { title: 'Contact the sponsor', workstream: 'finance' });
    expect(r.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}?task=${r.task.id}`);
  });

  it('still returns one when the task is compiled in the same call', async () => {
    const r = await hosted('task_add', { title: 'Contact the sponsor', workstream: 'finance', compile: true });
    expect(r.viewUrl).toContain(`task=${r.task.id}`);
  });

  it('returns one for marking a task done and for reassigning it', async () => {
    await inOneSession(async (call) => {
      const added = await call('task_add', { title: 'Contact the sponsor', workstream: 'finance' });
      const moved = await call('task_assign', { id: added.task.id, owner: 'Smita' });
      expect(moved.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}?task=${added.task.id}`);
      const done = await call('task_done', { id: added.task.id });
      expect(done.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}?task=${added.task.id}`);
    });
  });

  it('returns one for the three read tools that report where something lives', async () => {
    expect((await hosted('get_status', {})).viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}`);
    expect((await hosted('get_workstream', { id: 'finance' })).viewUrl).toContain('ws=finance');
    expect((await hosted('my_brief', {})).viewUrl).toContain(HOST);
  });

  it('says it out loud, and says it must be passed on', async () => {
    const r = await hosted('contribute', { text: 'a sponsor at 25,000', workstream: 'finance', apply: true });
    expect(r.reportBack).toContain(r.viewUrl);
    expect(r.reportBack).toMatch(/must end your reply with this link/);
    // And no leftover sentence from the moment it thought there was no address.
    expect(r.reportBack).not.toMatch(/no web address is recorded/i);
  });

  it('carries the pieces the link was built from', async () => {
    const r = await hosted('task_add', { title: 'Contact the sponsor', workstream: 'finance' });
    expect(r.view).toEqual({
      owner: OWNER, repo: REPO, ws: null, item: null, task: r.task.id, review: null,
    });
  });
});

describe('what it does not touch', () => {
  it('leaves a link the handler built alone', async () => {
    // A floor, not a second opinion. Here the handler built the link from the
    // request's own address, as it should, and an address recorded in the
    // repository does not get a say in a link to this server.
    const r = await hosted('get_status', {}, { config: CONFIG({ deployUrl: 'https://an-old-preview.vercel.app' }) });
    expect(r.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}`);
  });

  it('adds nothing to a tool that owes nobody a link', async () => {
    const r = await hosted('list_workstreams', {});
    expect(r.viewUrl).toBeUndefined();
  });

  it('adds nothing when there is no request address, which is not a hosted request', async () => {
    // stdio against a clone: the deploy URL in config is the only honest answer,
    // and the handler has already given it or said there is none.
    const r = await hosted('get_status', {}, { baseUrl: null });
    expect(r.viewUrl).toBe(null);
    expect(r.viewUrlError).toMatch(/deploy ?url/i);
  });

  it('leaves an errored call as an error', async () => {
    const s = session(CONFIG());
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    const r = await runWithSession(s, () => runWithActor(MAYA, () =>
      callTool(makeHandlers(root), root, 'task_done', { id: 'no-such-task' })));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain(HOST);
  });
});

describe('the floor under all of it', () => {
  it('fills in a link a handler did not return', async () => {
    // The stamp sits in callTool, after the handler, so this cannot be reached
    // past. A handler written tomorrow that forgets the link still returns one.
    const handlers = {
      async contribute() {
        return { content: [{ type: 'text', text: JSON.stringify({ id: 'c1', reportBack: 'Added.' }) }] };
      },
    };
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    const r = JSON.parse((await callTool(handlers, root, 'contribute', {})).content[0].text);
    expect(r.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}`);
    expect(r.viewUrlError).toBe(null);
    expect(r.reportBack).toBe(`Added. You must end your reply with this link, on its own line, as a plain URL: ${r.viewUrl}`);
  });

  it('uses the ids the handler did name, even without a link', async () => {
    const handlers = {
      async task_add() {
        return { content: [{ type: 'text', text: JSON.stringify({ view: { task: 't-9' } }) }] };
      },
    };
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    const r = JSON.parse((await callTool(handlers, root, 'task_add', {})).content[0].text);
    expect(r.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}?task=t-9`);
  });

  it('refuses an id the page would refuse, and points at the project instead', async () => {
    const handlers = {
      async task_add() {
        return { content: [{ type: 'text', text: JSON.stringify({ view: { task: '../../etc/passwd' } }) }] };
      },
    };
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    const r = JSON.parse((await callTool(handlers, root, 'task_add', {})).content[0].text);
    expect(r.viewUrl).toBe(`${HOST}/project/${OWNER}/${REPO}`);
    expect(r.viewUrl).not.toContain('passwd');
  });

  it('leaves a result that is not JSON alone', async () => {
    const handlers = {
      async get_status() { return { content: [{ type: 'text', text: 'plain words' }] }; },
    };
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    const r = await callTool(handlers, root, 'get_status', {});
    expect(r.content[0].text).toBe('plain words');
  });
});
