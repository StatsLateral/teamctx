import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubSession } from './github.js';
import { runWithSession } from '../session-context.js';
import { withRecordKeys, readProject, readConfig, writeTask } from '../storage.js';

afterEach(() => vi.unstubAllGlobals());

function session() {
  const s = new GithubSession({ owner: 'team', repo: 'project', ref: 'main', ghToken: 'test-token' });
  s.prefetched = true;
  s.baseCommitSha = 'original';
  s.baseTreeSha = 'original-tree';
  s.files.set('.teamctx/config.json', { content: JSON.stringify({ nextKey: { T: 4 } }), sha: 'config' });
  s.files.set('.teamctx/project.json', { content: JSON.stringify({ records: [], tasks: [{ id: 'old', title: 'Old', createdAt: '2026-10-01' }] }), sha: 'project' });
  return s;
}

describe('key allocation in hosted storage', () => {
  it('buffers backfill and allocation in the same request without changing the baseline', () => {
    const s = session();
    runWithSession(s, () => {
      writeTask({ id: 'new', title: 'New' });
      expect(readProject().tasks.map(t => t.key)).toEqual(['T-4', 'T-5']);
      expect(readConfig().nextKey.T).toBe(6);
      const staged = [...s.changes];
      withRecordKeys(undefined, () => {});
      expect([...s.changes]).toEqual(staged);
    });
    expect(JSON.parse(s.files.get('.teamctx/project.json').content).tasks[0].key).toBeUndefined();
  });

  it.each([409, 422])('refuses to replay allocated keys after a %s ref conflict', async status => {
    const s = session();
    runWithSession(s, () => writeTask({ id: 'new', title: 'New' }));
    const fetch = vi.fn(async (url, opts) => opts.method === 'PATCH'
      ? { ok: false, status, text: async () => 'not a fast forward' }
      : { ok: true, status: 201, json: async () => ({ sha: 'created' }) });
    vi.stubGlobal('fetch', fetch);
    await expect(s.commit('Add task')).rejects.toThrow(/Nothing from this request was committed/);
    expect(fetch.mock.calls.filter(([, opts]) => opts.method === 'PATCH')).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, opts]) => opts.method === 'GET')).toHaveLength(0);
    expect(s.baseCommitSha).toBe('original');
  });
});
