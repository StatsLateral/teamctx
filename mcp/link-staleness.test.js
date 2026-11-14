/**
 * Staleness checks on link outputs (#248), through the assistant and hosted
 * storage: a member attaches a cloud-file link, later checks whether the file
 * changed, and the result is recorded for the page to show. The connector read
 * is injected so the test does not stand up a real Drive/Dropbox account — the
 * connectors' own version reads are covered in their own tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/context.js', async (orig) => ({
  ...(await orig()),
  generateRoleFile: vi.fn(async () => '# role'),
  compileTaskPrompt: vi.fn(async () => '# the task'),
}));

const { makeHandlers, callTool } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');
const { checkLinkOutputs } = await import('../cli/commands/task.core.js');
const { listOutputs, writeOutput, readChecks } = await import('../src/storage.js');

const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const PRIYA = { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', source: 'github' };
const CONFIG = {
  project: 'Webhacks', managerKey: MAYA.key, autoPush: false, reviewPolicy: 'all',
  workstreams: [{ id: 'finance', number: 1, name: 'Finance' }], roles: [],
  members: [{ key: PRIYA.key, name: 'Priya', email: PRIYA.email }],
};
const ROOT = { __backend: 'github', owner: 'o', repo: 'r', baseUrl: 'https://teamctx.example.app' };
const LINK = 'https://drive.google.com/file/d/ABC/view';

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
  const handlers = makeHandlers(ROOT);
  const call = async (tool, args) => JSON.parse((await callTool(handlers, ROOT, tool, args)).content[0].text);
  const as = (actor, f) => runWithActor(actor, f);
  return runWithSession(session(), () => as(MAYA, () => fn({ call, as })));
}
const pause = () => new Promise(r => setTimeout(r, 5));

/** Attach a link output as Priya and return it, optionally forcing a versionKey
 *  the attach could not read in a test (no real connector credential). */
async function attachWith(call, as, taskId, versionKey) {
  await as(PRIYA, () => call('task_attach_link', { id: taskId, url: LINK, connector: 'gdrive', title: 'Banner' }));
  const [out] = listOutputs(taskId, ROOT);
  if (versionKey) writeOutput({ ...out, link: { ...out.link, versionKey } }, ROOT);
  return listOutputs(taskId, ROOT)[0];
}

const check = (id, readVersion) => runWithActor(PRIYA, () => checkLinkOutputs({ id, teamctxDir: ROOT, readVersion }));

beforeEach(() => __resetMemory());

describe('link-output staleness checks', () => {
  it('reports unknown when nothing was recorded to compare against', async () => {
    await flow(async ({ call, as }) => {
      const task = (await call('task_add', { title: 'Design the banner', workstream: 'finance' })).task;
      await attachWith(call, as, task.id); // no versionKey captured in a test
      const r = await check(task.id, async () => 'V1');
      expect(r.checks).toHaveLength(1);
      expect(r.checks[0].state).toBe('unknown');
      expect(r.checks[0].reason).toMatch(/no version was recorded/);
    });
  });

  it('reports unchanged when the current marker matches', async () => {
    await flow(async ({ call, as }) => {
      const task = (await call('task_add', { title: 'Design the banner', workstream: 'finance' })).task;
      await attachWith(call, as, task.id, 'V1');
      const r = await check(task.id, async () => 'V1');
      expect(r.checks[0].state).toBe('unchanged');
      expect(r.checks[0].basis).toBe('attached');
    });
  });

  it('reports changed when the current marker differs', async () => {
    await flow(async ({ call, as }) => {
      const task = (await call('task_add', { title: 'Design the banner', workstream: 'finance' })).task;
      await attachWith(call, as, task.id, 'V1');
      const r = await check(task.id, async () => 'V2');
      expect(r.checks[0].state).toBe('changed');
      expect(r.checks[0].observed).toBe('V2');
      expect(r.checks[0].baseline).toBe('V1');
    });
  });

  it('reports unknown — not unchanged — when the file cannot be read now', async () => {
    await flow(async ({ call, as }) => {
      const task = (await call('task_add', { title: 'Design the banner', workstream: 'finance' })).task;
      await attachWith(call, as, task.id, 'V1');
      const r = await check(task.id, async () => null);
      expect(r.checks[0].state).toBe('unknown');
      expect(r.checks[0].reason).toMatch(/could not be read/);
    });
  });

  it('compares against the approved version once the work is accepted', async () => {
    await flow(async ({ call, as }) => {
      const task = (await call('task_add', { title: 'Design the banner', workstream: 'finance' })).task;
      await attachWith(call, as, task.id, 'V1');
      await as(PRIYA, () => call('task_submit', { id: task.id, message: 'Ready' }));
      await pause();
      const { pending } = await call('list_pending_reviews', {});
      await call('review_approve', { id: pending[0].id });
      await pause();
      const r = await check(task.id, async () => 'V2');
      expect(r.checks[0].basis).toBe('approved');
      expect(r.checks[0].baseline).toBe('V1');
      expect(r.checks[0].state).toBe('changed');
    });
  });

  it('reads through the connected account and records which one answered (hosted #248)', async () => {
    await flow(async ({ call, as }) => {
      const task = (await call('task_add', { title: 'Design the banner', workstream: 'finance' })).task;
      await attachWith(call, as, task.id, 'V1');
      let sawCreds = null;
      const readVersion = async ({ creds }) => { sawCreds = creds; return 'V1'; };
      // Stands in for the hosted endpoint's resolver: the primary manager's
      // connection answered this member's check.
      const authFor = async ({ connector }) => (connector === 'gdrive'
        ? { creds: { ok: true, accessToken: 'at' }, via: 'project' }
        : null);
      const r = await runWithActor(PRIYA,
        () => checkLinkOutputs({ id: task.id, teamctxDir: ROOT, readVersion, authFor }));
      expect(sawCreds).toMatchObject({ accessToken: 'at' });
      expect(r.checks[0].state).toBe('unchanged');
      expect(r.checks[0].via).toBe('project');
    });
  });

  it('records the result where the page can read it, and reports it through the tool', async () => {
    await flow(async ({ call, as }) => {
      const task = (await call('task_add', { title: 'Design the banner', workstream: 'finance' })).task;
      const out = await attachWith(call, as, task.id, 'V1');
      await check(task.id, async () => 'V2');
      const stored = readChecks(task.id, ROOT);
      expect(stored[out.id]?.state).toBe('changed');

      // The tool itself re-checks live; with no connector credential in a test
      // it honestly reports it cannot tell, naming the file rather than guessing.
      const r = await call('task_check_links', { id: task.id });
      expect(r.reportBack).toMatch(/Checked link outputs on task 1\.1/);
      expect(r.reportBack).toMatch(/Banner/);
    });
  });
});
