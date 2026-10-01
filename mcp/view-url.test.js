/**
 * The link a tool hands back.
 *
 * Somebody puts something into the project through their assistant and then has
 * no way to look at it. These tools now say where it is — and, when the project
 * has no web address recorded, say plainly that there is nowhere rather than
 * pointing at one that does not exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/context.js', async (orig) => ({
  ...(await orig()),
  updateShared: vi.fn(async (workstream, contribution) => ({
    workstream: { ...workstream, whys: [...(workstream.whys || []), { id: 'n1', text: 'tiers decided', whats: [] }] },
    summary: 'records the pricing decision',
    operations: [{ type: 'addWhy', id: 'n1', text: 'tiers decided' }],
  })),
  generateRoleFile: vi.fn(async () => '# role'),
}));

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

function session(config = CONFIG()) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(config), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Ledger', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/workstreams/product.json', { content: JSON.stringify({ id: 'product', name: 'Product', whys: [], tasks: [] }), sha: null }],
    ['.teamctx/contributions.jsonl', { content: '', sha: null }],
  ]);
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
async function call(tool, args, { actor = MAYA, config = CONFIG() } = {}) {
  const s = session(config);
  const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: 'https://requested.example' };
  return runWithSession(s, () => runWithActor(actor, async () => {
    const handlers = makeHandlers(root);
    const r = await handlers[tool](args);
    return JSON.parse(r.content[0].text);
  }));
}

beforeEach(() => __resetMemory());

describe('a link to what was just touched', () => {
  it('points at the item a contribution changed', async () => {
    const r = await call('contribute', { text: 'we settled on three tiers', workstream: 'product', apply: true });
    expect(r.viewUrl).toBe('https://team.example.app/project/acme/ledger?ws=product&item=n1');
    expect(r.viewUrlError).toBe(null);
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

  it('points get_status and get_workstream at what they describe', async () => {
    expect((await call('get_status', {})).viewUrl).toBe('https://team.example.app/project/acme/ledger');
    expect((await call('get_workstream', { id: 'product' })).viewUrl).toContain('ws=product');
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
    expect(r.reportBack).toMatch(/Include this link in your reply/);
  });

  it('is there for a task too', async () => {
    const r = await call('task_add', { title: 'Draft the pricing page', workstream: 'product' });
    expect(r.reportBack).toContain(r.viewUrl);
  });

  it('says nothing about a link when there is none', async () => {
    const s = session(CONFIG({ deployUrl: '' }));
    const r = await runWithSession(s, () => runWithActor(MAYA, async () => {
      const handlers = makeHandlers({ __backend: 'github', owner: OWNER, repo: REPO });
      return JSON.parse((await handlers.task_add({ title: 'x', workstream: 'product' })).content[0].text);
    }));
    expect(r.viewUrl).toBe(null);
    expect(r.reportBack).not.toMatch(/link/i);
  });
});
