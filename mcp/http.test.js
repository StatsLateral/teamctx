/**
 * A connector has to be able to connect and list the tools even when the person's
 * GitHub access is the thing that is wrong.
 *
 * Reading the project is the one step that depends on GitHub, and every request
 * used to do it first. A refusal from GitHub (an organization that restricts
 * third-party apps, SAML single sign-on, a revoked token) then came back as a bare
 * 500 to `initialize` and `tools/list` too, which a client reads as a server with
 * no tools and no reason. Run over real HTTP, so the transport is the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

const github = vi.hoisted(() => ({ prefetch: async () => {}, calls: 0 }));
vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  GithubSession: class {
    constructor(opts) { Object.assign(this, opts, { files: new Map() }); }

    async prefetch() { github.calls++; await github.prefetch(); }

    read() { return null; }

    write() {}

    del() {}

    listDir() { return []; }

    async commit() { return { committed: false }; }
  },
}));

const { handleMcpHttp, explainGithubFailure } = await import('./http.js');

let server, url;
const start = (context = {}) => new Promise(resolve => {
  server = http.createServer((req, res) => handleMcpHttp(req, res, { owner: 'acme', repo: 'ledger', ghToken: 'secret-token', ...context })
    .catch(e => { res.statusCode = 500; res.end(`threw: ${e.message}`); })).listen(0, () => {
    url = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
});
afterEach(() => server?.close());
beforeEach(() => { github.calls = 0; github.prefetch = async () => {}; });

const post = async (body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.match(/data: (.*)/)?.[1] ?? text;
  let parsed = null;
  try { parsed = JSON.parse(data); } catch { /* not JSON */ }
  return { status: res.status, type: res.headers.get('content-type'), text, json: parsed };
};
const refuse = (status, message = 'Resource protected by organization SAML enforcement') => {
  github.prefetch = async () => { throw new Error(`github GET https://api.github.com/repos/acme/ledger → ${status}: {"message":"${message}"}`); };
};
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const CALL = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } };

describe('connecting when GitHub refuses the signed-in account', () => {
  beforeEach(async () => { refuse(403); await start(); });

  it('still answers initialize, and says what the server can do', async () => {
    const r = await post(INIT);
    expect(r.status).toBe(200);
    expect(r.json.result.capabilities).toEqual({ tools: {} });
    expect(r.json.result.serverInfo.name).toBe('teamctx');
    expect(r.json.result.instructions).toBeTruthy();
  });

  it('still lists every tool', async () => {
    const r = await post(LIST);
    expect(r.status).toBe(200);
    expect(r.json.result.tools.length).toBeGreaterThan(40);
    expect(r.json.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(['contribute', 'my_brief', 'task_add']));
  });

  it('accepts the initialized notification and a ping', async () => {
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await post({ jsonrpc: '2.0', id: 4, method: 'ping' })).status).toBe(200);
  });

  it('asks GitHub for nothing while it does', async () => {
    await post(INIT); await post(LIST); await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(github.calls).toBe(0);
  });

  it('says why when a tool is called, as a tool error rather than a failed server', async () => {
    const r = await post(CALL);
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/application\/json/);
    expect(r.json.id).toBe(3);
    expect(r.json.result.isError).toBe(true);
    const text = r.json.result.content[0].text;
    expect(text).toContain('acme/ledger');
    expect(text).toMatch(/third-party apps|SAML/);
    expect(text).toMatch(/connect again/);
  });

  it('never puts the token in anything it says', async () => {
    const r = await post(CALL);
    expect(r.text).not.toContain('secret-token');
  });

  it('answers each message in a batch for what it is', async () => {
    const r = await post([INIT, CALL, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(r.status).toBe(200);
    expect(r.json).toHaveLength(2);
    expect(r.json.find(m => m.id === 3).result.isError).toBe(true);
    expect(r.json.find(m => m.id === 1).error.code).toBe(-32603);
  });
});

describe('reading the project for a tool call', () => {
  beforeEach(() => start());

  it('asks GitHub once, before the tool runs', async () => {
    await post(CALL);
    expect(github.calls).toBe(1);
  });

  it('is not asked of a call that only lists', async () => {
    await post(LIST);
    expect(github.calls).toBe(0);
  });
});

describe('an agent', () => {
  it('is listed its own, smaller set of tools, and still without reading the project', async () => {
    refuse(403);
    await start({ agent: { id: 'a1', name: 'Nightly' } });
    const r = await post(LIST);
    expect(r.json.result.tools.map(t => t.name).sort()).toEqual(['contribute', 'my_brief', 'task_done']);
    expect(github.calls).toBe(0);
  });
});

describe('the reason given for each way GitHub can say no', () => {
  const ctx = { owner: 'acme', repo: 'ledger' };
  const fail = (status, body = '{"message":"x"}') => new Error(`github GET https://api.github.com/repos/acme/ledger → ${status}: ${body}`);

  it('401: the sign-in has expired', () => {
    expect(explainGithubFailure(fail(401), ctx)).toMatch(/expired or been revoked.*Disconnect and connect/);
  });

  it('403: an organization that restricts apps or needs SSO', () => {
    expect(explainGithubFailure(fail(403), ctx)).toMatch(/organization.*third-party apps.*SAML.*approve the teamctx OAuth app/s);
  });

  it('404: not found, or a private repository the account cannot see', () => {
    expect(explainGithubFailure(fail(404), ctx)).toMatch(/not found.*private repository.*no access/s);
  });

  it('anything else: says so plainly, with GitHub\'s own short message', () => {
    const text = explainGithubFailure(fail(502, '{"message":"Bad gateway"}'), ctx);
    expect(text).toContain('(502): Bad gateway');
    expect(text).toContain('acme/ledger');
  });

  it('a failure with no status at all still gives something to act on', () => {
    expect(explainGithubFailure(new Error('fetch failed'), ctx)).toMatch(/could not read acme\/ledger.*connect this server again/s);
  });
});

describe('a GitHub sign-in that has been rejected, when the caller can be sent to sign in again', () => {
  const again = (res) => {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
    res.end('{"error":"unauthorized"}');
  };

  it('answers a tool call with the 401 that makes a client sign in again, not a tool error', async () => {
    refuse(401);
    await start({ signInAgain: again });
    const r = await post(CALL);
    expect(r.status).toBe(401);
  });

  it('leaves every other kind of GitHub refusal as the explanation it was', async () => {
    refuse(403);
    await start({ signInAgain: () => { throw new Error('must not be called for a 403'); } });
    const r = await post(CALL);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toMatch(/organization|SAML|third-party/);
  });

  it('does nothing for a request that never reads the project', async () => {
    refuse(401);
    await start({ signInAgain: () => { throw new Error('must not be called'); } });
    expect((await post(INIT)).status).toBe(200);
    expect((await post(LIST)).status).toBe(200);
  });

  it('still explains in words when there is nobody to send back to sign in', async () => {
    refuse(401);
    await start();
    const r = await post(CALL);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).toMatch(/expired or been revoked/);
  });
});

