/**
 * The settings page for somebody who signs in with Google.
 *
 * Keys are stored by verified email, so a Google sign-in reaches the same keys
 * as a GitHub sign-in with the same address. Anyone on a project may add a key
 * to it. What a Google sign-in cannot do is anything that needs a GitHub
 * credential: lend access, or create a repository.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { kvGet, kvSet, keys, __resetMemory } from '../src/oauth/kv.js';
import { readPersonalKey, readProjectKeys, writePersonalKey } from '../src/oauth/ai-keys.js';

let server, base;

beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const GOOGLE = { id: null, login: null, name: 'Dev', email: 'dev@example.com', token: null, source: 'google' };
const GITHUB = { id: '7', login: 'dev', name: 'Dev', email: 'dev@example.com', token: 'gho' };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  members: [{ key: 'git:dev@example.com', name: 'Dev', email: 'dev@example.com', login: null }],
};
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64');

/** Stand in for GitHub, the only outside service these routes reach. */
function stubGithub({ push = false, config = CONFIG } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('/contents/.teamctx/config.json')) {
      return { ok: true, status: 200, json: async () => ({ content: b64(config) }) };
    }
    if (url.includes('api.github.com/repos/')) {
      return { ok: true, status: 200, json: async () => ({ permissions: { push } }) };
    }
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ([]) };
    return real(u, o);
  };
  return () => { globalThis.fetch = real; };
}

async function as(user, path, { method = 'GET', form } = {}) {
  await kvSet(keys.session('s'), user);
  const real = globalThis.fetch;
  const res = await real(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      cookie: 'teamctx_sid=s',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

beforeEach(() => __resetMemory());

describe('signing in', () => {
  it('offers Google beside GitHub on the settings sign-in page', async () => {
    const body = await (await fetch(`${base}/settings`)).text();
    expect(body).toContain('/settings/signin/google');
    expect(body).toContain('Continue with Google');
  });

  it('sends a Google sign-in through Google, tagged as a settings sign-in', async () => {
    const res = await fetch(`${base}/settings/signin/google`, { redirect: 'manual' });
    const to = new URL(res.headers.get('location'));
    expect(to.hostname).toBe('accounts.google.com');
    const state = to.searchParams.get('state');
    expect(await kvGet(keys.pending(`settings-google:${state}`))).toBeTruthy();
  });

  it('turns a Google callback into a settings session carrying the verified address', async () => {
    await kvSet(keys.pending('settings-google:abc'), { kind: 'settings' });
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => ({ access_token: 'g' }) };
      if (url.includes('openidconnect.googleapis.com')) {
        return { ok: true, json: async () => ({ email: 'Dev@Example.com', email_verified: true, name: 'Dev', sub: '1' }) };
      }
      return real(u, o);
    };
    try {
      const res = await real(`${base}/oauth/google/callback?code=c&state=abc`, { redirect: 'manual' });
      expect(res.status).toBe(303);
      const sid = /teamctx_sid=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
      expect(await kvGet(keys.session(sid))).toMatchObject({ email: 'dev@example.com', token: null, source: 'google' });
    } finally { globalThis.fetch = real; }
  });
});

describe('the page a Google sign-in sees', () => {
  it('says keys are stored by address', async () => {
    const { body } = await as(GOOGLE, '/settings');
    expect(body).toContain('Stored against your\nemail address');
  });

  it('does not offer to lend GitHub access, and says why', async () => {
    const { body } = await as(GOOGLE, '/settings');
    expect(body).not.toContain('action="/settings/lend"');
    expect(body).toContain('Lending GitHub access needs a GitHub sign-in');
  });

  it('does not offer to create a project, which creates a GitHub repository', async () => {
    const { body } = await as(GOOGLE, '/settings');
    expect(body).not.toContain('href="/settings/new-project"');
  });

  it('refuses the lend and new-project routes outright', async () => {
    const lend = await as(GOOGLE, '/settings/lend', { method: 'POST', form: { project: 'acme/ledger' } });
    expect(decodeURIComponent(lend.location)).toMatch(/needs a GitHub sign-in/);
    const create = await as(GOOGLE, '/settings/new-project');
    expect(decodeURIComponent(create.location)).toMatch(/needs a GitHub sign-in/);
  });
});

