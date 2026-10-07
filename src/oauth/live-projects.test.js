/**
 * A deleted repository stays on somebody's list until the page stops showing it.
 *
 * The rule is one-sided on purpose: only a definite "not found" hides a project.
 * Anything else — a refusal, a slow answer, nobody who can ask — leaves it where
 * it is, because hiding a project that exists is worse than showing one that
 * does not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { liveProjects } from './live-projects.js';
import { kvGet, kvSet, keys, __resetMemory } from './kv.js';
import { repoExistence } from '../adapters/github.js';

const SLUGS = ['acme/alive', 'acme/deleted'];
const answers = (map) => vi.fn(async (token, owner, repo) => {
  const said = map[`${owner}/${repo}`] ?? 'exists';
  return typeof said === 'string' ? { state: said, ...(said === 'exists' ? { fullName: `${owner}/${repo}` } : {}) } : said;
});

beforeEach(() => __resetMemory());

describe('which projects stay on the list', () => {
  it('leaves off one GitHub says is gone, and keeps the rest in order', async () => {
    const check = answers({ 'acme/deleted': 'gone' });
    expect(await liveProjects(['acme/b', ...SLUGS], { viewer: 'a@b.test', userToken: 't', check })).toEqual(['acme/b', 'acme/alive']);
  });

  it('keeps a project when it could not be asked about: no token, no lent access', async () => {
    const check = answers({ 'acme/deleted': 'gone' });
    expect(await liveProjects(SLUGS, { viewer: 'a@b.test', userToken: null, check })).toEqual(SLUGS);
    expect(check).not.toHaveBeenCalled();
  });

  it.each(['unknown'])('keeps a project when the answer is %s (rate limit, revoked token, outage)', async (state) => {
    expect(await liveProjects(SLUGS, { viewer: 'a@b.test', userToken: 't', check: answers({ 'acme/deleted': state }) })).toEqual(SLUGS);
  });

  it('keeps a project when the check itself throws', async () => {
    const check = vi.fn(async () => { throw new Error('boom'); });
    expect(await liveProjects(SLUGS, { viewer: 'a@b.test', userToken: 't', check })).toEqual(SLUGS);
  });

  it('keeps a project that is slow to answer, rather than holding the page', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(() => new Promise(() => {}));
      const pending = liveProjects(['acme/slow'], { viewer: 'a@b.test', userToken: 't', check });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual(['acme/slow']);
    } finally { vi.useRealTimers(); }
  });

  it('hides a project only if every token that could ask got a not-found', async () => {
    // The person's own token cannot see a private repository, but the project's
    // lent one can: so it exists.
    const check = vi.fn(async (token) => ({ state: token === 'lent' ? 'exists' : 'gone' }));
    const lentToken = async () => 'lent';
    expect(await liveProjects(['acme/private'], { viewer: 'a@b.test', userToken: 'mine', lentToken, check })).toEqual(['acme/private']);
    __resetMemory();
    const bothGone = vi.fn(async () => ({ state: 'gone' }));
    expect(await liveProjects(['acme/private'], { viewer: 'a@b.test', userToken: 'mine', lentToken, check: bothGone })).toEqual([]);
  });

  it('keeps a project when one token says gone and the other could not tell', async () => {
    const check = vi.fn(async (token) => ({ state: token === 'mine' ? 'gone' : 'unknown' }));
    expect(await liveProjects(['acme/x'], { viewer: 'a@b.test', userToken: 'mine', lentToken: async () => 'lent', check })).toEqual(['acme/x']);
  });

  it('asks with the project\'s lent token when the person has none of their own', async () => {
    const check = vi.fn(async () => ({ state: 'gone' }));
    expect(await liveProjects(['acme/x'], { viewer: 'a@b.test', userToken: null, lentToken: async () => 'lent', check })).toEqual([]);
    expect(check).toHaveBeenCalledWith('lent', 'acme', 'x');
  });

  it('is fine with an empty list and a malformed entry', async () => {
    expect(await liveProjects([], { viewer: 'a@b.test', userToken: 't', check: answers({}) })).toEqual([]);
    expect(await liveProjects(['not-a-slug'], { viewer: 'a@b.test', userToken: 't', check: answers({}) })).toEqual(['not-a-slug']);
  });
});

describe('a repository that has moved', () => {
  const moved = { state: 'exists', fullName: 'StatsLateral/teamctx' };

  it('is shown under the name GitHub has for it now', async () => {
    const check = answers({ 'oldorg/teamctx': moved });
    expect(await liveProjects(['oldorg/teamctx'], { viewer: 'a@b.test', userToken: 't', check })).toEqual(['StatsLateral/teamctx']);
  });

  it('is listed once when the old and the current name are both on the list', async () => {
    const check = answers({ 'oldorg/teamctx': moved });
    expect(await liveProjects(['oldorg/teamctx', 'StatsLateral/teamctx', 'acme/other'], { viewer: 'a@b.test', userToken: 't', check }))
      .toEqual(['StatsLateral/teamctx', 'acme/other']);
  });

  it('is not renamed for a difference of capitals alone', async () => {
    const check = answers({ 'acme/ledger': { state: 'exists', fullName: 'Acme/Ledger' } });
    expect(await liveProjects(['acme/ledger'], { viewer: 'a@b.test', userToken: 't', check })).toEqual(['acme/ledger']);
  });

  it('keeps the name it was given when GitHub does not say what it is called', async () => {
    const check = answers({ 'acme/ledger': { state: 'exists', fullName: null } });
    expect(await liveProjects(['acme/ledger'], { viewer: 'a@b.test', userToken: 't', check })).toEqual(['acme/ledger']);
  });

  it('is remembered with its new name, so the next visit does not ask again', async () => {
    const check = answers({ 'oldorg/teamctx': moved });
    await liveProjects(['oldorg/teamctx'], { viewer: 'a@b.test', userToken: 't', check });
    expect(await liveProjects(['oldorg/teamctx'], { viewer: 'a@b.test', userToken: 't', check })).toEqual(['StatsLateral/teamctx']);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('what one person is told never reaches another', () => {
  // A private repository answers 404 to somebody it will not show it to, so the
  // same project is "gone" to one person and fine to their colleague.
  const seesOnlyTheirs = (who) => vi.fn(async (token) => (token === who ? { state: 'exists', fullName: 'acme/secret-renamed' } : { state: 'gone' }));

  it('keeps one person\'s "gone" from hiding the project from somebody who can see it', async () => {
    const check = seesOnlyTheirs('insider');
    expect(await liveProjects(['acme/secret'], { viewer: 'out@b.test', userToken: 'outsider', check })).toEqual([]);
    expect(await liveProjects(['acme/secret'], { viewer: 'in@b.test', userToken: 'insider', check })).toEqual(['acme/secret-renamed']);
  });

  it('keeps the current name one person could see from reaching somebody who could not', async () => {
    const check = seesOnlyTheirs('insider');
    await liveProjects(['acme/secret'], { viewer: 'in@b.test', userToken: 'insider', check });
    expect(await liveProjects(['acme/secret'], { viewer: 'out@b.test', userToken: 'outsider', check })).toEqual([]);
  });

  it('keeps its memory under the person who asked, never under the project alone', async () => {
    await liveProjects(['acme/secret'], { viewer: 'in@b.test', userToken: 'insider', check: seesOnlyTheirs('insider') });
    expect(await kvGet(keys.repoState('in@b.test', 'acme', 'secret'))).toMatchObject({ state: 'exists' });
    expect(await kvGet(keys.repoState('out@b.test', 'acme', 'secret'))).toBeNull();
  });

  it('remembers nothing when it does not know who is asking', async () => {
    const check = answers({ 'acme/deleted': 'gone' });
    await liveProjects(['acme/deleted'], { userToken: 't', check });
    await liveProjects(['acme/deleted'], { userToken: 't', check });
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('what is remembered', () => {
  it('asks GitHub once for a project, then answers from memory', async () => {
    const check = answers({ 'acme/deleted': 'gone' });
    await liveProjects(SLUGS, { viewer: 'a@b.test', userToken: 't', check });
    await liveProjects(SLUGS, { viewer: 'a@b.test', userToken: 't', check });
    // Two projects, asked once each.
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does not remember an answer it could not get', async () => {
    const check = answers({ 'acme/deleted': 'unknown' });
    await liveProjects(['acme/deleted'], { viewer: 'a@b.test', userToken: 't', check });
    await liveProjects(['acme/deleted'], { viewer: 'a@b.test', userToken: 't', check });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('remembers for a short while only, so a repository that comes back comes back', async () => {
    await liveProjects(['acme/deleted'], { viewer: 'a@b.test', userToken: 't', check: answers({ 'acme/deleted': 'gone' }) });
    expect(await kvGet(keys.repoState('a@b.test', 'acme', 'deleted'))).toEqual({ state: 'gone' });
    // Once the memory lapses, the next visit asks again and the entry is back.
    __resetMemory();
    expect(await liveProjects(['acme/deleted'], { viewer: 'a@b.test', userToken: 't', check: answers({}) })).toEqual(['acme/deleted']);
  });

  it('takes nothing off the stored list: hiding is only for the page', async () => {
    await kvSet(keys.connectedProjects('a@b.test'), { projects: SLUGS });
    await liveProjects(SLUGS, { viewer: 'a@b.test', userToken: 't', check: answers({ 'acme/deleted': 'gone' }) });
    expect((await kvGet(keys.connectedProjects('a@b.test'))).projects).toEqual(SLUGS);
  });
});

describe('asking GitHub', () => {
  const reply = (status, body = { full_name: 'acme/ledger' }) => vi.fn(async () => ({ status, json: async () => body }));

  it('calls the repository endpoint with the token, once', async () => {
    const fetchImpl = reply(200);
    expect(await repoExistence('tok', 'acme', 'ledger', { fetchImpl })).toEqual({ state: 'exists', fullName: 'acme/ledger' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/ledger');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  it('says gone only for a 404', async () => {
    expect(await repoExistence('t', 'a', 'b', { fetchImpl: reply(404) })).toEqual({ state: 'gone' });
  });

  it.each([401, 403, 429, 500, 502, 503])('says unknown for a %s, which is not an answer about the repository', async (status) => {
    expect(await repoExistence('t', 'a', 'b', { fetchImpl: reply(status) })).toEqual({ state: 'unknown' });
  });

  it('says unknown when the request fails', async () => {
    expect(await repoExistence('t', 'a', 'b', { fetchImpl: async () => { throw new Error('offline'); } })).toEqual({ state: 'unknown' });
  });

  it('reports the current name when a rename was followed to its new home', async () => {
    const fetchImpl = reply(200, { full_name: 'StatsLateral/teamctx' });
    expect(await repoExistence('t', 'oldorg', 'teamctx', { fetchImpl })).toEqual({ state: 'exists', fullName: 'StatsLateral/teamctx' });
  });

  it('still says it exists when the body cannot be read', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => { throw new Error('bad json'); } }));
    expect(await repoExistence('t', 'a', 'b', { fetchImpl })).toEqual({ state: 'exists', fullName: null });
  });

  it('encodes the owner and repo it is given', async () => {
    const fetchImpl = reply(200);
    await repoExistence('t', 'a b', 'c/d', { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/a%20b/c%2Fd');
  });
});
