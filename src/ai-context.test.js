/**
 * A request's AI key, including one worked out on first use.
 *
 * The project key a keyless request falls back to depends on who the primary
 * manager is, and that is in the project's config — which is only in hand once
 * the request's session has loaded it. So the key is resolved lazily, inside
 * the session, rather than fetched again up front.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runWithAiKey, getRequestAiKey, getRequestAiProvider } from './ai-context.js';
import { runWithSession } from './session-context.js';
import { __resetMemory } from './oauth/kv.js';
import { addProjectKey } from './oauth/ai-keys.js';
import { withSharedKey } from '../api/mcp/[owner]/[repo].js';

function sessionWith(config) {
  const files = new Map([['.teamctx/config.json', { content: JSON.stringify(config), sha: 'a' }]]);
  return {
    owner: 'acme', repo: 'ledger',
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c), sha: null }),
    del: p => files.delete(p),
    listDir: () => [],
    commit: async () => ({ committed: true }),
  };
}

beforeEach(() => __resetMemory());

describe('a key the request brought', () => {
  it('is returned with its provider', async () => {
    await runWithAiKey('sk-mine', () => {
      expect(getRequestAiKey()).toBe('sk-mine');
      expect(getRequestAiProvider()).toBe('openai');
    }, 'openai');
  });

  it('wins over a resolver, which never runs', async () => {
    let ran = false;
    await runWithAiKey('sk-mine', () => {
      expect(getRequestAiKey()).toBe('sk-mine');
    }, null, () => { ran = true; return { apiKey: 'sk-other' }; });
    expect(ran).toBe(false);
  });
});

describe('a key resolved on first use', () => {
  it('runs the resolver once, however many times the key is read', async () => {
    let calls = 0;
    await runWithAiKey(null, () => {
      getRequestAiKey(); getRequestAiKey(); getRequestAiProvider();
    }, null, () => { calls += 1; return { apiKey: 'sk', provider: 'anthropic' }; });
    expect(calls).toBe(1);
  });

  it('leaves the caller with no key when the resolver throws', async () => {
    await runWithAiKey(null, () => {
      expect(getRequestAiKey()).toBe(null);
    }, null, () => { throw new Error('no config'); });
  });

  it('finds the primary manager\'s key from the config the session loaded', async () => {
    // The whole path a keyless hosted request takes, end to end: project keys
    // read up front, the primary read from the session's copy of config.json.
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', provider: 'openai', apiKey: 'sk-maya' });
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com', apiKey: 'sk-priya' });
    const { resolve } = await withSharedKey({ apiKey: null, aiProvider: null, owner: 'acme', repo: 'ledger' });

    const session = sessionWith({ project: 'Ledger', managerKey: 'git:maya@example.com', managerKeys: ['git:priya@example.com'] });
    await runWithSession(session, () => runWithAiKey(null, () => {
      expect(getRequestAiKey()).toBe('sk-maya');
      expect(getRequestAiProvider()).toBe('openai');
    }, null, resolve));
  });
});
