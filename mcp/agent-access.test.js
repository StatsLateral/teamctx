/**
 * An unattended agent on the hosted connector.
 *
 * What an agent may do is decided here, on the server: what `tools/list` shows
 * it, what `tools/call` lets through, and the rules its three tools apply to it
 * and to nobody else. The GitHub layer is faked; the actor context, storage
 * dispatch, scope check and review queue are the real thing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/context.js', async (orig) => ({
  ...(await orig()),
  // The one AI call on this path. An add-only proposal, which the `additive`
  // policy would write straight to the tree for anyone else.
  updateShared: vi.fn(async (workstream) => ({
    workstream: { ...workstream, whys: [...(workstream.whys || []), { id: 'n1', text: 'nightly numbers' }] },
    summary: 'adds nightly numbers',
    operations: [{ type: 'addWhy', text: 'nightly numbers' }],
  })),
}));

const { makeHandlers, TOOLS, toolsFor, callTool } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { actorFromAgent } = await import('../src/agents.js');
const { __resetMemory, kvSet, keys } = await import('../src/oauth/kv.js');
const { updateShared } = await import('../src/context.js');

const AGENT = { id: 'a1', name: 'Nightly report', dailyLimit: 20 };
const ROOT = { __backend: 'github', owner: 'acme', repo: 'ledger', agent: AGENT };
const PERSON_ROOT = { __backend: 'github', owner: 'acme', repo: 'ledger' };

const baseConfig = (over = {}) => ({
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  autoPush: false,
  roles: [],
  reviewPolicy: 'additive',
  workstreams: [{ id: 'pricing', name: 'Pricing' }, { id: 'hiring', name: 'Hiring' }],
  activeWorkstream: null,
  workstreamsMigrated: true,
  projectLayerMigrated: true,
  members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent' }],
  ...over,
});

function fakeSession(config = baseConfig()) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(config) }],
    ['.teamctx/contributions.jsonl', { content: '' }],
    ['.teamctx/project.json', { content: JSON.stringify({
      name: 'Ledger',
      whys: [{ id: 'p1', text: 'ship the ledger' }],
      tasks: [
        { id: 'nightly-numbers', title: 'Nightly numbers', owner: 'Nightly report', status: 'open', createdAt: '2026-09-01' },
        { id: 'sams-review', title: 'Sam reviews pricing', owner: 'Sam', ownerKey: 'git:sam@example.com', status: 'open', createdAt: '2026-09-01' },
      ],
    }) }],
    ['.teamctx/workstreams/pricing.json', { content: JSON.stringify({ id: 'pricing', name: 'Pricing', whys: [{ id: 'w1', text: 'price it' }] }) }],
    ['.teamctx/workstreams/hiring.json', { content: JSON.stringify({ id: 'hiring', name: 'Hiring', whys: [{ id: 'h1', text: 'hire' }] }) }],
  ]);
  const commits = [];
  return {
    owner: 'acme', repo: 'ledger', ghToken: 'lent', commits,
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c) }),
    del: p => files.delete(p),
    listDir: dirPath => {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      return [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    },
    commit: async msg => { commits.push(msg); return { committed: true }; },
    file: p => files.get(p)?.content,
  };
}

/** One request by the agent: its actor, in a session, through the call guard. */
function asAgent(session, name, args, root = ROOT) {
  return runWithSession(session, () => runWithActor(actorFromAgent(AGENT),
    () => callTool(makeHandlers(root), root, name, args)));
}
const text = r => r.content[0].text;
const json = r => JSON.parse(text(r));

beforeEach(() => { __resetMemory(); vi.clearAllMocks(); });

describe('what an agent is shown', () => {
  it('lists exactly its three tools', () => {
    expect(toolsFor(ROOT).map(t => t.name)).toEqual(['my_brief', 'contribute', 'task_done']);
  });

  it('describes contribute without apply or author, which it cannot use', () => {
    const contribute = toolsFor(ROOT).find(t => t.name === 'contribute');
    expect(Object.keys(contribute.inputSchema.properties)).toEqual(['text', 'workstream', 'decision']);
  });

  it('leaves a person\'s list untouched', () => {
    expect(toolsFor(PERSON_ROOT)).toBe(TOOLS);
  });
});

describe('what an agent can call', () => {
  it('gets the unknown-tool answer for any other tool, and nothing runs', async () => {
    const session = fakeSession();
    for (const name of ['review_approve', 'member_add', 'ask', 'get_context', 'submit_contribution', 'manager_add']) {
      await expect(asAgent(session, name, {})).rejects.toThrow(`Unknown tool: ${name}`);
    }
    expect(session.commits).toEqual([]);
  });

  it('is refused everything once it is off the roster', async () => {
    // No entry means no scope, and no scope reads as the whole project.
    const session = fakeSession(baseConfig({ members: [] }));
    const r = await asAgent(session, 'my_brief', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no longer on the project/);
  });

  it('is refused when its key sits on a person\'s entry rather than an agent\'s', async () => {
    const session = fakeSession(baseConfig({ members: [{ key: 'agent:a1', name: 'Nightly report' }] }));
    expect((await asAgent(session, 'my_brief', {})).isError).toBe(true);
  });
});

