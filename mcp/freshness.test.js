/**
 * How fresh the context is, said where an assistant reads it (#183): in
 * `get_status`, and as a line under the title of a role file.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const { makeHandlers, callTool } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const CONFIG = {
  project: 'Webhacks', managerKey: MAYA.key, autoPush: false, reviewPolicy: 'all',
  workstreams: [{ id: 'finance', number: 1, name: 'Finance' }],
  roles: [{ slug: 'analyst', name: 'Analyst', workstream: 'finance' }], members: [],
};

function session(extra = {}) {
  const files = new Map(Object.entries({
    '.teamctx/config.json': JSON.stringify(CONFIG),
    '.teamctx/project.json': JSON.stringify({ name: 'Webhacks', goal: { text: 'A goal' }, records: [], tasks: [] }),
    '.teamctx/workstreams/finance.json': JSON.stringify({ id: 'finance', name: 'Finance', records: [], tasks: [] }),
    '.teamctx/contributions.jsonl': '',
    '.teamctx/context/roles/analyst.md': '# Analyst Context — Webhacks\n*Last updated: 2026-10-01*\n\n## Your Role\n',
    ...extra,
  }).map(([p, content]) => [p, { content, sha: null }]));
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

async function inSession(extra, fn) {
  const root = { __backend: 'github', owner: 'o', repo: 'r', baseUrl: 'https://teamctx.example.app' };
  const handlers = makeHandlers(root);
  const call = async (tool, args) => {
    const text = (await callTool(handlers, root, tool, args)).content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };
  return runWithSession(session(extra), () => runWithActor(MAYA, () => fn(call)));
}

const approval = (id, approvedAt) => [`.teamctx/approved/${id}.json`, JSON.stringify({ id, approvedAt })];
const queued = (id) => [`.teamctx/queue/${id}.json`, JSON.stringify({ id, createdAt: '2026-10-10T00:00:00.000Z', operations: [] })];

beforeEach(() => __resetMemory());

describe('freshness in get_status and role files', () => {
  it('reports the newest approval and the count waiting', async () => {
    const extra = Object.fromEntries([
      approval('c1', '2026-09-01T10:00:00.000Z'), approval('c2', '2026-10-02T10:00:00.000Z'),
      queued('q1'), queued('q2'), queued('q3'),
    ]);
    await inSession(extra, async (call) => {
      const status = await call('get_status', {});
      expect(status.freshness.lastApprovedAt).toBe('2026-10-02T10:00:00.000Z');
      expect(status.freshness.waiting).toBe(3);
      expect(status.freshness.line).toMatch(/^Context last approved \d+ days ago; 3 items waiting$/);
      const role = await call('get_role_context', { role: 'analyst' });
      const lines = role.split('\n');
      expect(lines[0]).toBe('# Analyst Context — Webhacks');
      expect(lines[1]).toMatch(/^\*Context last approved \d+ days ago; 3 items waiting\*$/);
    });
  });

  it('says "not recorded" and "nothing waiting" for a project with neither', async () => {
    await inSession({}, async (call) => {
      const status = await call('get_status', {});
      expect(status.freshness).toMatchObject({ lastApprovedAt: null, waiting: 0, line: 'Context last approved: not recorded; nothing waiting' });
      const role = await call('get_role_context', { role: 'analyst' });
      expect(role.split('\n')[1]).toBe('*Context last approved: not recorded; nothing waiting*');
    });
  });
});
