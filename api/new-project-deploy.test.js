/**
 * A project created on the web records where it is deployed.
 *
 * Without it, a clone of that project looked exactly like one nobody uses
 * through the connector — and the terminal let manager changes through without
 * the key and lent-access checks that only the hosted server can run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';

vi.mock('../cli/commands/init.core.js', () => ({ initProject: vi.fn(async () => ({})) }));
vi.mock('../src/adapters/github.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    GithubSession: class { async prefetch() {} },
    listPushableRepos: async () => [],
    listUserOrgs: async () => [],
  };
});

let server, base;

beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

describe('creating a project on the web', () => {
  it('records the deployment it was created through', async () => {
    const { kvSet, keys, __resetMemory } = await import('../src/oauth/kv.js');
    const { initProject } = await import('../cli/commands/init.core.js');
    __resetMemory();
    await kvSet(keys.session('s'), { id: '1', login: 'ada', name: 'Ada', email: 'ada@example.com', token: 't' });

    await fetch(`${base}/settings/new-project`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: 'teamctx_sid=s', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ projectName: 'Ledger', existingRepo: 'acme/ledger' }).toString(),
    });

    expect(initProject).toHaveBeenCalledWith(expect.objectContaining({
      deployUrl: 'https://team.example.app',
      managerKey: 'git:ada@example.com',
    }));
  });
});
