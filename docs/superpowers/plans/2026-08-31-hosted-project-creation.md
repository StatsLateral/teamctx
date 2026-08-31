# Hosted Project Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager with no GitHub experience create a brand-new teamctx project entirely through a web page, so the hosted MCP connector URL they paste into Claude points at a real, already-initialized repo.

**Architecture:** A new page on the existing hosted OAuth server (`api/oauth-server.js`), reusing its repo-independent GitHub login (`/settings`'s session-cookie pattern). The manager signs in once, picks personal account or an org, names a project; the server creates a private GitHub repo via the REST API, then runs the existing `initProject` against it using the same `GithubSession`/`runWithSession` machinery the per-request MCP handler already uses — and shows the manager their connector URL.

**Tech Stack:** Node.js, Express (`api/oauth-server.js`), GitHub REST API, Vercel KV (via `src/oauth/kv.js`), Vitest.

## Global Constraints

- Private repos only (`private: true`), always `auto_init: true` (repo needs an initial commit/default branch before `GithubSession.commit()` can build on top of it).
- Repo name is auto-derived from the project name (`slugifyProjectName`) — never a separate user-entered field.
- Owner can be the signed-in user's personal account or one of their GitHub orgs — user picks from a list, no free-text org entry.
- This work does **not** depend on PR #50 landing — the connector URL is assembled inline (`${baseUrl}/api/mcp/${owner}/${repo}`), not via #50's `get_connect_url`.
- No new npm dependencies (no `supertest` or similar) — Express route handlers in `api/oauth-server.js` are not unit-tested, consistent with the rest of that file today (`canShareWith`/`parseRepoRef` aren't tested either). Only the pure helper functions this plan extracts get unit tests.
- Spec: `docs/superpowers/specs/2026-08-31-hosted-project-creation-design.md`.

---

### Task 1: `slugifyProjectName` in `src/adapters/github.js`

**Files:**
- Modify: `src/adapters/github.js` (append new exported function after the existing `isGithubCtx` export, before the `GithubSession` class — around line 29-31)
- Test: `src/adapters/github.test.js` (new file)

**Interfaces:**
- Produces: `slugifyProjectName(name: string) → string` — a lowercase, hyphenated, GitHub-repo-name-safe slug. Never returns an empty string (falls back to `'project'`).

- [ ] **Step 1: Write the failing test**

Create `src/adapters/github.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { slugifyProjectName } from './github.js';

describe('slugifyProjectName', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugifyProjectName('Q3 GTM Strategy')).toBe('q3-gtm-strategy');
  });

  it('collapses repeated separators', () => {
    expect(slugifyProjectName('  Multiple   Spaces  ')).toBe('multiple-spaces');
  });

  it('strips punctuation instead of keeping it', () => {
    expect(slugifyProjectName('Special!!Chars??')).toBe('special-chars');
  });

  it('falls back to "project" for empty or all-punctuation input', () => {
    expect(slugifyProjectName('')).toBe('project');
    expect(slugifyProjectName('!!!')).toBe('project');
    expect(slugifyProjectName(undefined)).toBe('project');
  });

  it('leaves an already-valid slug alone', () => {
    expect(slugifyProjectName('already-slugged')).toBe('already-slugged');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/github.test.js`
Expected: FAIL — `slugifyProjectName is not a function` (or similar import error), since it doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `src/adapters/github.js`, add after the `isGithubCtx` export (before `export class GithubSession`):

```js
/**
 * Turns a human-typed project name into a GitHub-valid repo name. Never
 * empty — an all-punctuation or blank name still needs somewhere to land.
 */
export function slugifyProjectName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/github.test.js`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.js src/adapters/github.test.js
git commit -m "feat: slugify project names into GitHub-valid repo names"
```

---

### Task 2: `listUserOrgs` in `src/adapters/github.js`

**Files:**
- Modify: `src/adapters/github.js`
- Test: `src/adapters/github.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `listUserOrgs(token: string) → Promise<{login: string}[]>`. Throws on a non-OK response.

- [ ] **Step 1: Write the failing test**

Add to `src/adapters/github.test.js` (new `describe` block, same file):

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { slugifyProjectName, listUserOrgs } from './github.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listUserOrgs', () => {
  it('returns the logins of orgs the token can see', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(url).toBe('https://api.github.com/user/orgs');
      return { ok: true, status: 200, json: async () => ([{ login: 'acme-corp', id: 1 }, { login: 'side-project', id: 2 }]) };
    }));
    const orgs = await listUserOrgs('gh-token');
    expect(orgs).toEqual([{ login: 'acme-corp' }, { login: 'side-project' }]);
  });

  it('throws when GitHub returns a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(listUserOrgs('gh-token')).rejects.toThrow(/500/);
  });
});
```

(Note: `describe('slugifyProjectName', ...)` from Task 1 stays in the file — this just adds imports/blocks alongside it. Update the top `import` line to include `listUserOrgs` and add the `afterEach`/`vi` import once, not per block.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/github.test.js`
Expected: FAIL — `listUserOrgs is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/adapters/github.js`, add after `slugifyProjectName`:

