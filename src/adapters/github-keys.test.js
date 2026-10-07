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

/**
 * The refusal is about keys that moved, not about config.json being touched.
 *
 * Every hosted write that changes a setting stages config.json — `member_add`,
 * `config_set`, `role_add`, `set_review_policy` — and after the first backfill a
 * project always has counters. A guard that asked whether counters *exist*
 * therefore refused the one safe refresh-and-retry on all of those, and told the
 * caller the project "changed while assigning record keys" when their request
 * assigned none.
 */
describe('a ref conflict on a write that allocated nothing', () => {
  const conflictingFetch = () => vi.fn(async (url, opts) => {
    if (opts?.method === 'PATCH') {
      // Fails once, then succeeds on the retry after the base is refreshed.
      return conflictingFetch.failed
        ? { ok: true, status: 200, json: async () => ({ object: { sha: 'moved' } }) }
        : (conflictingFetch.failed = true, { ok: false, status: 409, text: async () => 'not a fast forward' });
    }
    if (opts?.method === 'POST') return { ok: true, status: 201, json: async () => ({ sha: 'created' }) };
    return { ok: true, status: 200, json: async () => ({ object: { sha: 'newer' }, sha: 'newer', tree: [] }) };
  });

  it('refreshes and retries instead of refusing', async () => {
    const s = session();
    // A setting change: config.json is staged, the counters are untouched.
    runWithSession(s, () => {
      const config = JSON.parse(s.files.get('.teamctx/config.json').content);
      s.write('.teamctx/config.json', JSON.stringify({ ...config, reviewPolicy: 'additive' }));
    });
    conflictingFetch.failed = false;
    vi.stubGlobal('fetch', conflictingFetch());

    await expect(s.commit('Set the review policy')).resolves.toBeDefined();
    expect(s.baseCommitSha).not.toBe('original');
  });

  it('still refuses when the counters did move', async () => {
    // The case the guard is for: these keys were handed out against a project
    // that is no longer the one being written to.
    const s = session();
    runWithSession(s, () => writeTask({ id: 'new', title: 'New' }));
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => (opts.method === 'PATCH'
      ? { ok: false, status: 409, text: async () => 'not a fast forward' }
      : { ok: true, status: 201, json: async () => ({ sha: 'created' }) })));

    await expect(s.commit('Add task')).rejects.toThrow(/Nothing from this request was committed/);
  });
});
