/**
 * An agent's own key, and the project key it falls back to.
 *
 * The fallback exists so a job keeps running when the key a manager gave it
 * stops working. It must move only when the provider refused the key itself —
 * never for a rate limit or an outage — and only for a request that was given a
 * fallback, which a person's request never is.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getRequestAiKey, getRequestAiProvider } from './ai-context.js';

const complete = vi.fn();
vi.mock('./providers/index.js', () => ({
  getProvider: vi.fn(config => ({ id: config?.provider || 'anthropic', complete })),
  knownProviderIds: () => ['anthropic', 'openai', 'gemini'],
}));

const { callClaude } = await import('./ai.js');
const { runWithAiKey, keyWasRejected } = await import('./ai-context.js');

const rejected = (status, message = 'nope') => Object.assign(new Error(message), { status });
const projectKey = () => ({ apiKey: 'sk-project', provider: 'anthropic' });

/** Records the key each attempt ran with, failing the first `failures` times. */
function provider(failures) {
  const seen = [];
  complete.mockImplementation(async ({ model }) => {
    seen.push({ key: getRequestAiKey(), provider: getRequestAiProvider(), model });
    if (failures.length) throw failures.shift();
    return 'ok';
  });
  return seen;
}

beforeEach(() => { complete.mockReset(); });

describe('when the provider rejects an agent\'s own key', () => {
  it('retries once on the project key', async () => {
    const seen = provider([rejected(401)]);
    const out = await runWithAiKey('sk-agent', () => callClaude({ prompt: 'p', config: {} }), 'anthropic', null,
      { fallback: projectKey });
    expect(out).toBe('ok');
    expect(seen.map(s => s.key)).toEqual(['sk-agent', 'sk-project']);
  });

  it('follows the project key\'s provider and model', async () => {
    const seen = provider([rejected(401)]);
    await runWithAiKey('sk-agent', () => callClaude({ prompt: 'p', model: 'claude-sonnet-4-6', config: { provider: 'anthropic' } }),
      'openai', null, { fallback: projectKey });
    expect(seen[0]).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect(seen[1]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('says so, once', async () => {
    provider([rejected(403)]);
    const onFallback = vi.fn();
    await runWithAiKey('sk-agent', () => callClaude({ prompt: 'p', config: {} }), 'anthropic', null,
      { fallback: projectKey, onFallback });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('stays on the project key for the rest of the request', async () => {
    const seen = provider([rejected(401)]);
    await runWithAiKey('sk-agent', async () => {
      await callClaude({ prompt: 'a', config: {} });
      await callClaude({ prompt: 'b', config: {} });
    }, 'anthropic', null, { fallback: projectKey });
    expect(seen.map(s => s.key)).toEqual(['sk-agent', 'sk-project', 'sk-project']);
  });

  it('gives up when the project key is rejected too, rather than looping', async () => {
    provider([rejected(401), rejected(401, 'project key revoked')]);
    await expect(runWithAiKey('sk-agent', () => callClaude({ prompt: 'p', config: {} }), 'anthropic', null,
      { fallback: projectKey })).rejects.toThrow('project key revoked');
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('when it does not move', () => {
  it('does not move for a rate limit', async () => {
    provider([rejected(429, 'rate_limit_error: slow down')]);
    await expect(runWithAiKey('sk-agent', () => callClaude({ prompt: 'p', config: {} }), 'anthropic', null,
      { fallback: projectKey })).rejects.toThrow('slow down');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not move for an outage', async () => {
    provider([rejected(529, 'overloaded')]);
    await expect(runWithAiKey('sk-agent', () => callClaude({ prompt: 'p', config: {} }), 'anthropic', null,
      { fallback: projectKey })).rejects.toThrow('overloaded');
  });

  it('never moves a request that was given no fallback — a person\'s own key', async () => {
    provider([rejected(401)]);
    await expect(runWithAiKey('sk-person', () => callClaude({ prompt: 'p', config: {} }), 'anthropic'))
      .rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('what counts as a rejected key', () => {
  it.each([
    ['an authentication failure', rejected(401)],
    ['a permission failure', rejected(403)],
    ['OpenAI out of quota', Object.assign(new Error('You exceeded your current quota'), { status: 429, code: 'insufficient_quota' })],
    ['Anthropic out of credit', rejected(400, 'Your credit balance is too low to access the Anthropic API.')],
    ['Gemini with a bad key', rejected(400, 'API key not valid. Please pass a valid API key.')],
  ])('%s', (_, err) => expect(keyWasRejected(err)).toBe(true));

  it.each([
    ['a rate limit', rejected(429, 'rate_limit_error')],
    ['an outage', rejected(503, 'unavailable')],
    ['a bad request about the prompt', rejected(400, 'prompt is too long')],
    ['no status at all', new Error('socket hang up')],
  ])('not %s', (_, err) => expect(keyWasRejected(err)).toBe(false));
});
