import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, kvGet, keys } from './kv.js';
import {
  createAgentToken, verifyAgentToken, touchAgent, listAgents, revokeAgent,
  takeDailyContribution, projectsWithAgentsBy, hashToken, isAgentToken,
  AGENT_TOKEN_PREFIX, DAILY_CONTRIBUTION_LIMIT,
  setAgentKey, clearAgentKey, readAgentKey, agentKeyStatus, markAgentKeyFailed,
} from './agent-tokens.js';

const issue = (over = {}) => createAgentToken({
  owner: 'acme', repo: 'ledger', id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com', ...over,
});

beforeEach(() => __resetMemory());

describe('issuing a token', () => {
  it('stores the hash, never the token', async () => {
    const { token } = await issue();
    expect(token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(await kvGet(keys.agentToken(hashToken(token)))).toMatchObject({ id: 'a1', name: 'Nightly report' });
    const stored = JSON.stringify(await kvGet(keys.projectAgents('acme', 'ledger')));
    expect(stored).not.toContain(token);
  });

  it('issues a different token every time', async () => {
    const a = await issue();
    const b = await issue({ id: 'a2' });
    expect(a.token).not.toBe(b.token);
  });

  it('lists the project for whoever issued it', async () => {
    await issue();
    await issue({ id: 'a2' });
    expect(await projectsWithAgentsBy('Maya@Example.com')).toEqual(['acme/ledger']);
  });

  it('refuses without a project, an agent or an issuer', async () => {
    await expect(issue({ owner: null })).rejects.toThrow(/project/);
    await expect(issue({ name: '' })).rejects.toThrow(/name/);
    await expect(issue({ issuedBy: null })).rejects.toThrow(/issued/);
  });
});

describe('checking a token', () => {
  it('finds the agent for its own project, whatever the case', async () => {
    const { token } = await issue();
    expect(await verifyAgentToken(token, { owner: 'Acme', repo: 'Ledger' })).toMatchObject({ id: 'a1' });
  });

  it('refuses it for another project', async () => {
    // A URL names one repository. A token that worked against any of them would
    // make the URL a formality.
    const { token } = await issue();
    expect(await verifyAgentToken(token, { owner: 'acme', repo: 'payroll' })).toBe(null);
  });

  it('refuses a token nobody issued', async () => {
    expect(await verifyAgentToken(`${AGENT_TOKEN_PREFIX}made-up`, { owner: 'acme', repo: 'ledger' })).toBe(null);
  });

  it('tells an agent token from anything else', () => {
    expect(isAgentToken(`${AGENT_TOKEN_PREFIX}x`)).toBe(true);
    expect(isAgentToken('an-oauth-token')).toBe(false);
    expect(isAgentToken(null)).toBe(false);
  });

  it('records when it was last used, for the list', async () => {
    await issue();
    await touchAgent('a1', new Date('2026-09-15T08:00:00Z'));
    expect((await listAgents('acme', 'ledger'))[0].lastUsedAt).toBe('2026-09-15T08:00:00.000Z');
  });

  it('cannot bring a revoked token back by noting a use', async () => {
    // A request that was already under way when the token was revoked.
    const { token } = await issue();
    await revokeAgent({ owner: 'acme', repo: 'ledger', id: 'a1' });
    await touchAgent('a1');
    expect(await verifyAgentToken(token)).toBe(null);
  });

  it('never drops an agent from the list by noting a use', async () => {
    await issue();
    await touchAgent('a1');
    await issue({ id: 'a2', name: 'Weekly digest' });
    await touchAgent('a1');
    expect((await listAgents('acme', 'ledger')).map(a => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('listing and revoking', () => {
  it('lists without the hashes', async () => {
    await issue();
    const [agent] = await listAgents('acme', 'ledger');
    expect(agent).toMatchObject({ id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com' });
    expect(agent).not.toHaveProperty('hash');
  });

  it('stops the token working as soon as it is revoked', async () => {
    const { token } = await issue();
    expect(await revokeAgent({ owner: 'acme', repo: 'ledger', id: 'a1' })).toMatchObject({ id: 'a1' });
    expect(await verifyAgentToken(token)).toBe(null);
    expect(await listAgents('acme', 'ledger')).toEqual([]);
  });

  it('revokes only the agent named', async () => {
    await issue();
    const { token } = await issue({ id: 'a2', name: 'Weekly digest' });
    await revokeAgent({ owner: 'acme', repo: 'ledger', id: 'a1' });
    expect(await verifyAgentToken(token)).toMatchObject({ id: 'a2' });
  });

  it('says so when there is no such agent', async () => {
    expect(await revokeAgent({ owner: 'acme', repo: 'ledger', id: 'nope' })).toBe(null);
  });
});

describe('the daily contribution limit', () => {
  const at = new Date('2026-09-15T23:30:00Z');

  it('allows the limit and refuses the one after', async () => {
    for (let i = 0; i < DAILY_CONTRIBUTION_LIMIT; i++) {
      expect((await takeDailyContribution({ id: 'a1', now: at })).ok).toBe(true);
    }
    const refused = await takeDailyContribution({ id: 'a1', now: at });
    expect(refused).toMatchObject({ ok: false, used: DAILY_CONTRIBUTION_LIMIT });
  });

  it('says when it resets: the next UTC midnight', async () => {
    expect((await takeDailyContribution({ id: 'a1', now: at })).resetsAt).toBe('2026-09-16T00:00:00.000Z');
  });

  it('starts again the next day', async () => {
    await takeDailyContribution({ id: 'a1', limit: 1, now: at });
    expect((await takeDailyContribution({ id: 'a1', limit: 1, now: at })).ok).toBe(false);
    expect((await takeDailyContribution({ id: 'a1', limit: 1, now: new Date('2026-09-16T00:01:00Z') })).ok).toBe(true);
  });

  it('holds when contributions arrive at the same time', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => takeDailyContribution({ id: 'a1', now: at })));
    expect(results.filter(r => r.ok)).toHaveLength(DAILY_CONTRIBUTION_LIMIT);
  });

  it('counts each agent separately', async () => {
    await takeDailyContribution({ id: 'a1', limit: 1, now: at });
    expect((await takeDailyContribution({ id: 'a2', limit: 1, now: at })).ok).toBe(true);
  });
});

describe('an agent\'s own key', () => {
  it('is optional: an agent starts with none', async () => {
    await issue();
    expect(await readAgentKey('a1')).toBe(null);
    expect(await agentKeyStatus('a1')).toBe(null);
  });

  it('is stored with its provider and who set it', async () => {
    await setAgentKey({ id: 'a1', provider: 'openai', apiKey: 'sk-agent', setBy: 'Maya@Example.com' });
    expect(await readAgentKey('a1')).toMatchObject({ provider: 'openai', apiKey: 'sk-agent', setBy: 'maya@example.com' });
  });

  it('is never part of what a manager is shown', async () => {
    await setAgentKey({ id: 'a1', apiKey: 'sk-agent', setBy: 'maya@example.com' });
    const status = await agentKeyStatus('a1');
    expect(status).toMatchObject({ provider: 'anthropic' });
    expect(JSON.stringify(status)).not.toContain('sk-agent');
    await issue();
    expect(JSON.stringify(await listAgents('acme', 'ledger'))).not.toContain('sk-agent');
  });

  it('records when the provider rejected it, and a new key clears that', async () => {
    await setAgentKey({ id: 'a1', apiKey: 'sk-old' });
    await markAgentKeyFailed('a1', new Date('2026-09-15T06:00:00Z'));
    expect((await agentKeyStatus('a1')).failedAt).toBe('2026-09-15T06:00:00.000Z');
    await setAgentKey({ id: 'a1', apiKey: 'sk-new' });
    expect((await agentKeyStatus('a1')).failedAt).toBe(null);
  });

  it('can be cleared, back to the project key', async () => {
    await setAgentKey({ id: 'a1', apiKey: 'sk-agent' });
    await clearAgentKey('a1');
    expect(await readAgentKey('a1')).toBe(null);
  });

  it('goes when the agent is revoked', async () => {
    await issue();
    await setAgentKey({ id: 'a1', apiKey: 'sk-agent' });
    await revokeAgent({ owner: 'acme', repo: 'ledger', id: 'a1' });
    expect(await readAgentKey('a1')).toBe(null);
  });

  it('refuses to store nothing', async () => {
    await expect(setAgentKey({ id: 'a1', apiKey: '' })).rejects.toThrow(/no key/);
  });
});
