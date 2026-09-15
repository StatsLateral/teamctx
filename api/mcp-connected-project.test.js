/**
 * Which projects a Google sign-in is remembered as being on.
 *
 * The settings page offers a Google sign-in the projects recorded against its
 * address. Recording one at sign-in let any Google account name any project and
 * have it listed as theirs; it is recorded here, once the roster confirms them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../mcp/http.js', () => ({
  handleMcpHttp: vi.fn(async (req, res) => { res.statusCode = 200; res.end('{}'); }),
}));

const { default: handler } = await import('./mcp/[owner]/[repo].js');
const { __resetMemory, kvGet, kvSet, keys } = await import('../src/oauth/kv.js');

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com' }],
};

async function connectAs(email) {
  await kvSet(keys.token('tok'), { clientId: 'c', googleUser: { email, name: 'Someone' } });
  const req = { method: 'POST', query: { owner: 'acme', repo: 'ledger' }, headers: { host: 'x.test', authorization: 'Bearer tok' } };
  const res = { statusCode: 0, setHeader() {}, end() {} };
  await handler(req, res);
  return res.statusCode;
}

beforeEach(async () => {
  __resetMemory();
  process.env.GITHUB_OAUTH_CLIENT_ID = 'id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'secret';
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ content: b64(CONFIG) }) })));
});

describe('a Google sign-in reaching a project', () => {
  it('is remembered on the project once the roster confirms them', async () => {
    expect(await connectAs('priya@example.com')).toBe(200);
    expect(await kvGet(keys.connectedProjects('priya@example.com'))).toEqual({ projects: ['acme/ledger'] });
  });

  it('is remembered for the manager, who is not on their own roster', async () => {
    await connectAs('maya@example.com');
    expect(await kvGet(keys.connectedProjects('maya@example.com'))).toEqual({ projects: ['acme/ledger'] });
  });

  it('is not remembered for somebody the roster does not name', async () => {
    expect(await connectAs('stranger@example.com')).toBe(401);
    expect(await kvGet(keys.connectedProjects('stranger@example.com'))).toBe(null);
  });
});
