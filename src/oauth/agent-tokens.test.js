import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, kvGet, keys } from './kv.js';
import {
  createAgentToken, verifyAgentToken, touchAgent, listAgents, revokeAgent,
  takeDailyContribution, projectsWithAgentsBy, hashToken, isAgentToken,
  AGENT_TOKEN_PREFIX, DAILY_CONTRIBUTION_LIMIT,
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

  it('records when it was last used, on the record and in the list', async () => {
    const { token } = await issue();
    await touchAgent(token, new Date('2026-09-15T08:00:00Z'));
    expect((await verifyAgentToken(token)).lastUsedAt).toBe('2026-09-15T08:00:00.000Z');
    expect((await listAgents('acme', 'ledger'))[0].lastUsedAt).toBe('2026-09-15T08:00:00.000Z');
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

  it('counts each agent separately', async () => {
    await takeDailyContribution({ id: 'a1', limit: 1, now: at });
    expect((await takeDailyContribution({ id: 'a2', limit: 1, now: at })).ok).toBe(true);
  });
});
