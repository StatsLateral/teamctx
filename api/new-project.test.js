import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { kvSet, keys, __resetMemory } from '../src/oauth/kv.js';

/**
 * #66 step 4 is "add an existing repo to teamctx, or create a new one" — only
 * the second half existed, so somebody who already had a repository was made to
 * create a second one.
 */
let server, base, realFetch;

beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  realFetch = globalThis.fetch;
});
afterAll(() => { globalThis.fetch = realFetch; server?.close(); });

const page = async () => {
  __resetMemory();
  await kvSet(keys.session('s'), { id: '1', login: 'ada', name: 'Ada', token: 't' });
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('api.github.com/user/repos')) {
      return { ok: true, json: async () => ([{ full_name: 'acme/ledger', private: true, permissions: { push: true } }]) };
    }
    if (url.includes('api.github.com/user/orgs')) return { ok: true, status: 200, json: async () => ([]) };
    return realFetch(u, o);
  };
  try {
    return await (await realFetch(`${base}/settings/new-project`, { headers: { cookie: 'teamctx_sid=s' } })).text();
  } finally { globalThis.fetch = realFetch; }
};

describe('starting a project', () => {
  it('offers a repository you already have, not only a new one', async () => {
    const body = await page();
    expect(body).toMatch(/repository you already have/i);
    expect(body).toContain('name="existingRepo"');
  });

  it('lets you search that list rather than spell it', async () => {
    expect(await page()).toContain('id="existing-list"');
  });

  it('says what it will do to the repository', async () => {
    // Pointing teamctx at a repo full of real work is a reasonable thing to
    // hesitate over.
    expect(await page()).toMatch(/leaves\s+everything else alone/i);
  });

  it('still offers creating a new one', async () => {
    expect(await page()).toContain('Create project');
  });
});
