import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, kvSet, keys } from './kv.js';
import { withSharedKey, primaryManagerKey } from '../../api/mcp/[owner]/[repo].js';
import { addProjectKey, readProjectKeys } from './ai-keys.js';

const OWNER = 'acme';
const REPO = 'ledger';

/** A project whose primary manager is Maya. */
const config = (over = {}) => ({ project: 'Ledger', managerKey: 'git:maya@example.com', ...over });

/** What a request that brought no key ends up running on. */
async function keyFor({ apiKey = null, aiProvider = null, owner = OWNER, repo = REPO, cfg = config() } = {}) {
  const r = await withSharedKey({ apiKey, aiProvider, owner, repo });
  if (r.apiKey) return { apiKey: r.apiKey, provider: r.aiProvider };
  const projectKeys = await readProjectKeys(owner, repo);
  return primaryManagerKey({ projectKeys, config: cfg });
}

beforeEach(() => __resetMemory());

describe('the key a request runs on when it brought none', () => {
  it('is the primary manager\'s project key', async () => {
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', provider: 'anthropic', apiKey: 'sk-maya' });
    expect((await keyFor()).apiKey).toBe('sk-maya');
  });

  it('is not somebody else\'s key just because they added one too', async () => {
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'priya@example.com', apiKey: 'sk-priya' });
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', apiKey: 'sk-maya' });
    expect((await keyFor()).apiKey).toBe('sk-maya');
  });

  it('follows the primary role when it moves', async () => {
    // Which is what makes a handoff a change of who is primary, rather than
    // moving a secret from one person to another.
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'priya@example.com', apiKey: 'sk-priya' });
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', apiKey: 'sk-maya' });
    const r = await keyFor({ cfg: config({ managerKey: 'git:priya@example.com', managerKeys: ['git:maya@example.com'] }) });
    expect(r.apiKey).toBe('sk-priya');
  });

  it('is nothing when the primary has added no key', async () => {
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'priya@example.com', apiKey: 'sk-priya' });
    expect(await keyFor()).toBe(null);
  });

  it('carries the provider of the key, not the one the repo config names', async () => {
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', provider: 'openai', apiKey: 'sk-maya' });
    expect((await keyFor({ cfg: config({ provider: 'anthropic' }) })).provider).toBe('openai');
  });

  it('never overrides a key the caller already brought', async () => {
    // Silent if it breaks: the tools still work, and the manager pays for
    // somebody who was paying for themselves.
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', apiKey: 'sk-maya' });
    const r = await withSharedKey({ apiKey: 'sk-mine', aiProvider: 'openai', owner: OWNER, repo: REPO });
    expect(r).toMatchObject({ apiKey: 'sk-mine', aiProvider: 'openai', resolve: null });
  });

  it('does not leak between projects', async () => {
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', apiKey: 'sk-maya' });
    expect(await keyFor({ repo: 'other' })).toBe(null);
  });

  it('matches when the settings form and the connector URL disagree on case', async () => {
    await addProjectKey({ owner: 'Acme', repo: 'Ledger', email: 'maya@example.com', apiKey: 'sk-maya' });
    expect((await keyFor({ owner: 'acme', repo: 'ledger' })).apiKey).toBe('sk-maya');
  });
});

describe('a project from before keys were stored by email', () => {
  const legacy = value => kvSet(keys.projectAiKey(OWNER, REPO), value);

  it('keeps running on its single shared key', async () => {
    await legacy({ provider: 'anthropic', apiKey: 'sk-old', sharedById: '7', sharedByLogin: 'maya' });
    expect((await keyFor()).apiKey).toBe('sk-old');
  });

  it('moves to the primary manager\'s key once they add one', async () => {
    await legacy({ provider: 'anthropic', apiKey: 'sk-old', sharedById: '7' });
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', apiKey: 'sk-maya' });
    expect((await keyFor()).apiKey).toBe('sk-maya');
  });

  it('matches the old record regardless of case too', async () => {
    await kvSet(keys.projectAiKey('Acme', 'Ledger'), { provider: 'anthropic', apiKey: 'sk-old' });
    expect((await keyFor({ owner: 'acme', repo: 'ledger' })).apiKey).toBe('sk-old');
  });
});

describe('a primary manager written the old way', () => {
  it('has no address to look a key up by, and falls back to the old record', async () => {
    await kvSet(keys.projectAiKey(OWNER, REPO), { provider: 'anthropic', apiKey: 'sk-old' });
    await addProjectKey({ owner: OWNER, repo: REPO, email: 'maya@example.com', apiKey: 'sk-maya' });
    expect((await keyFor({ cfg: config({ managerKey: 'github:7' }) })).apiKey).toBe('sk-old');
  });
});
