/**
 * The hosted server downloads recent change-log files up front and older ones
 * only when a reader asks (#206): a busy project's log grows by thousands of
 * files a year, one GitHub call each.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubSession } from './github.js';
import { runWithSession } from '../session-context.js';
import { listChanges, prepareChanges } from '../storage.js';
import { prepareTaskChanges } from '../../cli/commands/task.core.js';
import { makeConfig, makeWorkstream } from '../test-fixtures/model.js';

afterEach(() => vi.unstubAllGlobals());

const day = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const name = (at, part, id) => `${at.replace(/[:.]/g, '')}.${part}.${id}.json`;

function github(files) {
  const fetched = [];
  const blobs = new Map(Object.entries(files).map(([path, body], i) => [`sha${i}`, { path, body }]));
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/git/refs/heads/')) return { ok: true, status: 200, json: async () => ({ object: { sha: 'c1' } }) };
    if (u.includes('/git/commits/')) return { ok: true, status: 200, json: async () => ({ tree: { sha: 't1' } }) };
    if (u.includes('/git/trees/')) {
      return { ok: true, status: 200, json: async () => ({ tree: [...blobs].map(([sha, b]) => ({ type: 'blob', path: b.path, sha })) }) };
    }
    const sha = u.split('/git/blobs/')[1];
    fetched.push(blobs.get(sha).path);
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: Buffer.from(blobs.get(sha).body).toString('base64') }) };
  }));
  return fetched;
}

const entry = (id, at, tree) => JSON.stringify({ id, at, tree, summary: [id], touched: { records: [], tasks: [] } });

describe('the change log on the hosted server', () => {
  const recentAt = iso(2 * day);
  const oldAt = iso(90 * day);
  const olderAt = iso(200 * day);
  const files = {
    '.teamctx/config.json': '{}',
    [`.teamctx/changes/${name(recentAt, 'registration', 'c-recent')}`]: entry('c-recent', recentAt, 'registration'),
    [`.teamctx/changes/${name(oldAt, 'registration', 'c-old')}`]: entry('c-old', oldAt, 'registration'),
    [`.teamctx/changes/${name(olderAt, 'registration', 'c-older')}`]: entry('c-older', olderAt, 'registration'),
  };

  it('downloads only recent log files up front, and still lists the rest', async () => {
    const fetched = github(files);
    const s = new GithubSession({ owner: 'o', repo: 'r', ref: 'main', ghToken: 't' });
    await s.prefetch();
    expect(fetched.sort()).toEqual(['.teamctx/changes/' + name(recentAt, 'registration', 'c-recent'), '.teamctx/config.json'].sort());
    expect(s.listDir('.teamctx/changes')).toHaveLength(3);
    expect(runWithSession(s, () => listChanges({})).map(e => e.id)).toEqual(['c-recent']);
  });

  it('fetches only the older files a reader asks for', async () => {
    const fetched = github(files);
    const s = new GithubSession({ owner: 'o', repo: 'r', ref: 'main', ghToken: 't' });
    await s.prefetch();
    fetched.length = 0;
    const since = iso(100 * day);
    await runWithSession(s, () => prepareChanges({ after: since, trees: [null, 'registration'] }));
    expect(fetched).toEqual(['.teamctx/changes/' + name(oldAt, 'registration', 'c-old')]);
    expect(runWithSession(s, () => listChanges({ after: since })).map(e => e.id)).toEqual(['c-old', 'c-recent']);
  });

  it('fetches from the compile time for a compile, which may be older than the last output', async () => {
    const task = { id: 't1', title: 'Badges', workstream: 'registration', status: 'open', compiledAt: iso(100 * day) };
    const withTask = {
      ...files,
      '.teamctx/config.json': JSON.stringify(makeConfig({ workstreams: [{ id: 'registration', number: 1, name: 'Registration' }] })),
      '.teamctx/workstreams/registration.json': JSON.stringify(makeWorkstream('registration', { tasks: [task] })),
      '.teamctx/outputs/t1/o1.json': JSON.stringify({ id: 'o1', at: iso(10 * day), body: 'v1' }),
    };
    const fetched = github(withTask);
    const s = new GithubSession({ owner: 'o', repo: 'r', ref: 'main', ghToken: 't' });
    await s.prefetch();
    fetched.length = 0;
    await runWithSession(s, () => prepareTaskChanges({ id: 't1' }));
    expect(fetched).toEqual([]);
    await runWithSession(s, () => prepareTaskChanges({ id: 't1', sinceCompiled: true }));
    expect(fetched).toEqual(['.teamctx/changes/' + name(oldAt, 'registration', 'c-old')]);
  });
});
