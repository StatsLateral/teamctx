/**
 * Somebody who is sent the connector address and opens it in a browser.
 *
 * The address is for pasting into an assistant, which talks to it by POST. An
 * invitee who clicks it gets whatever a GET returns, and for a while that was a
 * line of JSON about the build. It now says what the address is and where the
 * project can be opened instead; a tool probing the endpoint still gets the JSON.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../mcp/http.js', () => ({
  handleMcpHttp: vi.fn(async (req, res) => { res.statusCode = 200; res.end('{}'); }),
}));

const { default: handler } = await import('./mcp/[owner]/[repo].js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8';
async function get(headers = {}, query = { owner: 'acme', repo: 'ledger' }) {
  const out = { statusCode: 0, headers: {}, body: '' };
  const res = {
    get statusCode() { return out.statusCode; }, set statusCode(v) { out.statusCode = v; },
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
    end(b) { out.body = b ?? ''; },
  };
  await handler({ method: 'GET', query, headers: { host: 'x.test', ...headers } }, res);
  return out;
}

beforeEach(() => {
  __resetMemory();
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
});

describe('opening the connector address in a browser', () => {
  it('shows a page that says what the address is, instead of JSON', async () => {
    const r = await get({ accept: BROWSER });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toMatch(/not a (web )?page/i);
    expect(r.body).toMatch(/custom connector/i);
    expect(r.body).not.toContain('method_not_allowed');
  });

  it('shows the address to paste, and a way to open the project in the browser', async () => {
    const { body } = await get({ accept: BROWSER });
    expect(body).toContain('https://x.test/api/mcp/acme/ledger');
    expect(body).toContain('href="https://x.test/project/acme/ledger"');
    for (const name of ['Claude', 'ChatGPT', 'Copilot']) expect(body).toContain(name);
  });

  it('escapes what the address names', async () => {
    const { body } = await get({ accept: BROWSER }, { owner: '"><script>alert(1)</script>', repo: 'r' });
    expect(body).not.toContain('<script>alert(1)</script>');
  });

  it('leaves the JSON build probe for anything that is not a browser', async () => {
    for (const accept of [undefined, '*/*', 'application/json']) {
      const r = await get(accept ? { accept } : {});
      expect(r.statusCode).toBe(405);
      expect(r.headers.allow).toBe('POST');
      expect(JSON.parse(r.body)).toMatchObject({ error: 'method_not_allowed', message: 'MCP endpoint accepts POST only' });
    }
  });
});
