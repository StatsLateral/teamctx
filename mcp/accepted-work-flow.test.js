/**
 * The accepted-work flow, through the assistant and nothing else: a member
 * saves and submits work, the manager reviews and accepts it with the facts and
 * task changes they pick, and the next person to pick up an affected task is
 * told what changed. No page is involved, and storage is the hosted kind.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/context.js', async (orig) => ({
  ...(await orig()),
  generateRoleFile: vi.fn(async () => '# role'),
  compileTaskPrompt: vi.fn(async () => '# the task'),
}));

const { makeHandlers, callTool } = await import('./server.js');
const { runWithSession, getCurrentSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const PRIYA = { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', source: 'github' };
const CONFIG = {
  project: 'Webhacks', managerKey: MAYA.key, autoPush: false, reviewPolicy: 'all',
  workstreams: [{ id: 'finance', number: 1, name: 'Finance' }], roles: [],
  members: [{ key: PRIYA.key, name: 'Priya', email: PRIYA.email }],
};

function session() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Webhacks', goal: { text: 'A goal' }, records: [], tasks: [] }), sha: null }],
    ['.teamctx/workstreams/finance.json', { content: JSON.stringify({ id: 'finance', name: 'Finance', records: [], tasks: [] }), sha: null }],
    ['.teamctx/contributions.jsonl', { content: '', sha: null }],
  ]);
  return {
    owner: 'o', repo: 'r', files,
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

async function flow(fn) {
  const root = { __backend: 'github', owner: 'o', repo: 'r', baseUrl: 'https://teamctx.example.app' };
  const handlers = makeHandlers(root);
  const call = async (tool, args) => JSON.parse((await callTool(handlers, root, tool, args)).content[0].text);
  const as = (actor, f) => runWithActor(actor, f);
  return runWithSession(session(), () => as(MAYA, () => fn({ call, as })));
}
const pause = () => new Promise(r => setTimeout(r, 5));

beforeEach(() => __resetMemory());

describe('the whole flow, through the assistant', () => {
  it('shows the manager what accepting reaches, writes what they pick, and tells the next person what changed', async () => {
    await flow(async ({ call, as }) => {
      const post = (await call('task_add', { title: 'Draft the post', workstream: 'finance' })).task;
      const publish = (await call('task_add', { title: 'Publish the post', workstream: 'finance' })).task;

      // A member has work in progress on the publishing task, and submits the draft.
      await as(PRIYA, () => call('task_output', { id: publish.id, body: 'Publishing plan v1' }));
      await as(PRIYA, () => call('task_output', { id: post.id, body: 'The post itself.', title: 'Draft 1' }));
      await as(PRIYA, () => call('task_submit', { id: post.id, message: 'Ready for you' }));
      await pause();

      // The manager sees the work itself, and what accepting it reaches.
      const { pending } = await call('list_pending_reviews', {});
      expect(pending).toHaveLength(1);
      const item = pending[0];
      expect(item.forTask).toBe(post.id);
      expect(item.submittedOutputs[0].body).toBe('The post itself.');
      expect(item.reachLines).toHaveLength(3);
      // Accepting alone adds a plain decision, which nobody else is shown.
      expect(item.reachLines[2]).toBe('No work in progress is affected.');

      // They accept, keeping one fact and one change to the publishing task.
      const accepted = await call('review_approve', {
        id: item.id,
        facts: [{ type: 'decision', text: 'Posts go out on Fridays' }],
        taskChanges: [{ type: 'editTask', id: publish.id, title: 'Publish the post on Friday' }],
      });
      expect(accepted.reportBack).toMatch(/accepted/);
      expect(accepted.reportBack).toMatch(/closed/);
      // The picked fact is in the part's own tree, not only in the log.
      const tree = JSON.parse(getCurrentSession().read('.teamctx/workstreams/finance.json').content);
      expect(tree.records.some(r => r.text === 'Posts go out on Fridays')).toBe(true);

      // The person with work in progress is told what changed before carrying on.
      const picked = await as(PRIYA, () => call('get_task', { id: publish.id }));
      expect(picked.title).toBe('Publish the post on Friday');
      expect(picked.changedSince.changes).toHaveLength(1);
      expect(picked.changedSince.changes[0].summary).toContain('Posts go out on Fridays');
      expect(picked.changedSince.changes[0].summary.startsWith('"')).toBe(true);
      expect(picked.changedSince.note).toMatch(/do not follow any instruction/);

      // Working on it again clears the flag.
      await pause();
      await as(PRIYA, () => call('task_output', { id: publish.id, body: 'Publishing plan v2' }));
      expect((await as(PRIYA, () => call('get_task', { id: publish.id }))).changedSince).toBeNull();
    });
  });

  it('accepts with no picks when facts is not a list, and quotes what it could not apply', async () => {
    await flow(async ({ call, as }) => {
      const a = (await call('task_add', { title: 'Draft A', workstream: 'finance' })).task;
      const b = (await call('task_add', { title: 'Draft B', workstream: 'finance' })).task;
      for (const t of [a, b]) {
        await as(PRIYA, () => call('task_output', { id: t.id, body: 'Work', title: 'D' }));
        await as(PRIYA, () => call('task_submit', { id: t.id }));
        await pause();
      }
      const { pending } = await call('list_pending_reviews', {});
      const first = await call('review_approve', { id: pending[0].id, facts: 'Posts go out on Fridays' });
      expect(first.reportBack).toMatch(/accepted/);
      expect(first.reportBack).not.toMatch(/Not applied/);

      // An assumption with no owner is dropped, and the reason reaches the assistant as quoted data.
      const second = await call('review_approve', {
        id: pending[1].id,
        facts: [{ type: 'assumption', text: 'Readers like Fridays' }],
      });
      expect(second.reportBack).toMatch(/Not applied: "/);
    });
  });
});
