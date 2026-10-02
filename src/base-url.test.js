/**
 * Whose word the deployment takes for its own address.
 *
 * `x-forwarded-host` used to be believed outright. That was a redirect away from
 * the sender until the view link started being built from it — a tool result now
 * carries this address to an assistant, which hands it to somebody as a link to
 * click. These tests are mostly about the hosts that must *not* get through.
 */
import { describe, it, expect } from 'vitest';
import { baseUrlFrom, configuredBases } from './base-url.js';

const req = (host, proto) => ({ host, proto });

describe('an address written down on purpose', () => {
  it('wins over anything the request says', () => {
    expect(baseUrlFrom(req('evil.test'), { TEAMCTX_BASE_URL: 'https://ctx.example' }))
      .toBe('https://ctx.example');
  });

  it('loses its trailing slashes, so links do not double up', () => {
    expect(baseUrlFrom(req('ctx.example'), { TEAMCTX_BASE_URL: 'https://ctx.example//' }))
      .toBe('https://ctx.example');
  });
});

describe('a host the deployment knows itself by', () => {
  const env = { VERCEL_PROJECT_PRODUCTION_URL: 'ctx.vercel.app', VERCEL_URL: 'ctx-abc123.vercel.app' };

  it('is used as given, so a preview links to itself', () => {
    expect(baseUrlFrom(req('ctx-abc123.vercel.app'), env)).toBe('https://ctx-abc123.vercel.app');
  });

  it('matches whatever case the header arrived in', () => {
    expect(baseUrlFrom(req('CTX.Vercel.App'), env)).toBe('https://CTX.Vercel.App');
  });

  it('keeps the protocol the proxy reports', () => {
    expect(baseUrlFrom(req('ctx.vercel.app', 'http'), env)).toBe('http://ctx.vercel.app');
  });

  it('assumes https when the proxy says nothing', () => {
    expect(baseUrlFrom(req('ctx.vercel.app', undefined), env)).toBe('https://ctx.vercel.app');
  });
});

describe('a host it does not', () => {
  const env = { VERCEL_PROJECT_PRODUCTION_URL: 'ctx.vercel.app', VERCEL_URL: 'ctx-abc123.vercel.app' };

  it('is refused, and the production address is used instead', () => {
    // The whole point: a spoofed `x-forwarded-host` must not end up in a link an
    // assistant presents to somebody as this project's page.
    expect(baseUrlFrom(req('evil.test'), env)).toBe('https://ctx.vercel.app');
  });

  it('is refused when it only looks like one, as a subdomain', () => {
    expect(baseUrlFrom(req('ctx.vercel.app.evil.test'), env)).toBe('https://ctx.vercel.app');
  });

  it('is refused when it only looks like one, as a prefix', () => {
    expect(baseUrlFrom(req('evil.test/ctx.vercel.app'), env)).toBe('https://ctx.vercel.app');
  });

  it('is refused on a different port, which is a different origin', () => {
    expect(baseUrlFrom(req('ctx.vercel.app:8443'), env)).toBe('https://ctx.vercel.app');
  });

  it('is refused even when the request carries no host at all', () => {
    expect(baseUrlFrom(req(undefined), env)).toBe('https://ctx.vercel.app');
  });
});

describe('with nothing configured', () => {
  it('takes the request at its word, because local dev has nothing else', () => {
    expect(baseUrlFrom(req('localhost:3000', 'http'), {})).toBe('http://localhost:3000');
  });

  it('answers empty rather than inventing a host', () => {
    // `viewUrl` reads this as "no address recorded" and says so, which is the
    // behaviour a missing address is supposed to produce.
    expect(baseUrlFrom(req(undefined), {})).toBe('');
  });
});

describe('the addresses it knows', () => {
  it('prefers the production alias over the per-deployment URL', () => {
    // A link somebody keeps should outlive the deployment that produced it.
    expect(configuredBases({ VERCEL_PROJECT_PRODUCTION_URL: 'a.app', VERCEL_URL: 'b.app' }))
      .toEqual(['https://a.app', 'https://b.app']);
  });

  it('is empty when the environment says nothing', () => {
    expect(configuredBases({})).toEqual([]);
  });
});