describe('one person, however they signed in', () => {
  it('finds through Google the key they saved through GitHub', async () => {
    const restore = stubGithub();
    try {
      await as(GITHUB, '/settings', { method: 'POST', form: { provider: 'anthropic', apiKey: 'sk-dev' } });
    } finally { restore(); }
    expect((await readPersonalKey({ email: 'dev@example.com' })).apiKey).toBe('sk-dev');
    const { body } = await as(GOOGLE, '/settings');
    expect(body).toContain('a key is already saved');
  });

  it('finds through GitHub the key they saved through Google', async () => {
    await as(GOOGLE, '/settings', { method: 'POST', form: { provider: 'openai', apiKey: 'sk-g' } });
    const restore = stubGithub();
    try {
      const { body } = await as(GITHUB, '/settings');
      expect(body).toContain('a key is already saved');
    } finally { restore(); }
  });
});

describe('adding a key to a project', () => {
  it('lets a roster member signed in with Google add one, recorded by their address', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    const restore = stubGithub();
    try {
      const r = await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', provider: 'anthropic', apiKey: 'sk-dev' } });
      expect(r.location).toBe('/settings?saved=1');
    } finally { restore(); }
    expect((await readProjectKeys('acme', 'ledger')).byEmail['dev@example.com']).toMatchObject({ apiKey: 'sk-dev', addedBy: 'dev@example.com' });
  });

  it('refuses a Google sign-in on a project that has not lent access, and says what to do', async () => {
    const r = await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-dev' } });
    expect(decodeURIComponent(r.location)).toMatch(/has not lent GitHub access/);
    expect((await readProjectKeys('acme', 'ledger')).byEmail).toEqual({});
  });

  it('refuses somebody who is not on the project', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    const stranger = { ...GOOGLE, email: 'sam@example.com' };
    const restore = stubGithub();
    try {
      const r = await as(stranger, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk' } });
      expect(decodeURIComponent(r.location)).toMatch(/sam@example\.com is not on acme\/ledger/);
    } finally { restore(); }
    expect((await readProjectKeys('acme', 'ledger')).byEmail).toEqual({});
  });

  it('still lets a GitHub sign-in with push access add one', async () => {
    const restore = stubGithub({ push: true });
    try {
      await as({ ...GITHUB, email: 'maya@example.com' }, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-maya' } });
    } finally { restore(); }
    expect((await readProjectKeys('acme', 'ledger')).byEmail['maya@example.com'].apiKey).toBe('sk-maya');
  });

  it('lets two people each add a key without either displacing the other', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    const restore = stubGithub({ push: true });
    try {
      await as({ ...GITHUB, email: 'maya@example.com' }, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-maya' } });
      await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-dev' } });
    } finally { restore(); }
    expect(Object.keys((await readProjectKeys('acme', 'ledger')).byEmail).sort()).toEqual(['dev@example.com', 'maya@example.com']);
  });

  it('removes only the key of the person asking', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    const restore = stubGithub({ push: true });
    try {
      await as({ ...GITHUB, email: 'maya@example.com' }, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-maya' } });
      await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-dev' } });
      await as(GOOGLE, '/settings/unshare', { method: 'POST', form: { project: 'acme/ledger' } });
    } finally { restore(); }
    expect(Object.keys((await readProjectKeys('acme', 'ledger')).byEmail)).toEqual(['maya@example.com']);
  });

  it('can reuse the saved personal key, found by address', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    await writePersonalKey({ email: 'dev@example.com', provider: 'gemini', apiKey: 'sk-saved' });
    const restore = stubGithub();
    try {
      await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', useMyKey: '1' } });
    } finally { restore(); }
    expect((await readProjectKeys('acme', 'ledger')).byEmail['dev@example.com']).toMatchObject({ apiKey: 'sk-saved', provider: 'gemini' });
  });
});

describe('the home page for a Google sign-in', () => {
  it('names them by address, not "null", and offers settings rather than a new project', async () => {
    const { body } = await as(GOOGLE, '/');
    expect(body).toContain('Signed in as <strong>dev@example.com</strong>');
    expect(body).not.toContain('<strong>null</strong>');
    expect(body).not.toContain('Create a new project');
  });
});

