import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, kvGet, kvSet, keys } from './kv.js';
import { withSharedKey } from '../../api/mcp/[owner]/[repo].js';

const OWNER = 'acme';
const REPO = 'ledger';

const share = (value) => kvSet(keys.projectAiKey(OWNER, REPO), value);

beforeEach(() => __resetMemory());

describe('a key shared with a project', () => {
  it('is used by someone who has no key of their own', async () => {
    // The ordinary case, not the edge one: most people on a project reach it
    // through an agent and never set a key up at all.
    await share({ provider: 'anthropic', apiKey: 'sk-shared' });
    const r = await withSharedKey({ apiKey: null, aiProvider: null, owner: OWNER, repo: REPO });
    expect(r.apiKey).toBe('sk-shared');
    expect(r.aiProvider).toBe('anthropic');
  });

  it('never overrides a key the caller already brought', async () => {
    // The bug this guards against is silent: the tools still work, the manager
    // just pays for a member who was paying for themselves.
    await share({ provider: 'anthropic', apiKey: 'sk-shared' });
    const r = await withSharedKey({ apiKey: 'sk-mine', aiProvider: 'openai', owner: OWNER, repo: REPO });
    expect(r.apiKey).toBe('sk-mine');
    expect(r.aiProvider).toBe('openai');
  });

  it('carries its own provider, not the one the repo config names', async () => {
    // Same trap the per-user key hit once: an OpenAI key handed to Anthropic.
    await share({ provider: 'openai', apiKey: 'sk-openai' });
    const r = await withSharedKey({ apiKey: null, aiProvider: null, owner: OWNER, repo: REPO });
    expect(r.aiProvider).toBe('openai');
  });

  it('does not leak between projects', async () => {
    await share({ provider: 'anthropic', apiKey: 'sk-shared' });
    const r = await withSharedKey({ apiKey: null, aiProvider: null, owner: OWNER, repo: 'other' });
    expect(r.apiKey).toBe(null);
  });

  it('leaves the caller with nothing when no one has shared one', async () => {
    const r = await withSharedKey({ apiKey: null, aiProvider: null, owner: OWNER, repo: REPO });
    expect(r.apiKey).toBe(null);
    expect(r.aiProvider).toBe(null);
  });

  it('is gone once it is unshared', async () => {
    await share({ provider: 'anthropic', apiKey: 'sk-shared' });
    await share(null);
    expect(await kvGet(keys.projectAiKey(OWNER, REPO))).toBe(null);
    const r = await withSharedKey({ apiKey: null, aiProvider: null, owner: OWNER, repo: REPO });
    expect(r.apiKey).toBe(null);
  });
});

describe('a project key found regardless of how the repo was typed', () => {
  it('matches when the form and the URL disagree on case', async () => {
    // Written from what the manager types on the settings page, read from
    // what is in the connector URL. GitHub calls those the same repository;
    // a string key does not, and the failure looked like nothing was saved.
    await kvSet(keys.projectAiKey('Acme', 'Ledger'), { provider: 'anthropic', apiKey: 'sk-shared' });
    const r = await withSharedKey({ apiKey: null, aiProvider: null, owner: 'acme', repo: 'ledger' });
    expect(r.apiKey).toBe('sk-shared');
  });

  it('still keeps different projects apart', async () => {
    await kvSet(keys.projectAiKey('Acme', 'Ledger'), { provider: 'anthropic', apiKey: 'sk-shared' });
    const r = await withSharedKey({ apiKey: null, aiProvider: null, owner: 'acme', repo: 'other' });
    expect(r.apiKey).toBe(null);
  });
});
