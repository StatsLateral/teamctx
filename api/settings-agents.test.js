/**
 * Issuing and revoking agents on the settings page.
 *
 * The roster core is tested on its own (cli/commands/agent-roster.test.js); here
 * it is stubbed, and what is checked is the page: who may issue, what has to be
 * in place first, and that the token is shown once and kept nowhere readable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

vi.mock('../cli/commands/member.core.js', async (orig) => ({
  ...(await orig()),
  addAgent: vi.fn(async ({ id, name }) => ({ agent: { key: `agent:${id}`, name, kind: 'agent' } })),
  removeAgent: vi.fn(async ({ id }) => ({ agent: { key: `agent:${id}` } })),
}));
vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  GithubSession: class { async prefetch() {} },
  listPushableRepos: async () => [],
}));

const { kvGet, kvSet, keys, __resetMemory } = await import('../src/oauth/kv.js');
const { addAgent, removeAgent, MemberNotFoundError } = await import('../cli/commands/member.core.js');
const { createAgentToken, listAgents, verifyAgentToken, hashToken } = await import('../src/oauth/agent-tokens.js');

let server, base;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const MAYA_GOOGLE = { id: null, login: null, name: 'Maya', email: 'maya@example.com', token: null, source: 'google' };
const SAM_GOOGLE = { id: null, login: null, name: 'Sam', email: 'sam@example.com', token: null, source: 'google' };
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64');

function stubGithub(config = { project: 'Ledger', managerKey: 'git:maya@example.com' }) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('/contents/.teamctx/config.json')) {
      return { ok: true, status: 200, json: async () => ({ content: b64(config) }) };
    }
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ([]) };
    return real(u, o);
  };
  return () => { globalThis.fetch = real; };
}

async function as(user, path, { method = 'GET', form } = {}) {
  await kvSet(keys.session('s'), user);
  const res = await fetch(`${base}${path}`, {
    method, redirect: 'manual',
    headers: { cookie: 'teamctx_sid=s', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return {
    status: res.status, location: decodeURIComponent(res.headers.get('location') || ''),
    cache: res.headers.get('cache-control'), body: await res.text(),
  };
}

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

let restore;
beforeEach(async () => {
  __resetMemory();
  vi.clearAllMocks();
  restore?.();
  restore = stubGithub();
});
afterAll(() => restore?.());

describe('creating an agent', () => {
  it('shows the token once, in the page, not in a redirect', async () => {
    await lend();
    const r = await as(MAYA_GOOGLE, '/settings/agents', { method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report' } });
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    const token = /id="newAgentToken"[^>]*value="(tctx_agent_[^"]+)"/.exec(r.body)[1];
    expect(r.body).toContain('https://team.example.app/api/mcp/acme/ledger');
    expect(await verifyAgentToken(token, { owner: 'acme', repo: 'ledger' })).toMatchObject({ name: 'Nightly report' });
  });

  it('keeps the token nowhere it can be read back', async () => {
    await lend();
    const r = await as(MAYA_GOOGLE, '/settings/agents', { method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report' } });
    const token = /value="(tctx_agent_[^"]+)"/.exec(r.body)[1];
    const again = await as(MAYA_GOOGLE, '/settings');
    expect(again.body).not.toContain(token);
    expect(JSON.stringify(await kvGet(keys.projectAgents('acme', 'ledger')))).not.toContain(token);
    expect(await kvGet(keys.agentToken(hashToken(token)))).toBeTruthy();
  });

  it('puts the agent on the roster as the manager, with its workstreams', async () => {
    await lend();
    await as(MAYA_GOOGLE, '/settings/agents', {
      method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report', agentWorkstreams: 'pricing, onboarding' },
    });
    expect(addAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Nightly report', workstreams: ['pricing', 'onboarding'],
      actor: expect.objectContaining({ key: 'git:maya@example.com' }),
    }));
  });

  it('issues no token when the roster refuses', async () => {
    await lend();
    addAgent.mockRejectedValueOnce(new Error('"Sam" is already somebody on this project.'));
    const r = await as(MAYA_GOOGLE, '/settings/agents', { method: 'POST', form: { project: 'acme/ledger', agentName: 'Sam' } });
    expect(r.location).toMatch(/already somebody/);
    expect(await listAgents('acme', 'ledger')).toEqual([]);
  });

  it('is refused for someone who is not a manager', async () => {
    await lend();
    const r = await as(SAM_GOOGLE, '/settings/agents', { method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report' } });
    expect(r.location).toMatch(/Only a manager of acme\/ledger/);
    expect(addAgent).not.toHaveBeenCalled();
  });

  it('is refused on a project with no manager on record, where everyone would pass', async () => {
    restore(); restore = stubGithub({ project: 'Ledger' });
    await lend();
    const r = await as(SAM_GOOGLE, '/settings/agents', { method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report' } });
    expect(r.location).toMatch(/no manager on record/);
    expect(addAgent).not.toHaveBeenCalled();
  });

  it('is refused until the project lends GitHub access, which an agent reads through', async () => {
    const r = await as(MAYA_GOOGLE, '/settings/agents', { method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report' } });
    expect(r.location).toMatch(/does not lend GitHub access/);
    expect(addAgent).not.toHaveBeenCalled();
  });

  it('matches a GitHub sign-in to a manager written by GitHub id', async () => {
    restore(); restore = stubGithub({ project: 'Ledger', managerKey: 'github:7' });
    await lend();
    const r = await as({ id: '7', login: 'maya', name: 'Maya', email: 'maya@example.com', token: 'gho' },
      '/settings/agents', { method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report' } });
    expect(r.status).toBe(200);
  });
});

describe('the list and revoking', () => {
  it('lists a project\'s agents for a manager who issued one', async () => {
    await lend();
    await createAgentToken({ owner: 'acme', repo: 'ledger', id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com' });
    const { body } = await as(MAYA_GOOGLE, '/settings');
    expect(body).toContain('Nightly report');
    expect(body).toContain('never used');
  });

  it('revokes the token and takes the agent off the roster', async () => {
    await lend();
    const { token } = await createAgentToken({ owner: 'acme', repo: 'ledger', id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com' });
    const r = await as(MAYA_GOOGLE, '/settings/agents/revoke', { method: 'POST', form: { project: 'acme/ledger', id: 'a1' } });
    expect(r.location).toBe('/settings?saved=1');
    expect(await verifyAgentToken(token)).toBe(null);
    expect(removeAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
  });

  it('still revokes the token when the agent is already off the roster', async () => {
    await lend();
    const { token } = await createAgentToken({ owner: 'acme', repo: 'ledger', id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com' });
    removeAgent.mockRejectedValueOnce(new MemberNotFoundError('a1'));
    const r = await as(MAYA_GOOGLE, '/settings/agents/revoke', { method: 'POST', form: { project: 'acme/ledger', id: 'a1' } });
    expect(r.location).toBe('/settings?saved=1');
    expect(await verifyAgentToken(token)).toBe(null);
  });

  it('is refused for someone who is not a manager, and the token keeps working', async () => {
    await lend();
    const { token } = await createAgentToken({ owner: 'acme', repo: 'ledger', id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com' });
    const r = await as(SAM_GOOGLE, '/settings/agents/revoke', { method: 'POST', form: { project: 'acme/ledger', id: 'a1' } });
    expect(r.location).toMatch(/Only a manager/);
    expect(await verifyAgentToken(token)).toBeTruthy();
  });
});
