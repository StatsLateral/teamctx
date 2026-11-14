import { describe, it, expect, beforeEach, vi } from 'vitest';

const plan = vi.hoisted(() => ({ ops: null }));

vi.mock('../src/context.js', async (orig) => {
  const { applyOps } = await import('../src/ops.js');
  return {
    ...(await orig()),
    updateShared: vi.fn(async (workstream, contribution) => {
      const operations = plan.ops || [{ type: 'addRecord', record: { type: 'decision', text: 'tiers decided', detail: 'three tiers' } }];
      return {
        workstream: applyOps(workstream, operations, contribution.id).tree,
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
  workstreams: [{ id: 'finance', number: 1, name: 'Finance' }],
  roles: [],
  members: [],
  ...over,
});

let written = null;

function session(config) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(config), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Webhacks', goal: { text: 'An existing goal' }, records: [], tasks: [] }), sha: null }],
    ['.teamctx/workstreams/finance.json', { content: JSON.stringify({ id: 'finance', name: 'Finance', records: [], tasks: [] }), sha: null }],
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
    const payload = JSON.parse(r.content[0].text);
    // The blocks after the JSON, which is where the link also goes.
    payload.__blocks = r.content.slice(1).map(c => c.text);
    return payload;
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


beforeEach(() => {
  __resetMemory();
  plan.ops = null;
  written = null;
});

const ASANA = 'https://app.asana.com/0/1200/3400';

describe('a task that also lives in another tool', () => {
  it('records where the ticket is, works out the tool from the address, and keeps one entry per address', async () => {
    await inOneSession(async (call) => {
      const added = await call('task_add', { title: 'Set up the booking page', workstream: 'finance' });
      const id = added.task.id;

      const linked = await call('task_link', { id, url: ASANA, ref: '3400' });
      expect(linked.task.external).toEqual([{ system: 'asana', url: ASANA, ref: '3400' }]);
      expect(linked.reportBack).toMatch(/nothing in the ticket was changed/i);

      // The same address again replaces itself.
      const again = await call('task_link', { id, url: ASANA, ref: '3401' });
      expect(again.task.external).toEqual([{ system: 'asana', url: ASANA, ref: '3401' }]);

      // It travels with the task wherever the task is read.
      const listed = await call('list_tasks', { all: true });
      expect(listed.tasks.find(t => t.id === id).external).toHaveLength(1);

      const removed = await call('task_link', { id, url: ASANA, remove: true });
      expect(removed.task.external).toBeUndefined();
    });
  });

  it('ends on the project link like the other task tools', async () => {
    await inOneSession(async (call) => {
      const added = await call('task_add', { title: 'Write the agenda', workstream: 'finance' });
      const r = await call('task_link', { id: added.task.id, url: ASANA });
      expect(r.viewUrl).toContain(`task=${added.task.id}`);
      expect(r.reportBack).toContain(`(${r.viewUrl})`);
    });
  });

  it('refuses an address that is not https, and more than five links on one task', async () => {
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    const s = session(CONFIG());
    await runWithSession(s, () => runWithActor(MAYA, async () => {
      const handlers = makeHandlers(root);
      const call = async (tool, args) => callTool(handlers, root, tool, args);
      const added = JSON.parse((await call('task_add', { title: 'A task', workstream: 'finance' })).content[0].text);
      const id = added.task.id;

      const plain = await call('task_link', { id, url: 'http://app.asana.com/0/1/2' });
      expect(plain.isError).toBe(true);
      expect(plain.content[0].text).toMatch(/https/);

      for (let n = 1; n <= 5; n++) await call('task_link', { id, url: `https://app.asana.com/0/1/${n}` });
      const sixth = await call('task_link', { id, url: 'https://app.asana.com/0/1/6' });
      expect(sixth.isError).toBe(true);
      expect(sixth.content[0].text).toMatch(/at most 5/);
    }));
  });

  it('does not let the caller label an address as another tool', async () => {
    await inOneSession(async (call) => {
      const added = await call('task_add', { title: 'A task', workstream: 'finance' });
      const r = await call('task_link', { id: added.task.id, url: 'https://evil.example.com/0/1/2', system: 'asana' });
      expect(r.task.external[0].system).toBe('other');
    });
  });

  it('strips a credential out of the address before keeping it', async () => {
    await inOneSession(async (call) => {
      const added = await call('task_add', { title: 'A task', workstream: 'finance' });
      const r = await call('task_link', { id: added.task.id, url: 'https://x.atlassian.net/browse/PROJ-1?access_token=abc', ref: 'PROJ-1' });
      expect(r.task.external[0]).toEqual({ system: 'jira', url: 'https://x.atlassian.net/browse/PROJ-1', ref: 'PROJ-1' });
    });
  });
});

describe('an approval that flags a task with a ticket elsewhere', () => {
  it('hands back where those tickets are, and tells the assistant to ask first and only comment', async () => {
    await inOneSession(async (call) => {
      const linkedTask = await call('task_add', { title: 'Set up the booking page', workstream: 'finance' });
      await call('task_link', { id: linkedTask.task.id, url: ASANA, ref: '3400' });
      await call('task_add', { title: 'No ticket for this one', workstream: 'finance' });

      // A rule is significant: it flags all the work in progress below it.
      plan.ops = [{ type: 'addRecord', record: { type: 'rule', text: 'Every customer gets a kickoff call', detail: 'Within three days of signing' } }];
      const queued = await call('contribute', { text: 'a rule', workstream: 'finance' });
      expect(queued.mode).toBe('queued');

      const approved = await call('review_approve', { id: queued.id });
      expect(approved.carryOut).toEqual([{
        task: linkedTask.task.key, title: 'Set up the booking page', owner: expect.any(String),
        external: [{ system: 'asana', host: 'app.asana.com', url: ASANA, ref: '3400' }],
      }]);
      expect(approved.reportBack).toMatch(/also lives in another tool/);
      expect(approved.reportBack).toContain('on app.asana.com');
      expect(approved.reportBack).toMatch(/only after the person says yes/);
      expect(approved.reportBack).toMatch(/do not change a ticket's status, owner or description/);
    });
  });

  it('says nothing about other tools when no flagged task has a link', async () => {
    await inOneSession(async (call) => {
      await call('task_add', { title: 'No ticket', workstream: 'finance' });
      plan.ops = [{ type: 'addRecord', record: { type: 'rule', text: 'A rule', detail: 'Detail' } }];
      const queued = await call('contribute', { text: 'a rule', workstream: 'finance' });
      const approved = await call('review_approve', { id: queued.id });
      expect(approved.carryOut).toBeUndefined();
      expect(approved.reportBack).not.toMatch(/another tool/);
    });
  });
});

describe('who may link a task', () => {
  it('lets the owner or a manager, and refuses another member', async () => {
    const RAVI = { key: 'git:ravi@example.com', name: 'Ravi', email: 'ravi@example.com', source: 'github' };
    const config = CONFIG({ members: [{ key: 'git:ravi@example.com', name: 'Ravi', email: 'ravi@example.com' }] });
    const s = session(config);
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    await runWithSession(s, async () => {
      const handlers = makeHandlers(root);
      const asMaya = (tool, args) => runWithActor(MAYA, () => callTool(handlers, root, tool, args));
      const asRavi = (tool, args) => runWithActor(RAVI, () => callTool(handlers, root, tool, args));
      const added = JSON.parse((await asMaya('task_add', { title: 'Maya\'s task', workstream: 'finance' })).content[0].text);
      const id = added.task.id;

      const refused = await asRavi('task_link', { id, url: ASANA });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/owner or a manager/);

      const ok = await asMaya('task_link', { id, url: ASANA });
      expect(ok.isError).toBeFalsy();
    });
  });
});

describe('ownership is identity, not a name', () => {
  const RAVI = { key: 'git:ravi@example.com', name: 'Ravi', email: 'ravi@example.com', source: 'github' };
  const PRIYA = { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', source: 'github' };
  const member = (a) => ({ key: a.key, name: a.name, email: a.email });
  const setup = () => {
    const root = { __backend: 'github', owner: OWNER, repo: REPO, baseUrl: HOST };
    const s = session(CONFIG({ members: [member(RAVI), member(PRIYA)] }));
    const handlers = makeHandlers(root);
    const as = (actor) => (tool, args) => runWithActor(actor, () => callTool(handlers, root, tool, args));
    return { s, as };
  };

  it('lets a task owned by name be linked by the roster member of that name, and nobody else but a manager', async () => {
    const { s, as } = setup();
    await runWithSession(s, async () => {
      const maya = as(MAYA); const ravi = as(RAVI); const priya = as(PRIYA);
      const added = JSON.parse((await maya('task_add', { title: 'A task', workstream: 'finance' })).content[0].text);
      const id = added.task.id;
      await maya('task_assign', { id, owner: 'Ravi' });

      expect((await priya('task_link', { id, url: ASANA })).isError).toBe(true);
      expect((await ravi('task_link', { id, url: ASANA })).isError).toBeFalsy();
    });
  });

  it('takes the old owner\'s key off a task when it is reassigned', async () => {
    const { s, as } = setup();
    await runWithSession(s, async () => {
      const ravi = as(RAVI);
      const added = JSON.parse((await as(MAYA)('task_add', { title: 'Mine', workstream: 'finance', owner: 'Ravi' })).content[0].text);
      const id = added.task.id;
      const assigned = JSON.parse((await as(MAYA)('task_assign', { id, owner: 'Priya' })).content[0].text);
      expect(assigned.task.owner).toBe('Priya');
      expect(assigned.task.ownerKey).toBeUndefined();
      // Ravi is no longer the owner, so he can no longer link it.
      expect((await ravi('task_link', { id, url: ASANA })).isError).toBe(true);
    });
  });
});

describe('a stored link is checked again when it is used', () => {
  it('reads the tool off the address, so a label edited into the file does not make a link trusted', async () => {
    await inOneSession(async (call) => {
      const added = await call('task_add', { title: 'Set up the booking page', workstream: 'finance' });
      await call('task_link', { id: added.task.id, url: ASANA });

      // Somebody with write access edits the file by hand.
      const file = '.teamctx/workstreams/finance.json';
      const doc = JSON.parse(written.get(file).content);
      doc.tasks[0].external = [{ system: 'asana', url: 'https://evil.example.com/0/1/2' }];
      written.set(file, { content: JSON.stringify(doc), sha: null });

      plan.ops = [{ type: 'addRecord', record: { type: 'rule', text: 'A rule', detail: 'Detail' } }];
      const queued = await call('contribute', { text: 'a rule', workstream: 'finance' });
      const approved = await call('review_approve', { id: queued.id });

      expect(approved.carryOut[0].external[0].system).toBe('other');
      expect(approved.reportBack).toMatch(/does not recognise/);
      expect(approved.reportBack).toMatch(/Do not open them or write to them/);
      expect(approved.reportBack).not.toMatch(/also lives in another tool/);
    });
  });

  it('drops an entry that would not be accepted today', async () => {
    await inOneSession(async (call) => {
      const added = await call('task_add', { title: 'A task', workstream: 'finance' });
      await call('task_link', { id: added.task.id, url: ASANA });
      const file = '.teamctx/workstreams/finance.json';
      const doc = JSON.parse(written.get(file).content);
      doc.tasks[0].external = [{ system: 'asana', url: 'http://app.asana.com/0/1/2' }];
      written.set(file, { content: JSON.stringify(doc), sha: null });

      plan.ops = [{ type: 'addRecord', record: { type: 'rule', text: 'A rule', detail: 'Detail' } }];
      const queued = await call('contribute', { text: 'a rule', workstream: 'finance' });
      const approved = await call('review_approve', { id: queued.id });
      expect(approved.carryOut).toBeUndefined();
    });
  });
});
