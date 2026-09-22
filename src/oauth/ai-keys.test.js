/**
 * AI keys on the hosted server, stored by verified email.
 *
 * The records these replace were keyed by GitHub id, so a person who saved a key
 * signed in with GitHub could not find it signed in with Google.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, kvGet, kvSet, keys } from './kv.js';
import {
  readPersonalKey, writePersonalKey, readProjectKeys, addProjectKey, removeProjectKey,
  projectsKeyedBy, pickProjectKey,
} from './ai-keys.js';

beforeEach(() => __resetMemory());

describe('a person\'s own key', () => {
  it('is found by the same address however they signed in', async () => {
    await writePersonalKey({ email: 'Maya@Example.com', githubId: '7', provider: 'anthropic', apiKey: 'sk-maya' });
    // Signed in with Google: an address, and no GitHub id at all.
    expect((await readPersonalKey({ email: 'maya@example.com' })).apiKey).toBe('sk-maya');
  });

  it('still finds a key saved under a GitHub id before this change', async () => {
    await kvSet(keys.aiKey('7'), { provider: 'anthropic', apiKey: 'sk-old' });
    expect((await readPersonalKey({ email: 'maya@example.com', githubId: '7' })).apiKey).toBe('sk-old');
  });

  it('prefers the address record over the old one', async () => {
    await kvSet(keys.aiKey('7'), { provider: 'anthropic', apiKey: 'sk-old' });
    await writePersonalKey({ email: 'maya@example.com', githubId: '7', apiKey: 'sk-new' });
    expect((await readPersonalKey({ email: 'maya@example.com', githubId: '7' })).apiKey).toBe('sk-new');
  });

  it('stays cleared when cleared from a sign-in that cannot reach the old record', async () => {
    // Saved while signed in with GitHub before keys were stored by address, then
    // cleared while signed in with Google — which has no GitHub id to clear the
    // old record by. The old record must not come back through the fallback.
    await kvSet(keys.aiKey('7'), { provider: 'anthropic', apiKey: 'sk-old' });
    await writePersonalKey({ email: 'maya@example.com', apiKey: null });
    expect(await readPersonalKey({ email: 'maya@example.com', githubId: '7' })).toBe(null);
  });

  it('can be saved again after being cleared', async () => {
    await writePersonalKey({ email: 'maya@example.com', apiKey: null });
    await writePersonalKey({ email: 'maya@example.com', apiKey: 'sk-new' });
    expect((await readPersonalKey({ email: 'maya@example.com' })).apiKey).toBe('sk-new');
  });

  it('clears the old record too, so a cleared key does not come back', async () => {
    await kvSet(keys.aiKey('7'), { provider: 'anthropic', apiKey: 'sk-old' });
    await writePersonalKey({ email: 'maya@example.com', githubId: '7', apiKey: null });
    expect(await readPersonalKey({ email: 'maya@example.com', githubId: '7' })).toBe(null);
  });

  it('refuses to store a key with no address to store it under', async () => {
    await expect(writePersonalKey({ githubId: '7', apiKey: 'sk' })).rejects.toThrow(/verified email/);
  });
});

describe('keys added to a project', () => {
  it('records the GitHub identity of whoever added it, when there is one', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk', githubId: 7, githubLogin: 'maya' });
    expect((await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'])
      .toMatchObject({ addedById: '7', addedByLogin: 'maya' });
  });

  it('keeps one per person, recording who added each', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk-maya' });
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com', provider: 'openai', apiKey: 'sk-priya' });
    const { byEmail } = await readProjectKeys('acme', 'ledger');
    expect(Object.keys(byEmail).sort()).toEqual(['maya@example.com', 'priya@example.com']);
    expect(byEmail['priya@example.com']).toMatchObject({ addedBy: 'priya@example.com', provider: 'openai' });
  });

  it('does not let one person\'s key displace another\'s', async () => {
    // The old single record let whoever shared first block everyone after.
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk-maya' });
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com', apiKey: 'sk-priya' });
    expect((await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'].apiKey).toBe('sk-maya');
  });

  it('replaces a person\'s own earlier key rather than adding a second', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk-1' });
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk-2' });
    expect((await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'].apiKey).toBe('sk-2');
  });

  it('removes only the key of the person asking', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk-maya' });
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com', apiKey: 'sk-priya' });
    expect(await removeProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com' })).toBe(true);
    expect(Object.keys((await readProjectKeys('acme', 'ledger')).byEmail)).toEqual(['maya@example.com']);
  });

  it('says nothing was removed when that person had no key there', async () => {
    expect(await removeProjectKey({ owner: 'acme', repo: 'ledger', email: 'dev@example.com' })).toBe(false);
  });

  it('lists the projects a person has added keys to, old records included', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk' });
    await kvSet(keys.sharedProjects('7'), { projects: ['acme/old'] });
    expect(await projectsKeyedBy({ email: 'maya@example.com', githubId: '7' })).toEqual(['acme/ledger', 'acme/old']);
  });

  it('drops a project from that list once the key is removed', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk' });
    await removeProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com' });
    expect(await kvGet(keys.keysAddedBy('maya@example.com'))).toEqual({ projects: [] });
  });
});

describe('picking the key a project runs on', () => {
  const projectKeys = {
    byEmail: {
      'maya@example.com': { apiKey: 'sk-maya', provider: 'anthropic', addedBy: 'maya@example.com' },
      'priya@example.com': { apiKey: 'sk-priya', provider: 'openai', addedBy: 'priya@example.com' },
    },
    legacy: { apiKey: 'sk-old', provider: 'anthropic' },
  };

  it('is the primary manager\'s', () => {
    expect(pickProjectKey({ projectKeys, primaryKey: 'git:priya@example.com' }))
      .toEqual({ apiKey: 'sk-priya', provider: 'openai', addedBy: 'priya@example.com' });
  });

  it('matches the primary regardless of case', () => {
    expect(pickProjectKey({ projectKeys, primaryKey: 'git:MAYA@example.com' }).apiKey).toBe('sk-maya');
  });

  it('falls back to the old single record when the primary has none', () => {
    expect(pickProjectKey({ projectKeys, primaryKey: 'git:dev@example.com' }).apiKey).toBe('sk-old');
  });

  it('is nothing when there is neither', () => {
    expect(pickProjectKey({ projectKeys: { byEmail: {}, legacy: null }, primaryKey: 'git:dev@example.com' })).toBe(null);
  });

  it('finds the key of a primary stored by GitHub id', () => {
    // The web flow writes a GitHub id when a session revealed no address, and
    // matching only by address meant that primary's own key was never used.
    const keysWithId = {
      byEmail: { 'maya@example.com': { apiKey: 'sk-maya', addedBy: 'maya@example.com', addedById: '7' } },
      legacy: { apiKey: 'sk-old' },
    };
    expect(pickProjectKey({ projectKeys: keysWithId, primaryKey: 'github:7' }).apiKey).toBe('sk-maya');
  });

  it('finds the key of a primary stored by login', () => {
    const keysWithLogin = {
      byEmail: { 'maya@example.com': { apiKey: 'sk-maya', addedBy: 'maya@example.com', addedByLogin: 'Maya' } },
      legacy: null,
    };
    expect(pickProjectKey({ projectKeys: keysWithLogin, primaryKey: '@maya' }).apiKey).toBe('sk-maya');
  });
});
