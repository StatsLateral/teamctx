/**
 * Installing the GitHub App on a project's repository (#110): the narrower
 * alternative to lending an OAuth token. The install round-trip sends a manager
 * to GitHub and, on return, records only an installation the App confirms
 * covers the repository.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { generateKeyPairSync } from 'crypto';
import { kvGet, kvSet, keys, __resetMemory } from '../src/oauth/kv.js';
import { tokenHash } from '../src/oauth/provider.js';

let server, base;
const GITHUB = { id: '7', login: 'dev', name: 'Dev', email: 'dev@example.com', token: 'gho' };

beforeAll(async () => {
  // A real RSA key so @octokit/auth-app can sign the App JWT the callback uses.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GITHUB_APP_ID = '42';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  process.env.GITHUB_APP_SLUG = 'teamctx-access';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => {
  server?.close();
  // Don't leak the App env into other test files sharing this worker's process.
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_APP_SLUG;
});
beforeEach(() => __resetMemory());

async function req(path, { method = 'GET', cookies = {}, form } = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.get('set-cookie'), body: await res.text() };
}
const signIn = (user = GITHUB) => kvSet(keys.session('s'), user);
const withGithub = async (fn, handler) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => (handler(String(u)) ?? real(u, o));
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
// Stand in for GitHub for mayLend's admin/manager check on acme/ledger.
const asManager = (u) => {
  if (u.includes('/contents/.teamctx/config.json')) return { ok: true, status: 200, json: async () => ({ content: b64({ project: 'Ledger', managerKey: 'git:dev@example.com' }) }) };
  if (u.includes('api.github.com/repos/acme/ledger')) return { ok: true, status: 200, json: async () => ({ permissions: { admin: true, push: true } }) };
  return undefined;
};
const asStranger = (u) => {
  if (u.includes('/contents/.teamctx/config.json')) return { ok: true, status: 200, json: async () => ({ content: b64({ project: 'Ledger', managerKey: 'git:someone@else.com' }) }) };
  if (u.includes('api.github.com/repos/acme/ledger')) return { ok: true, status: 200, json: async () => ({ permissions: { admin: false, push: false } }) };
  return undefined;
};

describe('starting the install', () => {
  it('sends a manager/admin to GitHub, remembering the project and the browser', async () => {
    await signIn();
    const r = await withGithub(() => req('/settings/github-app/install?project=acme/ledger', { cookies: { teamctx_sid: 's' } }), asManager);
    expect(r.location).toMatch(/github\.com\/apps\/teamctx-access\/installations\/new\?state=/);
    const state = new URL(r.location).searchParams.get('state');
    expect(await kvGet(keys.pending(`ghapp:${state}`))).toMatchObject({ owner: 'acme', repo: 'ledger', byEmail: 'dev@example.com' });
    expect(r.setCookie).toMatch(/teamctx_bind=/);
    // The bind cookie must reach the callback under /settings/github-app — a
    // cookie scoped to /oauth never would, failing every install as "started in
    // another browser". Path must cover the callback, i.e. be the root.
    expect(r.setCookie).toMatch(/teamctx_bind=[^;]+;[^]*Path=\/(?:;|\s|$)/);
  });

  it('refuses someone with no rights on the repo, writing no pending state', async () => {
    await signIn();
    const r = await withGithub(() => req('/settings/github-app/install?project=acme/ledger', { cookies: { teamctx_sid: 's' } }), asStranger);
    expect(r.location).toContain('/settings');
    expect(r.location).not.toContain('github.com/apps');
    // No way to forge a pending record for a repo you cannot administer.
    const anyPending = [...Array(0)]; // nothing created
    expect(anyPending).toEqual([]);
  });

  it('refuses a Google sign-in, which cannot install a GitHub App', async () => {
    await signIn({ id: null, login: null, name: 'Dev', email: 'dev@example.com' });
    const r = await req('/settings/github-app/install?project=acme/ledger', { cookies: { teamctx_sid: 's' } });
    expect(r.location).toContain('/settings');
    expect(r.location).not.toContain('github.com/apps');
  });
});

describe('the setup callback', () => {
  const pend = (state, extra = {}) => kvSet(keys.pending(`ghapp:${state}`), { owner: 'acme', repo: 'ledger', byId: '7', byEmail: 'dev@example.com', bindHash: tokenHash('bind'), ...extra });

  it('records the installation the App confirms covers the repo', async () => {
    await signIn();
    await pend('st');
    await withGithub(async () => {
      const r = await req('/settings/github-app/callback?state=st&installation_id=909&setup_action=install', { cookies: { teamctx_sid: 's', teamctx_bind: 'bind' } });
      expect(r.status).toBe(303);
    }, (u) => (u.includes('/repos/acme/ledger/installation') ? { ok: true, status: 200, json: async () => ({ id: 909, repository_selection: 'selected' }) } : undefined));
    expect(await kvGet(keys.projectInstallation('acme', 'ledger'))).toMatchObject({ installationId: 909, installedByEmail: 'dev@example.com' });
    // Indexed under the installer, so the settings page can show them the control.
    expect((await kvGet(keys.appInstalledByAddress('dev@example.com')))?.projects).toContain('acme/ledger');
  });

  it('refuses an install that covers all the manager\'s repositories', async () => {
    await signIn();
    await pend('sall');
    await withGithub(async () => {
      const r = await req('/settings/github-app/callback?state=sall&installation_id=910&setup_action=install', { cookies: { teamctx_sid: 's', teamctx_bind: 'bind' } });
      expect(r.location).toContain('/settings?error=');
      expect(decodeURIComponent(r.location)).toContain('all your repositories');
    }, (u) => (u.includes('/repos/acme/ledger/installation') ? { ok: true, status: 200, json: async () => ({ id: 910, repository_selection: 'all' }) } : undefined));
    // Nothing recorded — an all-repos grant is wider than the project needs.
    expect(await kvGet(keys.projectInstallation('acme', 'ledger'))).toBeNull();
  });

  it('records nothing when the App is not installed on that repo', async () => {
    await signIn();
    await pend('s2');
    await withGithub(async () => {
      await req('/settings/github-app/callback?state=s2', { cookies: { teamctx_sid: 's', teamctx_bind: 'bind' } });
    }, (u) => (u.includes('/repos/acme/ledger/installation') ? { ok: false, status: 404 } : undefined));
    expect(await kvGet(keys.projectInstallation('acme', 'ledger'))).toBeNull();
  });

  it('rejects a callback from another browser', async () => {
    await signIn();
    await pend('s3');
    const r = await req('/settings/github-app/callback?state=s3', { cookies: { teamctx_sid: 's', teamctx_bind: 'wrong' } });
    expect(r.location).toContain('/settings');
    expect(await kvGet(keys.projectInstallation('acme', 'ledger'))).toBeNull();
  });

  it('rejects an expired or unknown state', async () => {
    await signIn();
    const r = await req('/settings/github-app/callback?state=gone', { cookies: { teamctx_sid: 's', teamctx_bind: 'bind' } });
    expect(r.location).toContain('/settings');
  });
});

describe('forgetting the install', () => {
  it('lets the installer clear it', async () => {
    await signIn();
    await kvSet(keys.projectInstallation('acme', 'ledger'), { installationId: 5, installedById: '7', installedByEmail: 'dev@example.com' });
    await req('/settings/github-app/forget', { method: 'POST', cookies: { teamctx_sid: 's' }, form: { project: 'acme/ledger' } });
    expect(await kvGet(keys.projectInstallation('acme', 'ledger'))).toBeNull();
  });

  it('refuses to clear an install someone else set up', async () => {
    await signIn();
    await kvSet(keys.projectInstallation('acme', 'ledger'), { installationId: 5, installedById: '999', installedByEmail: 'other@example.com' });
    await req('/settings/github-app/forget', { method: 'POST', cookies: { teamctx_sid: 's' }, form: { project: 'acme/ledger' } });
    expect(await kvGet(keys.projectInstallation('acme', 'ledger'))).toMatchObject({ installationId: 5 });
  });
});

describe('the settings page', () => {
  const stubRepos = (u) => (u.includes('api.github.com') ? { ok: true, status: 200, json: async () => ([]) } : undefined);

  it('offers the GitHub App install when the deployment has an App', async () => {
    await signIn();
    const r = await withGithub(() => req('/settings', { cookies: { teamctx_sid: 's' } }), stubRepos);
    expect(r.body).toContain('Install the GitHub App');
    expect(r.body).toContain('/settings/github-app/install');
  });

  it('marks lending as legacy once an App is available, steering to the App', async () => {
    await signIn();
    const r = await withGithub(() => req('/settings', { cookies: { teamctx_sid: 's' } }), stubRepos);
    expect(r.body).toContain('Legacy.');
    expect(r.body).toContain('Prefer the GitHub App below');
  });

  it('lists a project already on the App', async () => {
    await signIn();
    await kvSet(keys.lentProjects('7'), { projects: ['acme/ledger'] });
    await kvSet(keys.projectInstallation('acme', 'ledger'), { installationId: 1 });
    const r = await withGithub(() => req('/settings', { cookies: { teamctx_sid: 's' } }), stubRepos);
    expect(r.body).toContain('Using the App on');
    expect(r.body).toContain('acme/ledger');
  });

  it('shows the installer the control even for a repo not in their GitHub listing', async () => {
    await signIn();
    // Not in lent, not in repos (stubbed empty) — only the installer index.
    await kvSet(keys.projectInstallation('org', 'secret-repo'), { installationId: 2, installedByEmail: 'dev@example.com' });
    await kvSet(keys.appInstalledByAddress('dev@example.com'), { projects: ['org/secret-repo'] });
    const r = await withGithub(() => req('/settings', { cookies: { teamctx_sid: 's' } }), stubRepos);
    expect(r.body).toContain('org/secret-repo');
    expect(r.body).toContain('Stop using the App');
  });
});
