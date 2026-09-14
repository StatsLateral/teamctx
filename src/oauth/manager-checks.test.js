import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __resetMemory, kvSet, keys } from './kv.js';
import { addProjectKey } from './ai-keys.js';
import { verifyProviderKey, keyCheckFor, stepOutCheckFor } from './manager-checks.js';

const ok = () => vi.fn(async () => ({ ok: true, status: 200 }));
const status = code => vi.fn(async () => ({ ok: false, status: code }));

beforeEach(() => __resetMemory());

describe('checking a key with the provider', () => {
  it('asks Anthropic\'s list-models endpoint, which spends nothing', async () => {
    const fetchImpl = ok();
    expect(await verifyProviderKey({ provider: 'anthropic', apiKey: 'sk-a' }, fetchImpl)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(init).toMatchObject({ method: 'GET', headers: { 'x-api-key': 'sk-a' } });
  });

  it('asks OpenAI and Gemini the same way, with the key in a header', async () => {
    const openai = ok();
    await verifyProviderKey({ provider: 'openai', apiKey: 'sk-o' }, openai);
    expect(openai.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    expect(openai.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-o');

    const gemini = ok();
    await verifyProviderKey({ provider: 'gemini', apiKey: 'g-key' }, gemini);
    expect(gemini.mock.calls[0][0]).not.toContain('g-key');
    expect(gemini.mock.calls[0][1].headers['x-goog-api-key']).toBe('g-key');
  });

  it('calls a rejected key rejected', async () => {
    const r = await verifyProviderKey({ provider: 'anthropic', apiKey: 'bad' }, status(401));
    expect(r).toMatchObject({ ok: false });
    expect(r.why).toMatch(/rejected the key \(401\)/);
    expect(r.transient).toBeUndefined();
  });

  it('does not call a working key broken because the provider could not be reached', async () => {
    const r = await verifyProviderKey({ provider: 'anthropic', apiKey: 'sk' }, vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(r).toMatchObject({ ok: false, transient: true });
    expect(r.why).toMatch(/Try again/);
  });

  it('treats a server error as worth retrying, not as a bad key', async () => {
    expect(await verifyProviderKey({ provider: 'openai', apiKey: 'sk' }, status(503))).toMatchObject({ ok: false, transient: true });
  });

  it('refuses an unknown provider rather than guessing', async () => {
    expect((await verifyProviderKey({ provider: 'mystery', apiKey: 'sk' }, ok())).ok).toBe(false);
  });
});

describe('the key check before somebody becomes a manager', () => {
  it('passes a key they added, and says which provider checked it', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com', provider: 'openai', apiKey: 'sk-p' });
    const r = await keyCheckFor({ owner: 'acme', repo: 'ledger' }, ok())({ email: 'priya@example.com' });
    expect(r).toEqual({ ok: true, note: 'key verified with openai' });
  });

  it('refuses somebody who has added no key, and says how to add one', async () => {
    const r = await keyCheckFor({ owner: 'acme', repo: 'ledger' }, ok())({ email: 'priya@example.com' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/priya@example\.com has not added a key to acme\/ledger/);
    expect(r.why).toMatch(/settings page as priya@example\.com/);
  });

  it('does not count a key somebody else added', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk-m' });
    expect((await keyCheckFor({ owner: 'acme', repo: 'ledger' }, ok())({ email: 'priya@example.com' })).ok).toBe(false);
  });

  it('does not count the project\'s old single shared key, which is nobody\'s by address', async () => {
    await kvSet(keys.projectAiKey('acme', 'ledger'), { provider: 'anthropic', apiKey: 'sk-old' });
    expect((await keyCheckFor({ owner: 'acme', repo: 'ledger' }, ok())({ email: 'priya@example.com' })).ok).toBe(false);
  });

  it('refuses a key the provider rejects', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com', apiKey: 'sk-bad' });
    const r = await keyCheckFor({ owner: 'acme', repo: 'ledger' }, status(401))({ email: 'priya@example.com' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/did not pass a check/);
  });

  it('finds the key regardless of how the address was capitalised', async () => {
    await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'priya@example.com', apiKey: 'sk-p' });
    expect((await keyCheckFor({ owner: 'acme', repo: 'ledger' }, ok())({ email: 'Priya@Example.com' })).ok).toBe(true);
  });
});

describe('the step-out check', () => {
  const lend = value => kvSet(keys.projectGhCred('acme', 'ledger'), value);

  it('lets somebody leave a project that lends no access', async () => {
    expect(await stepOutCheckFor({ owner: 'acme', repo: 'ledger' })({ email: 'maya@example.com' })).toEqual({ ok: true });
  });

  it('refuses while the lent access is theirs, and says what to do', async () => {
    await lend({ token: 't', lentById: '7', lentByLogin: 'maya', lentByEmail: 'maya@example.com' });
    const r = await stepOutCheckFor({ owner: 'acme', repo: 'ledger' })({ email: 'Maya@Example.com' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/still lent by maya@example\.com/);
    expect(r.why).toMatch(/lend access from the settings page first/);
  });

  it('lets them leave once somebody else lends it', async () => {
    await lend({ token: 't', lentById: '9', lentByLogin: 'priya', lentByEmail: 'priya@example.com' });
    expect((await stepOutCheckFor({ owner: 'acme', repo: 'ledger' })({ email: 'maya@example.com' })).ok).toBe(true);
  });

  it('refuses when an old record cannot say who lent it, rather than assuming', async () => {
    // Assuming it belonged to someone else, and being wrong, strands every
    // member who signed in with Google at once.
    await lend({ token: 't', lentById: '7', lentByLogin: 'maya' });
    const r = await stepOutCheckFor({ owner: 'acme', repo: 'ledger' })({ email: 'priya@example.com' });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/lent before teamctx recorded who by/);
  });
});