```js
/** Orgs the token's owner belongs to, for the "where should this repo live" picker. */
export async function listUserOrgs(token) {
  const res = await fetch(`${API}/user/orgs`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`github: could not list orgs (${res.status})`);
  const body = await res.json();
  return body.map(o => ({ login: o.login }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/github.test.js`
Expected: PASS — 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.js src/adapters/github.test.js
git commit -m "feat: list a token's GitHub orgs for the repo-owner picker"
```

---

### Task 3: `createRepo` in `src/adapters/github.js`

**Files:**
- Modify: `src/adapters/github.js`
- Test: `src/adapters/github.test.js`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `createRepo(token: string, { name: string, org?: string|null, description?: string }) → Promise<{owner: string, repo: string}>`. Throws an `Error` with `.code` set to `'REPO_EXISTS'` (422) or `'REPO_FORBIDDEN'` (403) for those two cases; a plain `Error` for anything else non-OK.

- [ ] **Step 1: Write the failing test**

Add to `src/adapters/github.test.js`:

```js
import { slugifyProjectName, listUserOrgs, createRepo } from './github.js';

describe('createRepo', () => {
  it('creates under the personal account when no org is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      expect(url).toBe('https://api.github.com/user/repos');
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ name: 'q3-gtm-strategy', description: 'Q3 GTM Strategy', private: true, auto_init: true });
      return { ok: true, status: 201, json: async () => ({ owner: { login: 'alice' }, name: 'q3-gtm-strategy' }) };
    }));
    const result = await createRepo('gh-token', { name: 'q3-gtm-strategy', org: null, description: 'Q3 GTM Strategy' });
    expect(result).toEqual({ owner: 'alice', repo: 'q3-gtm-strategy' });
  });

  it('creates under an org when one is given', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(url).toBe('https://api.github.com/orgs/acme-corp/repos');
      return { ok: true, status: 201, json: async () => ({ owner: { login: 'acme-corp' }, name: 'q3-gtm-strategy' }) };
    }));
    const result = await createRepo('gh-token', { name: 'q3-gtm-strategy', org: 'acme-corp' });
    expect(result).toEqual({ owner: 'acme-corp', repo: 'q3-gtm-strategy' });
  });

  it('throws REPO_EXISTS on a 422 name collision', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ message: 'name already exists on this account' }) })));
    const err = await createRepo('gh-token', { name: 'taken', org: null }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('REPO_EXISTS');
  });

  it('throws REPO_FORBIDDEN on a 403, using GitHub\'s message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ message: 'Must have admin rights to Repository.' }) })));
    const err = await createRepo('gh-token', { name: 'blocked', org: 'locked-org' }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('REPO_FORBIDDEN');
    expect(err.message).toBe('Must have admin rights to Repository.');
  });

  it('throws a plain error for anything else non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const err = await createRepo('gh-token', { name: 'x', org: null }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBeUndefined();
    expect(err.message).toMatch(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/github.test.js`
Expected: FAIL — `createRepo is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/adapters/github.js`, add after `listUserOrgs`:

```js
/**
 * Creates a private repo with an initial commit — `auto_init` is required so
 * the repo has a real default branch for GithubSession.commit() to build the
 * .teamctx/ commit on top of; a zero-commit repo has no ref to resolve.
 */
export async function createRepo(token, { name, org, description = '' }) {
  const url = org ? `${API}/orgs/${org}/repos` : `${API}/user/repos`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, description, private: true, auto_init: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 422) {
    const err = new Error(body.message || `github: repo "${name}" already exists`);
    err.code = 'REPO_EXISTS';
    throw err;
  }
  if (res.status === 403) {
    const err = new Error(body.message || `github: not allowed to create a repo in ${org || 'your account'}`);
    err.code = 'REPO_FORBIDDEN';
    throw err;
  }
  if (!res.ok) {
    throw new Error(`github: repo creation failed (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { owner: body.owner.login, repo: body.name };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/github.test.js`
Expected: PASS — 12 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.js src/adapters/github.test.js
git commit -m "feat: create a private GitHub repo via the REST API"
```

---

### Task 4: Extract `sourceNote` and wire `source: 'web'` in `cli/commands/init.core.js`

**Files:**
- Modify: `cli/commands/init.core.js:122-126` (the existing inline `sourceNote` variable and comment)
- Test: `cli/commands/init.core.test.js` (new file — first test for this module)

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: `sourceNote(source: string) → string` — `' (via mcp)'` for `'mcp'`, `' (via web onboarding)'` for `'web'`, `''` otherwise. Exported so Task 8's route handler (and the test here) can call `initProject({ ..., source: 'web' })` and know what commit-message suffix to expect.

- [ ] **Step 1: Write the failing test**

Create `cli/commands/init.core.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { sourceNote } from './init.core.js';

describe('sourceNote', () => {
  it('flags an MCP-originated init', () => {
    expect(sourceNote('mcp')).toBe(' (via mcp)');
  });

  it('flags a web-onboarding-originated init', () => {
    expect(sourceNote('web')).toBe(' (via web onboarding)');
  });

  it('adds no note for the default CLI source', () => {
    expect(sourceNote('cli')).toBe('');
    expect(sourceNote(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run cli/commands/init.core.test.js`
Expected: FAIL — `sourceNote is not a function` (not exported yet).

- [ ] **Step 3: Write minimal implementation**

In `cli/commands/init.core.js`, replace the block at (current) lines 122-126:

```js
  // Same note `contributeCore` puts on its commits: reading the history of a
  // repo initialized from a chat client, there is otherwise nothing to say where
  // the commit came from — no local checkout, no shell, just an author.
  const sourceNote = source === 'mcp' ? ' (via mcp)' : '';
  await commitContext(`chore: initialize teamctx for "${project}"${sourceNote}`, gitCwd ? { cwd: gitCwd } : undefined);
```

with:

```js
  // Same note `contributeCore` puts on its commits: reading the history of a
  // repo initialized with no local checkout and no shell, there is otherwise
  // nothing to say where the commit came from — no local checkout, no shell,
  // just an author.
  await commitContext(`chore: initialize teamctx for "${project}"${sourceNote(source)}`, gitCwd ? { cwd: gitCwd } : undefined);
```

And add the exported function near the top of the file, after `export function getProviders() { ... }` (around line 17):

```js
/**
 * Reading the history of a project bootstrapped with no local checkout and
 * no shell, the commit message is the only record of where it came from.
 */
export function sourceNote(source) {
  if (source === 'mcp') return ' (via mcp)';
  if (source === 'web') return ' (via web onboarding)';
  return '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run cli/commands/init.core.test.js`
Expected: PASS — 3 tests passing.

Also run the full suite to confirm the inline-variable-to-function-call swap didn't break anything already depending on `initProject`'s commit message:

Run: `npx vitest run`
Expected: PASS — all existing tests still green (in particular anything asserting on `'chore: initialize teamctx for'` commit messages).

- [ ] **Step 5: Commit**

```bash
git add cli/commands/init.core.js cli/commands/init.core.test.js
git commit -m "refactor: extract sourceNote, add a web-onboarding source"
```

---

### Task 5: `returnTo` support on `/settings/signin` and its callback

**Files:**
- Modify: `api/oauth-server.js:187-197` (`/settings/signin` handler)
- Modify: `api/oauth-server.js:93-107` (the `settingsPending` branch of `/oauth/github/callback`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: after this task, `/settings/signin?returnTo=/settings/new-project` lands the user back on `/settings/new-project` post-login instead of always `/settings`. Task 6 depends on this.

- [ ] **Step 1: Modify `/settings/signin`**

Replace (current lines 187-197):

```js
/** Starts the GitHub login. Only reached by clicking Sign in. */
app.get('/settings/signin', async (req, res) => {
  const state = randomBytes(18).toString('base64url');
  await kvSet(keys.pending(`settings:${state}`), { kind: 'settings' }, { ttlSeconds: TTL.pending });
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', process.env.GITHUB_OAUTH_CLIENT_ID || '');
  url.searchParams.set('redirect_uri', `${baseUrlFor(req)}/oauth/github/callback`);
  url.searchParams.set('scope', GITHUB_SCOPES);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});
```

with:

```js
/** Starts the GitHub login. Only reached by clicking Sign in. */
app.get('/settings/signin', async (req, res) => {
  const state = randomBytes(18).toString('base64url');
  // Allow-listed rather than trusted: this is the only place a client-
  // supplied path could end up driving a redirect, so anything outside
  // /settings/<word> is dropped rather than carried through.
  const requestedReturnTo = String(req.query.returnTo || '');
  const returnTo = /^\/settings\/[a-z-]+$/.test(requestedReturnTo) ? requestedReturnTo : null;
  await kvSet(
    keys.pending(`settings:${state}`),
    returnTo ? { kind: 'settings', returnTo } : { kind: 'settings' },
    { ttlSeconds: TTL.pending },
  );
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', process.env.GITHUB_OAUTH_CLIENT_ID || '');
  url.searchParams.set('redirect_uri', `${baseUrlFor(req)}/oauth/github/callback`);
  url.searchParams.set('scope', GITHUB_SCOPES);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});
```

- [ ] **Step 2: Modify the callback's `settingsPending` branch**

Replace (current lines 95-107):

```js
  const settingsPending = await kvTake(keys.pending(`settings:${state}`));
  if (settingsPending) {
    if (error) return res.status(400).send(errorPage(`GitHub returned: ${error}`));
    try {
      const githubUser = await loginViaGithub(String(code), baseUrlFor(req));
      const sid = randomBytes(24).toString('base64url');
      await kvSet(keys.session(sid), githubUser, { ttlSeconds: TTL.session });
      res.setHeader('Set-Cookie',
        `teamctx_sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL.session}`);
      return res.redirect(303, '/settings');
    } catch (e) {
      return res.status(400).send(errorPage(e.message));
    }
  }
```

with:

```js
  const settingsPending = await kvTake(keys.pending(`settings:${state}`));
  if (settingsPending) {
    if (error) return res.status(400).send(errorPage(`GitHub returned: ${error}`));
    try {
      const githubUser = await loginViaGithub(String(code), baseUrlFor(req));
      const sid = randomBytes(24).toString('base64url');
      await kvSet(keys.session(sid), githubUser, { ttlSeconds: TTL.session });
      res.setHeader('Set-Cookie',
        `teamctx_sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL.session}`);
      return res.redirect(303, settingsPending.returnTo || '/settings');
    } catch (e) {
      return res.status(400).send(errorPage(e.message));
    }
  }
```

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no existing test covers these two handlers directly (consistent with this file's existing convention), so this step is confirming the edit didn't break anything else, not exercising the new branch. The new branch itself is verified manually in Task 9.

- [ ] **Step 4: Commit**

```bash
git add api/oauth-server.js
git commit -m "feat: let settings sign-in return to a specific settings page"
```

---

### Task 6: `GET /settings/new-project` page

**Files:**
- Modify: `api/oauth-server.js` — add import, add route, add render function

**Interfaces:**
- Consumes: `slugifyProjectName`, `listUserOrgs`, `createRepo` from `src/adapters/github.js` (Tasks 1-3); the `returnTo`-aware `/settings/signin` from Task 5.
- Produces: `newProjectPage({ user, orgs, projectName?, orgLogin?, error? }) → string` (HTML), used again by Task 7's error paths. `safeListOrgs(token) → Promise<{login:string}[]>` (never throws — swallows `listUserOrgs` failures to `[]`, per the design's "org list fetch fails → fall back to personal-account-only, non-fatal" rule).

- [ ] **Step 1: Add the import**

At the top of `api/oauth-server.js`, after the existing `kv.js` import (line 5):

```js
import { listUserOrgs } from '../src/adapters/github.js';
```

- [ ] **Step 2: Add `safeListOrgs` and the route**

After the `/settings/signin` handler (Task 5's edited block), add:

```js
/** Org listing is a nice-to-have on this form, not a hard dependency. */
async function safeListOrgs(token) {
  try { return await listUserOrgs(token); } catch { return []; }
}

/** Where a manager with no repo yet gets one, without touching GitHub directly. */
app.get('/settings/new-project', async (req, res) => {
  const user = await currentUser(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!user) return res.redirect(303, '/settings/signin?returnTo=/settings/new-project');
  const orgs = await safeListOrgs(user.token);
  res.send(newProjectPage({ user, orgs }));
});
```

- [ ] **Step 3: Add the render function**

Near the other page-render functions (after `settingsPage`, before `signInPage` — around current line 415-416):

```js
const newProjectPage = ({ user, orgs, projectName = '', orgLogin = '', error = null }) => shell('New project', `
<h1>Create a new teamctx project</h1>
<p>Signed in as <strong>${esc(user.login)}</strong>. This creates a new private
GitHub repository and sets it up for teamctx — nothing to install, nothing to
type in a terminal.</p>
${error ? `<div class="bad">${esc(error)}</div>` : ''}
<form method="POST" action="/settings/new-project">
  <label for="projectName">Project name</label>
  <input id="projectName" name="projectName" placeholder="Q3 GTM Strategy" value="${esc(projectName)}" required>
  <label for="orgLogin">Where should it live?</label>
  <select id="orgLogin" name="orgLogin">
    <option value="" ${orgLogin === '' ? 'selected' : ''}>Your personal account (${esc(user.login)})</option>
    ${orgs.map(o => `<option value="${esc(o.login)}" ${o.login === orgLogin ? 'selected' : ''}>${esc(o.login)}</option>`).join('')}
  </select>
  <p class="muted">The repository is created private. You can change that later from GitHub if you want.</p>
  <button type="submit">Create project</button>
</form>`);
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — this task adds no new automated tests (Express route, per the file's convention); confirming the import and new code don't break anything else.

- [ ] **Step 5: Commit**

```bash
git add api/oauth-server.js
git commit -m "feat: add the new-project creation form"
```

---

### Task 7: `POST /settings/new-project` — repo creation and its error paths

**Files:**
- Modify: `api/oauth-server.js` — add the POST route (repo-creation half only; Task 8 adds the init-wiring half)

**Interfaces:**
- Consumes: `newProjectPage`, `safeListOrgs` (Task 6); `slugifyProjectName`, `createRepo` (Tasks 1, 3).
- Produces: by the end of this task, submitting the form creates a repo or shows a scoped error; Task 8 adds what happens after a successful creation.

- [ ] **Step 1: Extend the import**

Replace the import Task 6 added:

```js
import { listUserOrgs } from '../src/adapters/github.js';
```

with:

```js
import { listUserOrgs, createRepo, slugifyProjectName } from '../src/adapters/github.js';
```

- [ ] **Step 2: Add the route, ending in a placeholder success response**

After the `GET /settings/new-project` route from Task 6, add:

```js
app.post('/settings/new-project', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings/signin?returnTo=/settings/new-project');

  const projectName = String(req.body?.projectName || '').trim();
  if (!projectName) {
    const orgs = await safeListOrgs(user.token);
    return res.status(400).send(newProjectPage({ user, orgs, error: 'Enter a project name.' }));
  }

  // Retry path: the repo already exists from a previous attempt whose
  // init step failed. Task 8's error page posts back here with these two
  // fields set, skipping straight to (re-)running init — no second
  // createRepo call, so this can't create a duplicate repo.
  const retryOwner = String(req.body?.repoOwner || '').trim();
  const retryRepo = String(req.body?.repoRepo || '').trim();

  let owner, repo;
  if (retryOwner && retryRepo) {
    owner = retryOwner;
    repo = retryRepo;
  } else {
    const org = String(req.body?.orgLogin || '').trim() || null;
    const name = slugifyProjectName(projectName);
    try {
      const created = await createRepo(user.token, { name, org, description: projectName });
      owner = created.owner;
      repo = created.repo;
    } catch (e) {
      const orgs = await safeListOrgs(user.token);
      if (e.code === 'REPO_EXISTS' || e.code === 'REPO_FORBIDDEN') {
        return res.status(e.code === 'REPO_EXISTS' ? 409 : 403).send(
          newProjectPage({ user, orgs, projectName, orgLogin: org, error: e.message }),
        );
      }
      return res.status(500).send(errorPage(e.message));
    }
  }

  // Task 8 replaces this with the GithubSession + initProject wiring.
  res.send(`repo created: ${owner}/${repo}`);
});
```

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no new automated tests for this route (matches file convention); confirms nothing else broke.

- [ ] **Step 4: Commit**

```bash
git add api/oauth-server.js
git commit -m "feat: create the repo on new-project form submission"
```

---

### Task 8: `POST /settings/new-project` — init wiring, success page, retry page

**Files:**
- Modify: `api/oauth-server.js` — replace Task 7's placeholder response; add two render functions

**Interfaces:**
- Consumes: `GithubSession` (`src/adapters/github.js`), `runWithSession` (`src/session-context.js`), `initProject` (`cli/commands/init.core.js`, with `sourceNote`'s `'web'` case from Task 4).
- Produces: the complete end-to-end flow — repo created, project initialized, connector URL shown; or, on an init failure, an idempotent retry form.

- [ ] **Step 1: Extend the imports**

Replace the import Task 7 set:

```js
import { listUserOrgs, createRepo, slugifyProjectName } from '../src/adapters/github.js';
```

with:

```js
import { GithubSession, listUserOrgs, createRepo, slugifyProjectName } from '../src/adapters/github.js';
```

And add two new import lines below it:

```js
import { runWithSession } from '../src/session-context.js';
import { initProject } from '../cli/commands/init.core.js';
```

- [ ] **Step 2: Replace the placeholder response**

Replace the last line of the Task 7 handler:

```js
  // Task 8 replaces this with the GithubSession + initProject wiring.
  res.send(`repo created: ${owner}/${repo}`);
```

with:

```js
  try {
    const session = new GithubSession({ owner, repo, ghToken: user.token });
    await session.prefetch();
    await runWithSession(session, () => initProject({
      project: projectName,
      me: user.name || user.login,
      source: 'web',
    }));
  } catch (e) {
    // Repo exists but isn't initialized. Don't strand the manager here —
    // give them a retry that skips straight back to this step, not a dead
    // end. No second createRepo call: owner/repo travel as hidden fields.
    return res.status(500).send(newProjectRetryPage({ owner, repo, projectName, error: e.message }));
  }

  res.send(newProjectSuccessPage({ owner, repo, baseUrl: baseUrlFor(req) }));
```

- [ ] **Step 3: Add the two render functions**

Next to `newProjectPage` (Task 6):

```js
const newProjectSuccessPage = ({ owner, repo, baseUrl }) => shell('Project created', `
<h1>Your project is ready</h1>
<p><code>${esc(owner)}/${esc(repo)}</code> was created on GitHub and initialized for teamctx.</p>
<label>Paste this into Claude → Settings → Connectors → Add custom connector</label>
<input readonly value="${esc(baseUrl)}/api/mcp/${esc(owner)}/${esc(repo)}" onclick="this.select()">
<p class="muted">Then click Connect and approve the GitHub consent screen. Tools
appear right away — you can start adding tasks immediately.</p>`);

const newProjectRetryPage = ({ owner, repo, projectName, error }) => shell('Almost there', `
<h1>The repository was created, but setup didn't finish</h1>
<div class="bad">${esc(error)}</div>
<p><code>${esc(owner)}/${esc(repo)}</code> exists on GitHub. Try again — this
won't create a second repository.</p>
<form method="POST" action="/settings/new-project">
  <input type="hidden" name="repoOwner" value="${esc(owner)}">
  <input type="hidden" name="repoRepo" value="${esc(repo)}">
  <input type="hidden" name="projectName" value="${esc(projectName)}">
  <button type="submit">Try again</button>
</form>`);
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all tests from Tasks 1-4 still green, plus confirmation nothing else in the suite broke. This route itself still has no dedicated automated test (Task 9 covers it manually).

- [ ] **Step 5: Commit**

```bash
git add api/oauth-server.js
git commit -m "feat: initialize the new repo and show the connector URL"
```

---

### Task 9: End-to-end manual verification

**Files:** none (verification only — this is the step the spec calls out explicitly, since hosted-onboarding flows in this repo have previously only been caught broken by testing live, see issue #44).

- [ ] **Step 1: Deploy to a Vercel preview**

Push the branch and let Vercel build a preview deployment (or run locally against a real GitHub OAuth App + Upstash Redis per `docs/mcp-hosted-setup.md` if no preview pipeline is set up).

- [ ] **Step 2: Walk the happy path with a real, throwaway GitHub account**

1. Visit `<preview-url>/settings/new-project` while signed out → confirm redirect to sign-in → confirm GitHub OAuth consent screen appears → confirm landing back on `/settings/new-project` (not `/settings`) after approving.
2. Enter a project name with spaces/punctuation (e.g. "Test! Project #1") → submit with personal account selected.
3. Confirm a new private repo appears on the throwaway GitHub account, correctly slugged, with an initial commit.
4. Confirm the success page shows a connector URL of the form `<preview-url>/api/mcp/<login>/<slug>`.
5. Confirm `.teamctx/config.json` exists in the new repo with the typed project name (not the slug) as `project`.
6. Confirm the init commit message ends with `(via web onboarding)`.
7. Paste the connector URL into Claude → Settings → Connectors → Add custom connector, click Connect, approve. Confirm tools appear and `list_tasks` works against the new project.

- [ ] **Step 3: Walk the org path**

Repeat step 2 against a GitHub org the test account belongs to and has repo-creation rights in — confirm the org appears in the picker and the repo lands there.

- [ ] **Step 4: Walk the error paths**

1. Submit the same project name twice in a row (personal account) → confirm the 409 collision error, with the typed project name preserved in the form.
2. If a locked-down test org is available, attempt repo creation there → confirm the 403 error names the org.
3. Submit an empty project name → confirm the 400 error.

- [ ] **Step 5: Record the result**

If everything above passes, this plan is complete — update the plan file's tasks to checked and note in the PR description (or commit message, if pushing directly) that manual verification was performed against `<preview-url>` with a real GitHub account, per this task.

If anything fails, do **not** mark this task complete — open a new task (or, if the fix is small, fix it here) rather than shipping an unverified hosted-onboarding flow again.
