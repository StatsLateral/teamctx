/**
 * A failed connect to the MCP endpoint is diagnosable (#285): the error body a
 * client receives carries a request id, a matching line is logged with the
 * reason and no secret, and a healthy GET-405 probe logs nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: handler } = await import('./mcp/[owner]/[repo].js');
const { __resetMemory } = await import('../src/oauth/kv.js');

function res() {
  const out = { statusCode: 200, headers: {}, body: '' };
  return {
    out,
    get statusCode() { return out.statusCode; }, set statusCode(v) { out.statusCode = v; },
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
    end(b) { out.body = b ?? ''; },
  };
}

beforeEach(() => {
  __resetMemory();
  process.env.GITHUB_OAUTH_CLIENT_ID = 'id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'secret';
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
});
afterEach(() => vi.restoreAllMocks());

describe('a failed connect carries a request id the member can quote', () => {
  it('returns a request id in a 401 body and logs the reason without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = res();
    // A bearer that is not a real token: the credential is presented and refused.
    await handler({ method: 'POST', query: { owner: 'acme', repo: 'ledger' }, headers: { host: 'x.test', authorization: 'Bearer gho_not_a_real_token_value' } }, r);
    expect(r.out.statusCode).toBe(401);
    const body = JSON.parse(r.out.body);
    expect(body.request_id).toMatch(/^req_[0-9a-f]{10}$/);
    const line = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(line).toMatch(/connect: POST \/api\/mcp failed \(401/);
    expect(line).toContain(body.request_id);
    expect(line).not.toContain('gho_not_a_real_token_value');
  });

  it('returns a request id in a 400 for a malformed address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = res();
    await handler({ method: 'POST', query: {}, headers: { host: 'x.test' } }, r);
    expect(r.out.statusCode).toBe(400);
    const body = JSON.parse(r.out.body);
    expect(body.error).toBe('bad_url');
    expect(body.request_id).toMatch(/^req_[0-9a-f]{10}$/);
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/connect: POST \/api\/mcp failed \(400 bad_url\)/);
  });

  it('says nothing in the log for a healthy GET-405 probe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = res();
    await handler({ method: 'GET', query: { owner: 'acme', repo: 'ledger' }, headers: { host: 'x.test' } }, r);
    expect(r.out.statusCode).toBe(405);
    expect(warn.mock.calls.join('\n')).not.toMatch(/connect:/);
  });
});
