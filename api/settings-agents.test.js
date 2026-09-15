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
const {
  createAgentToken, listAgents, verifyAgentToken, hashToken, readAgentKey, setAgentKey, markAgentKeyFailed,
} = await import('../src/oauth/agent-tokens.js');

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

/** What the providers' free model-list endpoints answer for a key. */
const provider = { status: 200, seen: [] };

function stubGithub(config = { project: 'Ledger', managerKey: 'git:maya@example.com' }) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/.test(url)) {
      provider.seen.push(url);
      return { ok: provider.status === 200, status: provider.status, json: async () => ({}) };
    }
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
  provider.status = 200;
  provider.seen = [];
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

describe("an agent's own key", () => {
  const create = form => as(MAYA_GOOGLE, '/settings/agents', {
    method: 'POST', form: { project: 'acme/ledger', agentName: 'Nightly report', ...form },
  });
  const idOf = async () => (await listAgents('acme', 'ledger'))[0].id;

  it('is optional when creating an agent', async () => {
    await lend();
    expect((await create({})).status).toBe(200);
    expect(await readAgentKey(await idOf())).toBe(null);
    expect(provider.seen).toEqual([]);
  });

  it('is checked with the provider and saved when given', async () => {
    await lend();
    await create({ agentProvider: 'openai', agentApiKey: 'sk-agent' });
    expect(provider.seen).toEqual(['https://api.openai.com/v1/models']);
    expect(await readAgentKey(await idOf())).toMatchObject({ provider: 'openai', apiKey: 'sk-agent', setBy: 'maya@example.com' });
  });

  it('refuses a key the provider rejects, and creates no agent', async () => {
    await lend();
    provider.status = 401;
    const r = await create({ agentApiKey: 'sk-bad' });
    expect(r.location).toMatch(/That key was not saved: anthropic rejected the key/);
    expect(addAgent).not.toHaveBeenCalled();
    expect(await listAgents('acme', 'ledger')).toEqual([]);
  });

  it('accepts a key when the provider cannot be reached to check it', async () => {
    await lend();
    provider.status = 503;
    expect((await create({ agentApiKey: 'sk-agent' })).status).toBe(200);
    expect(await readAgentKey(await idOf())).toMatchObject({ apiKey: 'sk-agent' });
  });

  it('never appears on the page', async () => {
    await lend();
    const created = await create({ agentApiKey: 'sk-agent-secret' });
    expect(created.body).not.toContain('sk-agent-secret');
    const { body } = await as(MAYA_GOOGLE, '/settings');
    expect(body).not.toContain('sk-agent-secret');
    expect(body).toContain('Runs on its own Anthropic key, set by maya@example.com');
  });

  it('shows which key an agent without one runs on', async () => {
    await lend();
    await create({});
    expect((await as(MAYA_GOOGLE, '/settings')).body).toContain('Runs on the project key.');
  });

  it('tells the manager when the provider rejected it', async () => {
    await lend();
    await create({ agentApiKey: 'sk-agent' });
    await markAgentKeyFailed(await idOf(), new Date('2026-09-15T06:00:00Z'));
    const { body } = await as(MAYA_GOOGLE, '/settings');
    expect(body).toMatch(/Anthropic rejected its own key on\s+2026-09-15, so it ran on the project key/);
  });
});

describe("changing an agent's key later", () => {
  const setKey = (user, form) => as(user, '/settings/agents/key', { method: 'POST', form: { project: 'acme/ledger', id: 'a1', ...form } });

  beforeEach(async () => {
    await lend();
    await createAgentToken({ owner: 'acme', repo: 'ledger', id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com' });
  });

  it('gives it one', async () => {
    expect((await setKey(MAYA_GOOGLE, { provider: 'gemini', apiKey: 'g-key' })).location).toBe('/settings?saved=1');
    expect(await readAgentKey('a1')).toMatchObject({ provider: 'gemini', apiKey: 'g-key' });
  });

  it('replaces one, clearing an earlier failure', async () => {
    await setAgentKey({ id: 'a1', apiKey: 'sk-old' });
    await markAgentKeyFailed('a1');
    await setKey(MAYA_GOOGLE, { apiKey: 'sk-new' });
    expect(await readAgentKey('a1')).toMatchObject({ apiKey: 'sk-new', failedAt: null });
  });

  it('puts it back on the project key', async () => {
    await setAgentKey({ id: 'a1', apiKey: 'sk-old' });
    await setKey(MAYA_GOOGLE, { clear: '1' });
    expect(await readAgentKey('a1')).toBe(null);
  });

  it('refuses a rejected key and keeps the one it had', async () => {
    await setAgentKey({ id: 'a1', apiKey: 'sk-old' });
    provider.status = 403;
    const r = await setKey(MAYA_GOOGLE, { apiKey: 'sk-bad' });
    expect(r.location).toMatch(/not saved/);
    expect(await readAgentKey('a1')).toMatchObject({ apiKey: 'sk-old' });
  });

  it('is refused for someone who is not a manager', async () => {
    const r = await setKey(SAM_GOOGLE, { apiKey: 'sk-sam' });
    expect(r.location).toMatch(/Only a manager/);
    expect(await readAgentKey('a1')).toBe(null);
  });

  it('is refused for an agent the project does not have', async () => {
    const r = await setKey(MAYA_GOOGLE, { id: 'nope', apiKey: 'sk' });
    expect(r.location).toMatch(/No such agent/);
    expect(await readAgentKey('nope')).toBe(null);
  });
});
