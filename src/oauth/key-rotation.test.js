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
import { __resetMemory, kvGet, keys } from './kv.js';
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