describe('lending GitHub access', () => {
  it('is refused when the sign-in revealed no address, since the lender is recorded by it', async () => {
    const r = await as({ ...GITHUB, email: null }, '/settings/lend', { method: 'POST', form: { project: 'acme/ledger' } });
    expect(decodeURIComponent(r.location)).toMatch(/did not reveal a verified email address/);
    expect(await kvGet(keys.projectGhCred('acme', 'ledger'))).toBe(null);
  });

  it('records the address of whoever lent it, so a manager can be matched to it', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('/contents/.teamctx/config.json')) {
        return { ok: true, status: 200, json: async () => ({ content: b64(CONFIG) }) };
      }
      if (url.includes('api.github.com/repos/')) {
        return { ok: true, status: 200, json: async () => ({ permissions: { admin: true, push: true } }) };
      }
      if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ([]) };
      return real(u, o);
    };
    try {
      await as({ ...GITHUB, email: 'maya@example.com' }, '/settings/lend', { method: 'POST', form: { project: 'acme/ledger' } });
    } finally { globalThis.fetch = real; }
    expect(await kvGet(keys.projectGhCred('acme', 'ledger'))).toMatchObject({ lentByEmail: 'maya@example.com', lentById: '7' });
  });

  it('lets a manager identified by email lend without being a repository admin', async () => {
    // A lead being handed a project is usually a collaborator, not an admin, and
    // is written as git:<email>. Matched by GitHub id alone, they were refused.
    const real = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('/contents/.teamctx/config.json')) {
        return { ok: true, status: 200, json: async () => ({ content: b64({ ...CONFIG, managerKeys: ['git:dev@example.com'] }) }) };
      }
      if (url.includes('api.github.com/repos/')) {
        return { ok: true, status: 200, json: async () => ({ permissions: { admin: false, push: true } }) };
      }
      if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ([]) };
      return real(u, o);
    };
    let r;
    try {
      r = await as(GITHUB, '/settings/lend', { method: 'POST', form: { project: 'acme/ledger' } });
    } finally { globalThis.fetch = real; }
    expect(r.location).toBe('/settings?saved=1');
    expect(await kvGet(keys.projectGhCred('acme', 'ledger'))).toMatchObject({ lentByEmail: 'dev@example.com' });
  });
});

describe('the key a project runs on', () => {
  it('warns the primary manager before removing the key the project runs on', async () => {
    // The key is theirs to remove. But everyone without a key of their own loses
    // the model when it goes, so the first attempt stops to say so.
    const primaryConfig = { ...CONFIG, managerKey: 'git:dev@example.com' };
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    const restore = stubGithub({ config: primaryConfig });
    try {
      await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-dev' } });
      const r = await as(GOOGLE, '/settings/unshare', { method: 'POST', form: { project: 'acme/ledger' } });
      expect(r.location).toBe('/settings?confirmRemove=acme%2Fledger');
      expect((await readProjectKeys('acme', 'ledger')).byEmail['dev@example.com']).toBeTruthy();

      const page = await as(GOOGLE, r.location);
      expect(page.body).toContain('acme/ledger runs on this key.');
      expect(page.body).toContain('name="confirm" value="1"');
    } finally { restore(); }
  });

  it('removes it when the primary manager confirms, because it is theirs', async () => {
    const primaryConfig = { ...CONFIG, managerKey: 'git:dev@example.com' };
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    const restore = stubGithub({ config: primaryConfig });
    try {
      await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-dev' } });
      const r = await as(GOOGLE, '/settings/unshare', { method: 'POST', form: { project: 'acme/ledger', confirm: '1' } });
      expect(r.location).toBe('/settings?saved=1');
    } finally { restore(); }
    expect((await readProjectKeys('acme', 'ledger')).byEmail).toEqual({});
  });

  it('warns a primary stored by GitHub id too', async () => {
    const idConfig = { ...CONFIG, managerKey: 'github:7' };
    const restore = stubGithub({ config: idConfig, push: true });
    try {
      await as(GITHUB, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-dev' } });
      const r = await as(GITHUB, '/settings/unshare', { method: 'POST', form: { project: 'acme/ledger' } });
      expect(r.location).toBe('/settings?confirmRemove=acme%2Fledger');
    } finally { restore(); }
  });

  it('can be removed by anyone who is not primary', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '1' });
    const restore = stubGithub();
    try {
      await as(GOOGLE, '/settings/share', { method: 'POST', form: { project: 'acme/ledger', apiKey: 'sk-dev' } });
      const r = await as(GOOGLE, '/settings/unshare', { method: 'POST', form: { project: 'acme/ledger' } });
      expect(r.location).toBe('/settings?saved=1');
    } finally { restore(); }
    expect((await readProjectKeys('acme', 'ledger')).byEmail).toEqual({});
  });
});

