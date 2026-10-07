/**
 * What a connector client reads before it ever signs in.
 *
 * ChatGPT, Claude and other clients find the authorization server from the
 * protected-resource document and then read its metadata. A strict client
 * rejects the server if the two disagree about who the issuer is, so they are
 * checked against each other here rather than each on its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

let server, base;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const json = async (path, init) => (await fetch(`${base}${path}`, init)).json();
const MCP = '/api/mcp/acme/ledger';

describe('the authorization server metadata', () => {
  it('names the same issuer the protected resource points at, exactly', async () => {
    const resource = await json(`/.well-known/oauth-protected-resource${MCP}`);
    const metadata = await json('/.well-known/oauth-authorization-server');
    expect(resource.authorization_servers).toEqual(['https://team.example.app']);
    expect(metadata.issuer).toBe(resource.authorization_servers[0]);
  });

  it('has no trailing slash on the issuer', async () => {
    expect((await json('/.well-known/oauth-authorization-server')).issuer).not.toMatch(/\/$/);
  });

  it('still points every endpoint at this server', async () => {
    const m = await json('/.well-known/oauth-authorization-server');
    expect(m.authorization_endpoint).toBe('https://team.example.app/authorize');
    expect(m.token_endpoint).toBe('https://team.example.app/token');
    expect(m.registration_endpoint).toBe('https://team.example.app/register');
  });

  it('offers what a public connector client needs: PKCE S256, no client secret, and dynamic registration', async () => {
    const m = await json('/.well-known/oauth-authorization-server');
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
    expect(m.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
  });

  it('registers a client that redirects to ChatGPT', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).redirect_uris).toEqual(['https://chatgpt.com/connector_platform_oauth_redirect']);
  });
});

describe('a request with no credentials', () => {
  it('is told where to sign in, pointing at a protected-resource document that matches the URL', async () => {
    const { default: handler } = await import('./mcp/[owner]/[repo].js');
    const mcp = http.createServer((req, res) => { req.query = { owner: 'acme', repo: 'ledger' }; handler(req, res); }).listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${mcp.address().port}${MCP}`, {
        method: 'POST', headers: { 'content-type': 'application/json', host: 'team.example.app', 'x-forwarded-host': 'team.example.app', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(res.status).toBe(401);
      const header = res.headers.get('www-authenticate');
      expect(header).toContain('resource_metadata="https://team.example.app/.well-known/oauth-protected-resource/api/mcp/acme/ledger"');
      const resource = await json(`/.well-known/oauth-protected-resource${MCP}`);
      expect(resource.resource).toBe(`https://team.example.app${MCP}`);
    } finally { mcp.close(); }
  });
});
