/**
 * On the hosted server, the Slack notice for a queued item (#182) uses the
 * project's webhook from the store and links to the address this server answers
 * on, and the webhook is in nothing the tool hands back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { makeHandlers } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory, kvSet, keys } = await import('../src/oauth/kv.js');
const { emptyProject, emptyWorkstream } = await import('../src/model.js');

const MAYA = { key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'github' };
const HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXSECRET';
const CONFIG = {
  project: 'Ledger', managerKey: MAYA.key, reviewPolicy: 'all', deployUrl: 'https://stale.example',
  workstreams: [{ id: 'product', number: 1, name: 'Product' }], nextKey: { workstream: 2, tasks: {} }, roles: [], members: [],
};

function session() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: null }],
    ['.teamctx/project.json', { content: JSON.stringify({ ...emptyProject('Ledger'), goal: { text: 'Ship it' } }), sha: null }],
    ['.teamctx/workstreams/product.json', { content: JSON.stringify(emptyWorkstream('product', 'Product')), sha: null }],
    ['.teamctx/contributions.jsonl', { content: '', sha: null }],
  ]);
  return {
    owner: 'acme', repo: 'ledger',
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

let fetchMock;
beforeEach(() => {
  __resetMemory();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('a task\'s work sent for review on the hosted server', () => {
  it('is posted to the project\'s webhook, linking to this server', async () => {
    await kvSet(keys.slackWebhook('acme', 'ledger'), { url: HOOK, setBy: 'maya@example.com', setAt: 'now' });
    const result = await runWithSession(session(), () => runWithActor(MAYA, async () => {
      const h = makeHandlers({ __backend: 'github', owner: 'acme', repo: 'ledger', baseUrl: 'https://srv.example' });
      const added = JSON.parse((await h.task_add({ title: 'Draft the post', workstream: 'product' })).content[0].text);
      const id = added.task?.id || added.id;
      await h.task_output({ id, title: 'First draft', body: 'the draft' });
      return (await h.task_submit({ id })).content[0].text;
    }));
    const posts = fetchMock.mock.calls.filter(([url]) => url === HOOK);
    expect(posts).toHaveLength(1);
    const { id: reviewId } = JSON.parse(result);
    expect(JSON.parse(posts[0][1].body).text).toContain(`<https://srv.example/project/acme/ledger?review=${reviewId}|Open it>`);
    expect(result).not.toContain('SECRET');
  });
});
