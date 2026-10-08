/**
 * A connector whose GitHub sign-in GitHub has stopped accepting.
 *
 * It used to get an ordinary tool answer telling the person to disconnect and
 * connect again, which an assistant cannot do for them and a client never acts
 * on. The endpoint now answers 401 and forgets the access token, so the client
 * refreshes, is refused (the refresh checks GitHub too), and signs in again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const seen = vi.hoisted(() => ({ ctx: null }));
vi.mock('../mcp/http.js', () => ({
  handleMcpHttp: vi.fn(async (req, res, ctx) => {
    seen.ctx = ctx;
    if (ctx.signInAgain) { await ctx.signInAgain(res); return; }
    res.statusCode = 200; res.end('{}');
  }),
}));

const { default: handler } = await import('./mcp/[owner]/[repo].js');
const { __resetMemory, kvGet, kvSet, keys } = await import('../src/oauth/kv.js');

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
const CONFIG = { project: 'Ledger', managerKey: 'git:maya@example.com', members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com' }] };

async function call(token) {
  const out = { statusCode: 0, headers: {}, body: '' };
  const res = {
    get statusCode() { return out.statusCode; }, set statusCode(v) { out.statusCode = v; },
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
    end(b) { out.body = b ?? ''; },
  };
  await handler({ method: 'POST', query: { owner: 'acme', repo: 'ledger' }, headers: { host: 'x.test', authorization: `Bearer ${token}` } }, res);
  return out;
}

beforeEach(async () => {
  __resetMemory();
  seen.ctx = null;
  process.env.GITHUB_OAUTH_CLIENT_ID = 'id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'secret';
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: b64(CONFIG) }) })));
});

describe('the endpoint, when GitHub rejects the token it holds for the caller', () => {
  it('forgets the access token and answers 401 so the client signs in again', async () => {
    await kvSet(keys.token('tok'), { clientId: 'c', githubToken: 'gho_dead', githubUser: { id: 1, login: 'maya', email: 'maya@example.com' } });
    const r = await call('tok');
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/error="invalid_token"/);
    expect(r.headers['www-authenticate']).toMatch(/resource_metadata=/);
    expect(r.body).toMatch(/GitHub/);
    expect(await kvGet(keys.token('tok'))).toBeNull();
  });

  it('offers nothing of the kind to somebody signed in with Google, who has no GitHub token to lose', async () => {
    await kvSet(keys.token('g'), { clientId: 'c', googleUser: { email: 'priya@example.com', name: 'Priya' } });
    await call('g');
    expect(seen.ctx.signInAgain).toBeUndefined();
    expect(await kvGet(keys.token('g'))).not.toBeNull();
  });

  it('writes down how old the sign-in was, never the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await kvSet(keys.token('tok'), { clientId: 'c', githubToken: 'gho_secretvalue', githubSignedInAt: new Date(Date.now() - 125 * 60000).toISOString(), githubUser: { id: 1, login: 'maya' } });
    await call('tok');
    const said = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(said).toMatch(/GitHub rejected .*sign-in.*12\d minutes/s);
    expect(said).not.toContain('gho_secretvalue');
    warn.mockRestore();
  });
});
