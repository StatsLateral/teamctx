/**
 * Replacing your key, everywhere it is being used.
 *
 * A key shared with a project is a copy, taken at the moment it was shared.
 * Replacing the original and leaving the copies behind means a project keeps
 * calling a model with a key its owner has retired — which reads as "it works
 * from my assistant but not from the website", because those two resolve
 * different records.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, kvGet, kvSet, keys } from './kv.js';
import { writePersonalKey, addProjectKey, readProjectKeys, readPersonalKey } from './ai-keys.js';

const ME = { email: 'maya@example.com', githubId: '7', githubLogin: 'maya' };

beforeEach(() => __resetMemory());

describe('replacing a personal key', () => {
  it('carries it into every project that key was shared with', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', ...ME, email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });
    await addProjectKey({ owner: 'acme', repo: 'atlas', ...ME, email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });

    const saved = await writePersonalKey({ ...ME, provider: 'anthropic', apiKey: 'sk-new' });

    expect((await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'].apiKey).toBe('sk-new');
    expect((await readProjectKeys('acme', 'atlas')).byEmail['maya@example.com'].apiKey).toBe('sk-new');
    expect(saved.alsoUpdated.sort()).toEqual(['acme/atlas', 'acme/ledger']);
  });

  it('says which projects it touched, so it is not done behind somebody back', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });
    const saved = await writePersonalKey({ ...ME, provider: 'anthropic', apiKey: 'sk-new' });
    expect(saved.alsoUpdated).toEqual(['acme/ledger']);
  });

  it('leaves somebody else key alone', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'dev@example.com', provider: 'anthropic', apiKey: 'sk-dev' });
    await writePersonalKey({ ...ME, provider: 'anthropic', apiKey: 'sk-new' });
    expect((await readProjectKeys('acme', 'ledger')).byEmail['dev@example.com'].apiKey).toBe('sk-dev');
  });

  it('keeps the project on its old key when nothing was shared', async () => {
    const saved = await writePersonalKey({ ...ME, provider: 'anthropic', apiKey: 'sk-new' });
    expect(saved.alsoUpdated).toEqual([]);
    expect((await readPersonalKey({ email: ME.email })).apiKey).toBe('sk-new');
  });

  it('carries the provider across with it', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });
    await writePersonalKey({ ...ME, provider: 'openai', apiKey: 'sk-openai' });
    const entry = (await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'];
    expect(entry).toMatchObject({ provider: 'openai', apiKey: 'sk-openai' });
  });

  it('keeps a key it carried over from the project old shared record as the fallback', async () => {
    const record = { keys: { 'maya@example.com': { apiKey: 'sk-old', provider: 'anthropic', addedBy: 'maya@example.com', fromLegacy: true } } };
    await kvGet(keys.projectAiKeys('acme', 'ledger'));
    const { kvSet } = await import('./kv.js');
    await kvSet(keys.projectAiKeys('acme', 'ledger'), record);
    await kvSet(keys.keysAddedBy('maya@example.com'), { projects: ['acme/ledger'] });
    await writePersonalKey({ ...ME, provider: 'anthropic', apiKey: 'sk-new' });
    const entry = (await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'];
    expect(entry).toMatchObject({ apiKey: 'sk-new', fromLegacy: true });
  });
});

/**
 * Clearing a key is not unsharing it.
 *
 * Taking a key out of a project has its own confirmation, because everybody
 * there without a key of their own loses the model the moment it goes. So
 * clearing does not reach into those projects — but saying nothing is how
 * somebody retires a key and goes on paying for it, so it names them.
 */
describe('clearing a personal key', () => {
  it('names the projects still running on the copy they shared', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', ...ME, email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });
    await addProjectKey({ owner: 'acme', repo: 'atlas', ...ME, email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });

    const cleared = await writePersonalKey({ ...ME, apiKey: null });

    expect(cleared.cleared).toBe(true);
    expect(cleared.stillShared).toEqual(['acme/atlas', 'acme/ledger']);
  });

  it('leaves those projects working, rather than cutting them off quietly', async () => {
    // The warning is the point, not a removal. `/settings/unshare` is where a
    // key leaves a project, and it stops to confirm first.
    await addProjectKey({ owner: 'acme', repo: 'ledger', ...ME, email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });
    await writePersonalKey({ ...ME, apiKey: null });
    expect((await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'].apiKey).toBe('sk-old');
  });

  it('still clears the personal key itself', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', ...ME, email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });
    await writePersonalKey({ ...ME, apiKey: null });
    expect(await readPersonalKey({ email: ME.email, githubId: ME.githubId })).toBe(null);
  });

  it('names nothing when the key was never shared', async () => {
    await writePersonalKey({ ...ME, provider: 'anthropic', apiKey: 'sk-mine' });
    const cleared = await writePersonalKey({ ...ME, apiKey: null });
    expect(cleared.stillShared).toEqual([]);
  });

  it('does not name a project whose entry was already removed elsewhere', async () => {
    // The index of what somebody has shared can outlive the entry it points at,
    // and a warning that sends them to unshare nothing is worse than none.
    await addProjectKey({ owner: 'acme', repo: 'ledger', ...ME, email: ME.email, provider: 'anthropic', apiKey: 'sk-old' });
    await kvSet(keys.projectAiKeys('acme', 'ledger'), { keys: {} });

    const cleared = await writePersonalKey({ ...ME, apiKey: null });
    expect(cleared.stillShared).toEqual([]);
  });
});
