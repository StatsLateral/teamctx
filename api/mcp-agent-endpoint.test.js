/**
 * The hosted endpoint, handed an agent token.
 *
 * Everything past this point trusts what the endpoint decided: which GitHub
 * credential the request reads with, who it is, and whether it is an agent at
 * all. So those three are checked here, with the MCP layer stubbed out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const seen = vi.hoisted(() => ({ calls: [] }));

vi.mock('../mcp/http.js', async () => {
  const { resolveActor } = await import('../src/actor.js');
  const { getRequestAiKey } = await import('../src/ai-context.js');
  return {
    handleMcpHttp: vi.fn(async (req, res, ctx) => {
      seen.calls.push({ ctx, actor: await resolveActor({}), apiKey: getRequestAiKey() });
      res.statusCode = 200;
      res.end('{}');
    }),
  };
});
vi.mock('../src/storage.js', async (orig) => ({
  ...(await orig()),
  // The primary manager, read from the config the session loaded.
  readConfig: () => ({ project: 'Ledger', managerKey: 'git:maya@example.com' }),
}));

const { default: handler } = await import('./mcp/[owner]/[repo].js');
const { __resetMemory, kvSet, keys } = await import('../src/oauth/kv.js');
const { createAgentToken, revokeAgent, listAgents } = await import('../src/oauth/agent-tokens.js');
const { addProjectKey } = await import('../src/oauth/ai-keys.js');

function call({ token, owner = 'acme', repo = 'ledger', headers = {} } = {}) {
  const req = {
    method: 'POST',
    query: { owner, repo },
    headers: { host: 'x.test', authorization: `Bearer ${token}`, ...headers },
  };
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b || ''; },
  };
  return handler(req, res).then(() => res);
}

let token;
beforeEach(async () => {
  __resetMemory();
  seen.calls = [];
  ({ token } = await createAgentToken({ owner: 'acme', repo: 'ledger', id: 'a1', name: 'Nightly report', issuedBy: 'maya@example.com' }));
  await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });
  await addProjectKey({ owner: 'acme', repo: 'ledger', email: 'maya@example.com', apiKey: 'sk-maya' });
});

describe('a request with an agent token', () => {
  it('reads through the lent access, as the agent, marked as one', async () => {
    const res = await call({ token });
    expect(res.statusCode).toBe(200);
    const [{ ctx, actor }] = seen.calls;
    expect(ctx.ghToken).toBe('gh-lent');
    expect(ctx.agent).toEqual({ id: 'a1', name: 'Nightly report', dailyLimit: 20 });
    expect(actor).toMatchObject({ key: 'agent:a1', source: 'agent' });
  });

  it('runs on the primary manager\'s key', async () => {
    await call({ token });
    expect(seen.calls[0].apiKey).toBe('sk-maya');
  });

  it('ignores a GitHub token and an AI key sent as headers', async () => {
    await call({ token, headers: { 'x-github-token': 'gh-someone', 'x-api-key': 'sk-someone' } });
    expect(seen.calls[0].ctx.ghToken).toBe('gh-lent');
    expect(seen.calls[0].apiKey).toBe('sk-maya');
  });

  it('records when it was used', async () => {
    await call({ token });
    expect((await listAgents('acme', 'ledger'))[0].lastUsedAt).toMatch(/^\d{4}-/);
  });

  it('is refused for another project', async () => {
    const res = await call({ token, repo: 'payroll' });
    expect(res.statusCode).toBe(401);
    expect(seen.calls).toEqual([]);
  });

  it('is refused once revoked', async () => {
    await revokeAgent({ owner: 'acme', repo: 'ledger', id: 'a1' });
    const res = await call({ token });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error_description).toMatch(/revoked/);
  });

  it('is refused when the project no longer lends GitHub access, and says how to fix it', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), null);
    const res = await call({ token });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error_description).toMatch(/no longer lends GitHub access/);
  });

  it('never reaches the OAuth path, even with OAuth configured', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'id';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'secret';
    try {
      expect((await call({ token })).statusCode).toBe(200);
    } finally {
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
      delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    }
  });
});

describe('a request without an agent token', () => {
  it('carries no agent, so a person keeps the full tool list', async () => {
    // Header mode looks the person up on GitHub; nothing here should reach it.
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    try {
      const res = await call({ token: 'ignored', headers: { authorization: undefined, 'x-github-token': 'gh-person' } });
      expect(res.statusCode).toBe(200);
      expect(seen.calls[0].ctx).not.toHaveProperty('agent');
    } finally {
      globalThis.fetch = real;
    }
  });
});