describe('my_brief for an agent', () => {
  it('shows the tasks assigned to its name, and not other people\'s', async () => {
    const brief = json(await asAgent(fakeSession(), 'my_brief', {}));
    const titles = brief.tasks.open.flatMap(g => g.tasks.map(t => t.id));
    expect(titles).toEqual(['nightly-numbers']);
  });

  it('reads only the workstreams it is scoped to', async () => {
    const session = fakeSession(baseConfig({
      members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent', workstreams: ['pricing'] }],
    }));
    const brief = json(await asAgent(session, 'my_brief', {}));
    expect(brief.where).toEqual(['pricing']);
  });

  it('keeps its scope on a project with no manager gate, where everyone can approve', async () => {
    // A manager has no scope, and with no gate everyone passes as one.
    const session = fakeSession(baseConfig({
      managerKey: undefined,
      members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent', workstreams: ['pricing'] }],
    }));
    const brief = json(await asAgent(session, 'my_brief', {}));
    expect(brief.where).toEqual(['pricing']);
  });

  it('keeps its scope when it shares the name of a display-name gate', async () => {
    const session = fakeSession(baseConfig({
      managerKey: undefined,
      manager: 'Nightly report',
      members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent', workstreams: ['pricing'] }],
    }));
    const brief = json(await asAgent(session, 'my_brief', {}));
    expect(brief.where).toEqual(['pricing']);
  });
});

describe('contribute for an agent', () => {
  it('queues under a policy that would apply it for anyone else', async () => {
    const session = fakeSession();
    const r = json(await asAgent(session, 'contribute', { text: 'Last night: 41 signups.' }));
    expect(r.mode).toBe('queued');
    expect(JSON.parse(session.file('.teamctx/project.json')).whys.map(w => w.id)).toEqual(['p1']);
  });

  it('applies the same contribution for a person, which is what makes the rule the agent\'s', async () => {
    const session = fakeSession(baseConfig({ members: [] }));
    const person = { key: 'git:sam@example.com', name: 'Sam', email: 'sam@example.com', source: 'google' };
    const r = await runWithSession(session, () => runWithActor(person,
      () => callTool(makeHandlers(PERSON_ROOT), PERSON_ROOT, 'contribute', { text: 'Last night: 41 signups.' })));
    expect(json(r).mode).toBe('applied');
  });

  it('refuses apply, before any AI call', async () => {
    const r = await asAgent(fakeSession(), 'contribute', { text: 'x', apply: true });
    expect(text(r)).toMatch(/always goes to review/);
    expect(updateShared).not.toHaveBeenCalled();
  });

  it('writes as itself whatever author it names', async () => {
    const r = json(await asAgent(fakeSession(), 'contribute', { text: 'x', author: 'Maya' }));
    expect(r.author).toBe('Nightly report');
  });

  it('stops at the daily limit, before the AI call, and says when it resets', async () => {
    const session = fakeSession();
    const root = { ...ROOT, agent: { ...AGENT, dailyLimit: 1 } };
    expect(json(await asAgent(session, 'contribute', { text: 'one' }, root)).mode).toBe('queued');
    const refused = await asAgent(session, 'contribute', { text: 'two' }, root);
    expect(text(refused)).toMatch(/daily limit\. It can send more after \d{4}-\d\d-\d\dT00:00:00\.000Z/);
    expect(updateShared).toHaveBeenCalledTimes(1);
  });

  it('is refused a workstream outside its scope', async () => {
    const session = fakeSession(baseConfig({
      members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent', workstreams: ['pricing'] }],
    }));
    const r = await asAgent(session, 'contribute', { text: 'x', workstream: 'hiring' });
    expect(r.isError).toBe(true);
    expect(updateShared).not.toHaveBeenCalled();
  });

  it('does not count a refused workstream against its daily limit', async () => {
    const session = fakeSession(baseConfig({
      members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent', workstreams: ['pricing'] }],
    }));
    const root = { ...ROOT, agent: { ...AGENT, dailyLimit: 1 } };
    await asAgent(session, 'contribute', { text: 'x', workstream: 'hiring' }, root);
    await asAgent(session, 'contribute', { text: 'x', workstream: 'nope' }, root);
    expect(json(await asAgent(session, 'contribute', { text: 'real work' }, root)).mode).toBe('queued');
  });
});

describe('task_done for an agent', () => {
  it('closes its own task', async () => {
    const r = json(await asAgent(fakeSession(), 'task_done', { id: 'nightly-numbers' }));
    expect(r.task.status).toBe('done');
  });

  it('refuses somebody else\'s, and changes nothing', async () => {
    const session = fakeSession();
    const r = await asAgent(session, 'task_done', { id: 'sams-review' });
    expect(text(r)).toMatch(/not assigned to this agent/);
    expect(session.commits).toEqual([]);
  });
});

describe('the store the limit is kept in', () => {
  it('is the hosted one, so a limit holds across requests', async () => {
    const session = fakeSession();
    const root = { ...ROOT, agent: { ...AGENT, dailyLimit: 1 } };
    await kvSet(keys.agentDaily('a1', new Date().toISOString().slice(0, 10)), 1);
    expect(text(await asAgent(session, 'contribute', { text: 'x' }, root))).toMatch(/daily limit/);
  });
});