describe('records saved under a GitHub id before keys were stored by address', () => {
  // The screenshots: signed in with GitHub, a personal key, three project keys
  // and two lent projects; signed in with Google on the same address, nothing.
  // The old records were keyed by GitHub id, and a Google sign-in has none.
  const seedOld = async () => {
    await kvSet(keys.aiKey('7'), { provider: 'anthropic', apiKey: 'sk-old-personal' });
    await kvSet(keys.projectAiKey('acme', 'ledger'), { provider: 'anthropic', apiKey: 'sk-old-shared', sharedById: '7', sharedByLogin: 'dev' });
    await kvSet(keys.sharedProjects('7'), { projects: ['acme/ledger'] });
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'lent', lentById: '7', lentByLogin: 'dev' });
    await kvSet(keys.lentProjects('7'), { projects: ['acme/ledger'] });
  };

  it('are carried over on a GitHub sign-in, so a Google sign-in sees all of them', async () => {
    await seedOld();
    const restore = stubGithub();
    try { await as(GITHUB, '/settings'); } finally { restore(); }

    const { body } = await as(GOOGLE, '/settings');
    expect(body).toContain('a key is already saved');
    expect(body).toContain('You have added a key to:');
    expect(body).toContain('action="/settings/unshare"');
    expect(body).toContain('Lending access to:');
    expect(body).toContain('action="/settings/unlend"');
  });

  it('keep the project running on the same key afterwards', async () => {
    const { pickProjectKey } = await import('../src/oauth/ai-keys.js');
    await seedOld();
    const restore = stubGithub();
    try { await as(GITHUB, '/settings'); } finally { restore(); }
    // Before: the single shared record was the fallback for everyone. After:
    // the same key, carried over under its owner's address, still is.
    const projectKeys = await readProjectKeys('acme', 'ledger');
    expect(projectKeys.legacy).toBe(null);
    expect(pickProjectKey({ projectKeys, primaryKey: 'git:maya@example.com' }).apiKey).toBe('sk-old-shared');
  });

  it('can be withdrawn from the Google sign-in: lent access and the carried key', async () => {
    const { pickProjectKey } = await import('../src/oauth/ai-keys.js');
    await seedOld();
    const restore = stubGithub();
    try {
      await as(GITHUB, '/settings');
      const lend = await as(GOOGLE, '/settings/unlend', { method: 'POST', form: { project: 'acme/ledger' } });
      expect(lend.location).toBe('/settings?saved=1');
      await as(GOOGLE, '/settings/unshare', { method: 'POST', form: { project: 'acme/ledger' } });
    } finally { restore(); }
    expect(await kvGet(keys.projectGhCred('acme', 'ledger'))).toBe(null);
    const projectKeys = await readProjectKeys('acme', 'ledger');
    expect(pickProjectKey({ projectKeys, primaryKey: 'git:maya@example.com' })).toBe(null);
  });

  it('are not carried over twice', async () => {
    await seedOld();
    const restore = stubGithub();
    try { await as(GITHUB, '/settings'); await as(GITHUB, '/settings'); } finally { restore(); }
    expect(Object.keys((await readProjectKeys('acme', 'ledger')).byEmail)).toEqual(['dev@example.com']);
  });

  it('still refuses to withdraw somebody else\'s lent access from a Google sign-in', async () => {
    await kvSet(keys.projectGhCred('acme', 'ledger'), { token: 't', lentById: '9', lentByEmail: 'maya@example.com' });
    const r = await as(GOOGLE, '/settings/unlend', { method: 'POST', form: { project: 'acme/ledger' } });
    expect(decodeURIComponent(r.location)).toMatch(/lent by someone else/);
    expect(await kvGet(keys.projectGhCred('acme', 'ledger'))).toBeTruthy();
  });
});

describe('the project picker for a Google sign-in', () => {
  it('offers the projects that address connected to through the connector', async () => {
    await kvSet(keys.connectedProjects('dev@example.com'), { projects: ['acme/ledger'] });
    const { body } = await as(GOOGLE, '/settings');
    expect(body).toContain('<option value="acme/ledger">');
  });
});
