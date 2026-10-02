/**
 * The link a tool hands back.
 *
 * Somebody puts something into the project through their assistant and then has
 * no way to look at it. These tools now say where it is — and, when the project
 * has no web address recorded, say plainly that there is nowhere rather than
 * pointing at one that does not exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What the model would have proposed, applied for real.
 *
 * The first version of this mock returned `operations: [{ type: 'addWhy', id:
 * 'n1' }]` and a tree with a node called `n1` in it. No part of the real
 * pipeline produces that: an add op carries no id (src/ai.js asks for none, and
 * applyOps mints them), and a created node carries the contribution's id in
 * `sourceContributionIds`. So the mock quietly asserted a link that could not
 * exist, and the one the tools actually built — with no item at all — passed.
 *
 * It now runs the real `applyOps`, so the ops here are the ops the model emits
 * and the ids are the ids the tree really gets.
 */
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
    // Compiling a task is an AI call; what is under test is the link beside it.
    compileTaskPrompt: vi.fn(async () => '# the task'),
  };
});

const { makeHandlers } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const OWNER = 'acme';
const REPO = 'ledger';
const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const PRIYA = { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', source: 'google' };

const CONFIG = (over = {}) => ({
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  deployUrl: 'https://team.example.app',
  autoPush: false,
  reviewPolicy: 'all',
  workstreams: [{ id: 'product', name: 'Product' }],
  roles: [],
  members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] }],
  ...over,
});

// The last session a call ran against, so a test can read what was written and
// assert the link points at a statement that is really there.
let written = null;

function session(config = CONFIG(), whys = []) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(config), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Ledger', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/workstreams/product.json', { content: JSON.stringify({ id: 'product', name: 'Product', whys, tasks: [] }), sha: null }],
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

/** One tool call, as the hosted server makes it. */
async function call(tool, args, { actor = MAYA, config = CONFIG(), whys = [] } = {}) {
  const s = session(config, whys);
  const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: 'https://requested.example' };
  return runWithSession(s, () => runWithActor(actor, async () => {
    const handlers = makeHandlers(root);
    const r = await handlers[tool](args);
    return JSON.parse(r.content[0].text);
  }));
}

/** The tree as it was actually written. */
const tree = () => JSON.parse(written.get('.teamctx/workstreams/product.json').content);

beforeEach(() => {
  __resetMemory();
  plan.ops = null;
  written = null;
});

describe('a link to what was just touched', () => {
  it('points at the item a contribution changed', async () => {
    const r = await call('contribute', { text: 'we settled on three tiers', workstream: 'product', apply: true });
    // The id of the statement that is in the tree, not one the ops happened to
    // mention: an add op has none, so this is the whole feature or nothing.
    const added = tree().whys.find(w => w.text === 'tiers decided');
    expect(added).toBeTruthy();
    // The address is the server's own — see the precedence test below.
    expect(r.viewUrl).toBe(`https://requested.example/project/acme/ledger?ws=product&item=${added.id}`);
    expect(r.viewUrlError).toBe(null);
  });

  it('points at what was added, not at what was removed alongside it', async () => {
    // The id a mixed contribution carries belongs to the statement it deleted,
    // so taking the first id in the operations pointed at a page with nothing
    // on it — the one thing a link must never do.
    plan.ops = [
      { type: 'addWhy', text: 'tiers decided', summary: 'three tiers' },
      { type: 'deleteStatement', id: 'old', summary: 'superseded' },
    ];
    const r = await call('contribute', { text: 'three tiers, and drop the old line', workstream: 'product', apply: true },
      { whys: [{ id: 'old', text: 'pricing undecided', summary: '', whats: [] }] });
    const added = tree().whys.find(w => w.text === 'tiers decided');
    expect(r.viewUrl).toContain(`item=${added.id}`);
    expect(r.viewUrl).not.toContain('item=old');
  });

  it('points at the top of a subtree it added, not at the bottom', async () => {
    plan.ops = [{
      type: 'addWhy', text: 'tiers decided', summary: 'three tiers',
      whats: [{ text: 'name the tiers', summary: '', hows: [{ text: 'write the pricing page', summary: '' }] }],
    }];
    const r = await call('contribute', { text: 'three tiers', workstream: 'product', apply: true });
    const added = tree().whys.find(w => w.text === 'tiers decided');
    expect(r.viewUrl).toContain(`item=${added.id}`);
  });

  it('names an edited statement by the id it already had', async () => {
    plan.ops = [{ type: 'editStatement', id: 'old', text: 'pricing settled', summary: '' }];
    const r = await call('contribute', { text: 'pricing is settled now', workstream: 'product', apply: true },
      { whys: [{ id: 'old', text: 'pricing undecided', summary: '', whats: [] }] });
    expect(r.viewUrl).toContain('item=old');
  });

  it('points a manager at the queue when the work is waiting on them', async () => {
    const r = await call('contribute', { text: 'three tiers', workstream: 'product' });
    expect(r.mode).toBe('queued');
    expect(r.viewUrl).toContain(`review=${r.id}`);
  });

  it('points everybody else at their own part of the work, not the queue', async () => {
    // The queue is the manager's to clear and not theirs to read, so a link
    // into it would be a link to a refusal.
    const r = await call('contribute', { text: 'three tiers', workstream: 'product' }, { actor: PRIYA });
    expect(r.viewUrl).toContain('ws=product');
    expect(r.viewUrl).not.toContain('review=');
  });

  it('names the task a task tool touched', async () => {
    const added = await call('task_add', { title: 'Draft the pricing page', workstream: 'product' });
    expect(added.viewUrl).toContain(`task=${added.task.id}`);
  });

  it('names it on the compiling path too, which is the usual one', async () => {
    // task_add is one of the tools the spec lists as returning viewUrl, and
    // compile: true is what its description calls "usually what you want". That
    // branch returned no field at all — not the null-with-a-reason the others
    // give — so an assistant told to expect one had nothing to pass on.
    const r = await call('task_add', { title: 'Draft the pricing page', workstream: 'product', compile: true });
    expect(r.task.id).toBeTruthy();
    expect(r.viewUrl).toContain(`task=${r.task.id}`);
    expect(r.viewUrlError).toBe(null);
    expect(r.reportBack).toContain(r.viewUrl);
  });

  it('points get_status and get_workstream at what they describe', async () => {
    expect((await call('get_status', {})).viewUrl).toBe('https://requested.example/project/acme/ledger');
    expect((await call('get_workstream', { id: 'product' })).viewUrl).toContain('ws=product');
  });

  it('builds the address from the server, and only the ids from the project', async () => {
    // A view link is this server talking about itself. `deployUrl` is a value in
    // a repository, which can be stale, half-typed or left over from another
    // deployment — and a link built from that points somewhere that is not this
    // project, which is worse than no link.
    const r = await call('get_workstream', { id: 'product' },
      { config: CONFIG({ deployUrl: 'https://an-old-preview.vercel.app' }) });
    expect(r.viewUrl).toBe('https://requested.example/project/acme/ledger?ws=product');
    expect(r.viewUrl).not.toContain('an-old-preview');
  });

  it('still hands out the connector URL a project chose to record', async () => {
    // The other direction, deliberately: that one is given to somebody else, and
    // a project may want it to name a particular address.
    const r = await call('get_connect_url', {},
      { config: CONFIG({ deployUrl: 'https://ctx.acme.com' }) });
    expect(r.url).toBe('https://ctx.acme.com/api/mcp/acme/ledger');
  });

  it('names no workstream for the project itself, which has no id', async () => {
    expect((await call('get_workstream', { id: null })).viewUrl).not.toContain('ws=');
  });
});

