import { describe, it, expect } from 'vitest';
import { mcpUrl, shortMcpUrl } from './mcp-url.js';

const base = { origin: 'https://teamctx.vercel.app', owner: 'acme', repo: 'gtm' };

describe('the connector address', () => {
  it('is the base, /api/mcp, the owner and the repo', () => {
    expect(mcpUrl(base)).toBe('https://teamctx.vercel.app/api/mcp/acme/gtm');
  });

  it('encodes what needs encoding', () => {
    expect(mcpUrl({ origin: 'https://h.test', owner: 'a b', repo: 'c/d' })).toBe('https://h.test/api/mcp/a%20b/c%2Fd');
  });

  it('keeps a port and a path-free origin as given', () => {
    expect(mcpUrl({ origin: 'http://localhost:3000', owner: 'o', repo: 'r' })).toBe('http://localhost:3000/api/mcp/o/r');
  });
});

describe('the short form', () => {
  it('is the host and the project, with the middle dropped', () => {
    expect(shortMcpUrl(base)).toBe('teamctx.vercel.app/…/acme/gtm');
  });

  it('keeps the port, which is part of the host', () => {
    expect(shortMcpUrl({ origin: 'http://localhost:3000', owner: 'o', repo: 'r' })).toBe('localhost:3000/…/o/r');
  });
});
