/**
 * When the change log entry cannot be written, the change still stands and the
 * assistant is told so in the words it reads back, not only in the JSON.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/context.js', async (orig) => {
  const { applyOps } = await import('../src/ops.js');
  return {
    ...(await orig()),
    updateShared: vi.fn(async (workstream, contribution) => {
      const operations = [{ type: 'addRecord', record: { type: 'decision', text: 'tiers decided', detail: 'three tiers' } }];
      return { workstream: applyOps(workstream, operations, contribution.id).tree, summary: 'records the decision', operations };
    }),
    generateRoleFile: vi.fn(async () => '# role'),
  };
});

const storage = await import('../src/storage.js');
const { makeHandlers, callTool } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const CONFIG = {
  project: 'Webhacks', managerKey: MAYA.key, autoPush: false, reviewPolicy: 'all',
  workstreams: [{ id: 'finance', number: 1, name: 'Finance' }], roles: [], members: [],
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

async function inOneSession(fn) {
  const s = session();
  const root = { __backend: 'github', owner: 'o', repo: 'r', baseUrl: 'https://teamctx.example.app' };
  const handlers = makeHandlers(root);
  const call = async (tool, args) => JSON.parse((await callTool(handlers, root, tool, args)).content[0].text);
  return runWithSession(s, () => runWithActor(MAYA, () => fn({ call, s })));
}

beforeEach(() => __resetMemory());

describe('a change entry that cannot be written', () => {
  it('is said in the report-back when a contribution is applied directly', async () => {
    const spy = vi.spyOn(storage, 'writeChange').mockImplementation(() => { throw new Error('disk full'); });
    try {
      await inOneSession(async ({ call }) => {
        const r = await call('contribute', { text: 'x', workstream: 'finance', apply: true });
        expect(r.mode).toBe('applied');
        expect(r.reportBack).toContain('disk full');
      });
    } finally { spy.mockRestore(); }
  });

  it('is said in the report-back when a queued contribution is approved', async () => {
    await inOneSession(async ({ call, s }) => {
      s.write('.teamctx/queue/q-1.json', JSON.stringify({
        id: 'q-1', status: 'pending', author: 'Priya', workstream: 'finance', summary: 'A decision',
        operations: [{ type: 'addRecord', record: { type: 'decision', text: 'tiers decided' } }],
      }));
      const spy = vi.spyOn(storage, 'writeChange').mockImplementation(() => { throw new Error('disk full'); });
      try {
        const r = await call('review_approve', { id: 'q-1' });
        expect(r.reportBack).toContain('approved contribution q-1');
        expect(r.reportBack).toContain('disk full');
      } finally { spy.mockRestore(); }
    });
  });
});