describe('a project with nowhere to point at', () => {
  it('says so rather than inventing an address', async () => {
    const r = await call('get_status', {}, { config: CONFIG({ deployUrl: '' }) });
    // The request's own host stands in when there is one — this is the hosted
    // server, so it knows where it is.
    expect(r.viewUrl).toBe('https://requested.example/project/acme/ledger');
  });

  it('hands back null and a reason when there is no address at all', async () => {
    const s = session(CONFIG({ deployUrl: '' }));
    const r = await runWithSession(s, () => runWithActor(MAYA, async () => {
      const handlers = makeHandlers({ __backend: 'github', owner: OWNER, repo: REPO });
      return JSON.parse((await handlers.get_status({})).content[0].text);
    }));
    expect(r.viewUrl).toBe(null);
    // The same words `connectUrl` uses, because it is the same resolution.
    expect(r.viewUrlError).toMatch(/deploy ?url/i);
  });
});

describe('what the assistant is told to do with it', () => {
  it('is told to pass the link on, and not to invent one', async () => {
    const { TOOLS } = await import('./server.js');
    for (const name of ['contribute', 'task_add', 'task_done', 'task_assign', 'my_brief', 'get_status', 'get_workstream']) {
      const tool = TOOLS.find(t => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool.description, name).toMatch(/viewUrl/);
      expect(tool.description, name).toMatch(/inventing one/);
    }
  });
});

describe('the link in what the assistant is told to say', () => {
  it('is in the sentence, not only in a field beside it', async () => {
    // A field is something a client may read; `reportBack` is what it is told
    // to say. Tested by hand first: the payload carried the link and the
    // assistant mentioned nothing at all.
    const r = await call('contribute', { text: 'three tiers', workstream: 'product', apply: true });
    expect(r.reportBack).toContain(r.viewUrl);
    // Told, not suggested. An assistant that treats the link as optional leaves
    // somebody with a description of a page they cannot get to.
    expect(r.reportBack).toMatch(/must end your reply with this link/);
  });

  it('is there for a task too', async () => {
    const r = await call('task_add', { title: 'Draft the pricing page', workstream: 'product' });
    expect(r.reportBack).toContain(r.viewUrl);
  });

  it('says there is no address rather than leaving it to be guessed', async () => {
    // Silence is what let an assistant rebuild a URL "from the known pattern"
    // and hand somebody a guess. It says there is none, and hands back the ids
    // so a client that can find the address honestly still can.
    const s = session(CONFIG({ deployUrl: '' }));
    const r = await runWithSession(s, () => runWithActor(MAYA, async () => {
      const handlers = makeHandlers({ __backend: 'github', owner: OWNER, repo: REPO });
      return JSON.parse((await handlers.task_add({ title: 'x', workstream: 'product' })).content[0].text);
    }));
    expect(r.viewUrl).toBe(null);
    expect(r.reportBack).toMatch(/no web address is recorded/i);
    expect(r.reportBack).toMatch(/rather than inventing one/i);
    expect(r.reportBack).not.toMatch(/https?:/);
    expect(r.view).toMatchObject({ owner: 'acme', repo: 'ledger', task: r.task.id });
  });

  it('hands back the pieces of the link as well as the link', async () => {
    // So a client that ignores `reportBack` — or has the project address from
    // get_connect_url and nothing else — can still name what was touched.
    const r = await call('contribute', { text: 'three tiers', workstream: 'product', apply: true });
    const added = tree().whys.find(w => w.text === 'tiers decided');
    expect(r.view).toEqual({ owner: 'acme', repo: 'ledger', ws: 'product', item: added.id, task: null, review: null });
  });
});
