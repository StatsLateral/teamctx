/**
 * Deleting a path the repository does not have, on the hosted server.
 *
 * GitHub refuses a tree entry that deletes a missing path (422 BadObjectState),
 * and the whole commit failed with it: removing a task that was never compiled
 * deletes its prompt file, which was never written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubSession } from './github.js';
import { runWithSession } from '../session-context.js';
import { deleteTask, writeTask } from '../storage.js';

afterEach(() => vi.unstubAllGlobals());

function session() {
  const s = new GithubSession({ owner: 'team', repo: 'project', ref: 'main', ghToken: 'test-token' });
  s.prefetched = true;
  s.baseCommitSha = 'original';
  s.baseTreeSha = 'original-tree';
  s.files.set('.teamctx/config.json', { content: JSON.stringify({ workstreams: [{ id: 'ops', number: 2, name: 'Ops' }], nextKey: { workstream: 3, tasks: { ops: 1 } } }), sha: 'config' });
  s.files.set('.teamctx/project.json', { content: JSON.stringify({ records: [], tasks: [] }), sha: 'project' });
  s.files.set('.teamctx/workstreams/ops.json', { content: JSON.stringify({ id: 'ops', name: 'Ops', records: [], tasks: [{ id: 't-a', key: '2.1', title: 'A', workstream: 'ops', status: 'open' }] }), sha: 'ops' });
  return s;
}

describe('deleting on the hosted server', () => {
  it('sends no deletion for a file the repository never had', async () => {
    const s = session();
    runWithSession(s, () => deleteTask('t-a'));
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts?.body) bodies.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 201, json: async () => ({ sha: 'created' }) };
    }));
    await s.commit('rm t-a');
    const tree = bodies.find(b => b.url.endsWith('/git/trees')).body.tree;
    expect(tree.map(e => e.path)).toEqual(['.teamctx/workstreams/ops.json']);
  });

  it('still deletes a file the repository has', () => {
    const s = session();
    s.files.set('.teamctx/context/tasks/t-a.md', { content: '# A', sha: 'prompt' });
    runWithSession(s, () => deleteTask('t-a'));
    expect(s.changes.get('.teamctx/context/tasks/t-a.md')).toBeNull();
  });

  it('drops a file written and deleted in the same request', () => {
    const s = session();
    runWithSession(s, () => { writeTask({ id: 'new', title: 'New', workstream: 'ops' }); });
    s.write('.teamctx/scratch.json', '{}');
    s.del('.teamctx/scratch.json');
    expect(s.changes.has('.teamctx/scratch.json')).toBe(false);
  });
});
