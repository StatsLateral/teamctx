import express from 'express';
import { randomBytes } from 'crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { providerFromEnv, oauthConfigStatus, GITHUB_SCOPES, OAuthCallbackError } from '../src/oauth/provider.js';
import { kvGet, kvSet, kvTake, kvDelete, keys, TTL, isPersistent } from '../src/oauth/kv.js';
import { googleAuthorizeUrl } from '../src/oauth/google.js';
import { primaryEmail } from '../src/oauth/github-identity.js';
import { lendDecision } from '../src/oauth/lend-decision.js';
import { GithubSession, listUserOrgs, createRepo, slugifyProjectName, suggestAvailableName, listPushableRepos } from '../src/adapters/github.js';
import { runWithSession } from '../src/session-context.js';
import { initProject } from '../cli/commands/init.core.js';

/**
 * Single Vercel function serving every OAuth surface. `vercel.json` rewrites
 * /.well-known/*, /authorize, /token, /register, /revoke, /oauth/* and
 * /settings here.
 *
 * Why an Express *app* rather than the router alone: `mcpAuthRouter` pulls in
 * express-rate-limit, which reads `req.ip` and `req.app`. Those only exist
 * once an Express app has enhanced the request — invoking the router directly
 * against raw Node objects throws ERR_ERL_UNDEFINED_IP_ADDRESS. An Express
 * app is itself a (req, res) handler, so it drops straight into Vercel's
 * function signature. Verified by spike, 2026-08-04.
 */

const provider = providerFromEnv();

const app = express();
// Hop count, not `true` — express-rate-limit rejects blanket trust with
// ERR_ERL_PERMISSIVE_TRUST_PROXY because it makes IP limiting bypassable.
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));

function baseUrlFor(req) {
  if (process.env.TEAMCTX_BASE_URL) return process.env.TEAMCTX_BASE_URL.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}

// ---- Home ------------------------------------------------------------

/**
 * Somewhere for a first-time visitor to land.
 *
 * There was no `/` route at all — every path started at `/settings`, which
 * assumes you already know what teamctx is and that you have a repository. A
 * manager sent the deployment URL had nowhere to arrive.
 *
 * The page is the whole funnel in one place on purpose: what this is, then the
 * five steps in order, then one button. Somebody who wants to know what they
 * are signing into can read it; somebody who already knows clicks Start.
 */
app.get('/', async (req, res) => {
  const user = await currentUser(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Somebody who already set a project up is not here to read the explainer.
  // Their projects are the two lists they configured — there is no per-project
  // settings page, so every one of them links to the same place.
  const projects = user
    ? [...new Set([
        ...((await kvGet(keys.sharedProjects(user.id)))?.projects || []),
        ...((await kvGet(keys.lentProjects(user.id)))?.projects || []),
      ])].sort()
    : [];
  res.send(homePage({ user, projects }));
});

// ---- Health / config check -------------------------------------------
// Handy for confirming a deploy has its env vars before touching Claude.

app.get('/oauth/status', async (req, res) => {
  const cfg = oauthConfigStatus();

  // Actually round-trip the store. Env vars being *present* says nothing about
  // whether the URL and token are correct, and a store that silently fails at
  // runtime shows up as baffling redirect loops rather than a clear error.
  let kvReachable = false;
  let kvError = null;
  if (isPersistent()) {
    const probe = `teamctx:healthcheck:${Date.now()}`;
    try {
      await kvSet(probe, { ok: true }, { ttlSeconds: 60 });
      kvReachable = (await kvGet(probe))?.ok === true;
      await kvTake(probe);
    } catch (e) {
      kvError = e.message?.slice(0, 200) ?? String(e);
    }
  }

  res.json({
    oauthConfigured: provider !== null,
    kvConfigured: isPersistent(),
    kvReachable,
    ...(kvError ? { kvError } : {}),
    missing: Object.entries({ ...cfg, kv: isPersistent() })
      .filter(([, present]) => !present)
      .map(([name]) => name),
  });
});

// ---- Protected Resource Metadata (RFC 9728) --------------------------
// Must be served per-MCP-path: the `resource` field has to match the URL the
// user typed into Claude *exactly*, path component included. Registered ahead
// of mcpAuthRouter so our dynamic version wins.

app.get('/.well-known/oauth-protected-resource/*splat', (req, res) => {
  const base = baseUrlFor(req);
  const mcpPath = req.path.replace('/.well-known/oauth-protected-resource', '');
  res.json({
    resource: `${base}${mcpPath}`,
    authorization_servers: [base],
    scopes_supported: ['mcp:tools'],
    resource_name: 'teamctx',
    bearer_methods_supported: ['header'],
  });
});

// ---- Which account do you have? ---------------------------------------

/**
 * The fork in the road for a team member.
 *
 * Most people invited to a teamctx project have no GitHub account — GitHub is
 * where the project is stored, not who they are. Redirecting straight to GitHub
 * made "get a GitHub account" the first step of joining, which is the blocker
 * this page exists to remove.
 */
app.get('/oauth/choose', (req, res) => {
  const state = String(req.query.state || '');
  if (!state) return res.status(400).send(errorPage('Missing state parameter.'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(choosePage(state));
});

app.get('/oauth/choose/github', (req, res) => {
  const state = String(req.query.state || '');
  if (!state || !provider) return res.status(400).send(errorPage('Missing state parameter.'));
  res.redirect(provider.githubAuthorizeUrl(state));
});

app.get('/oauth/choose/google', (req, res) => {
  const state = String(req.query.state || '');
  if (!state) return res.status(400).send(errorPage('Missing state parameter.'));
  if (!provider?.googleClientId) {
    return res.status(503).send(errorPage('Google sign-in is not configured on this deployment.'));
  }
  res.redirect(googleAuthorizeUrl({
    clientId: provider.googleClientId,
    redirectUri: provider.googleCallbackUrl,
    state,
  }));
});

// ---- Google callback --------------------------------------------------

app.get('/oauth/google/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (!state) return res.status(400).send(errorPage('Missing state parameter.'));
  if (!provider) return res.status(500).send(errorPage('OAuth is not configured on this deployment.'));
  try {
    const redirectTo = await provider.handleGoogleCallback({
      code: code ? String(code) : null,
      state: String(state),
      error: error ? String(error) : null,
      errorDescription: errorDescription ? String(errorDescription) : null,
    });
    return res.redirect(redirectTo);
  } catch (e) {
    return res.status(400).send(errorPage(e.message));
  }
});

// ---- GitHub callback --------------------------------------------------
// Serves both flows: the MCP authorization flow and the settings-page login.

app.get('/oauth/github/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (!state) return res.status(400).send(errorPage('Missing state parameter.'));

  // Settings-page login carries its own pending record.
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

  // Otherwise it's the MCP flow.
  if (!provider) return res.status(500).send(errorPage('OAuth is not configured on this deployment.'));
  try {
    const redirectTo = await provider.handleGithubCallback({
      code: code ? String(code) : undefined,
      state: String(state),
      error: error ? String(error) : undefined,
      errorDescription: errorDescription ? String(errorDescription) : undefined,
    });
    return res.redirect(redirectTo);
  } catch (e) {
    const msg = e instanceof OAuthCallbackError ? e.message : 'Authorization failed.';
    return res.status(400).send(errorPage(msg));
  }
});

async function loginViaGithub(code, baseUrl) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${baseUrl}/oauth/github/callback`,
    }),
  });
  const body = await tokenRes.json().catch(() => ({}));
  if (!body.access_token) throw new Error(body.error_description || 'GitHub token exchange failed.');

  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${body.access_token}`, Accept: 'application/vnd.github+json' },
  });
  if (!userRes.ok) throw new Error('Could not read your GitHub profile.');
  const user = await userRes.json();
  // The token rides along so sharing a key can check the sharer actually works
  // on the repo they name. Same posture as the MCP flow, which already parks a
  // GitHub token in KV against a bearer token; this one is behind an httpOnly
  // cookie and expires with the session.
  return {
    id: String(user.id), login: user.login, name: user.name ?? null,
    email: user.email ? String(user.email).toLowerCase() : await primaryEmail(body.access_token),
    token: body.access_token,
  };
}

// ---- Settings page: set the AI provider key --------------------------

function readSessionId(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)teamctx_sid=([^;]+)/);
  return match ? match[1] : null;
}

async function currentUser(req) {
  const sid = readSessionId(req);
  if (!sid) return null;
  return await kvGet(keys.session(sid));
}

app.get('/settings', async (req, res) => {
  const user = await currentUser(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Signed out renders a sign-in page rather than redirecting straight to
  // GitHub. GitHub re-approves an already-authorised app without prompting,
  // so an automatic redirect here would sign the user back in the instant
  // they landed — making "signed out" a state you could never actually see.
  if (!user) return res.send(signInPage());

  const existing = await kvGet(keys.aiKey(user.id));
  const shared = (await kvGet(keys.sharedProjects(user.id)))?.projects || [];
  // A dropdown instead of free text: nobody should have to remember the exact
  // spelling of a repository they already chose once.
  const repos = user.token ? await listPushableRepos(user.token) : [];
  const lent = (await kvGet(keys.lentProjects(user.id)))?.projects || [];
  res.send(settingsPage({
    user, hasKey: !!existing, shared, lent, repos,
    saved: req.query.saved === '1',
    error: req.query.error ? String(req.query.error) : null,
  }));
});

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
  res.send(newProjectPage({ user, orgs, repos: await listPushableRepos(user.token) }));
});

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

  // Somebody who already has a repository should not be made to create a
  // second one. It is the same path the retry uses — skip creation, run init —
  // so the only new thing here is where owner/repo came from.
  const existing = parseRepoRef(req.body?.existingRepo);

  let owner, repo;
  if (existing) {
    owner = existing.owner;
    repo = existing.repo;
  } else if (retryOwner && retryRepo) {
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
      // GitHub's own wording here is accurate and useless to the person reading
      // it: they asked for a project name, not a repository, and "name already
      // exists on this account" is not something they can act on. Say what
      // happened in their terms, and where we can, hand them a name that works.
      if (e.code === 'REPO_EXISTS') {
        const where = org || user.login;
        const suggestion = await suggestAvailableName(user.token, { name, owner: where });
        return res.status(409).send(newProjectPage({
          user, orgs, projectName, orgLogin: org,
          error: `${where} already has a project called "${name}". Pick a different name${suggestion ? '' : ', or somewhere else for it to live'}.`,
          suggestion,
        }));
      }
      if (e.code === 'REPO_FORBIDDEN') {
        return res.status(403).send(newProjectPage({
          user, orgs, projectName, orgLogin: org,
          error: org
            ? `You cannot create repositories in ${org}. Pick your personal account, or ask an owner of ${org} for access.`
            : 'GitHub would not let this account create a repository.',
        }));
      }
      return res.status(500).send(errorPage(e.message));
    }
  }

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
    if (existing && /already/i.test(e.message)) {
      const orgs = await safeListOrgs(user.token);
      return res.status(409).send(newProjectPage({
        user, orgs, projectName, repos: await listPushableRepos(user.token),
        error: `${owner}/${repo} is already a teamctx project. Open it from Settings, or pick a different repository.`,
      }));
    }
    return res.status(500).send(newProjectRetryPage({ owner, repo, projectName, error: e.message }));
  }

  res.send(newProjectSuccessPage({ owner, repo, baseUrl: baseUrlFor(req) }));
});

/**
 * Clear the browser session so the GitHub sign-in runs again. GitHub will
 * re-approve without prompting; to switch accounts entirely, revoke teamctx
 * under GitHub → Settings → Applications.
 */
app.post('/settings/logout', async (req, res) => {
  const sid = readSessionId(req);
  if (sid) await kvDelete(keys.session(sid));
  res.setHeader('Set-Cookie', 'teamctx_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect(303, '/settings');
});

/**
 * Note the explicit 303s. Express defaults `res.redirect` to 302, and a 302
 * (like a 307) may preserve the request method — behind Vercel's rewrite layer
 * these surface as 307, which makes the browser re-POST to the redirect
 * target. That turns Post/Redirect/Get into an infinite POST loop.
 * 303 See Other is the status that mandates a GET on the next hop.
 */
app.post('/settings', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');

  const apiKey = String(req.body?.apiKey || '').trim();
  const provider_ = String(req.body?.provider || 'anthropic').trim();

  if (apiKey === '__clear__') {
    await kvSet(keys.aiKey(user.id), null);
    return res.redirect(303, '/settings?saved=1');
  }
  if (!apiKey) {
    return res.status(400).send(errorPage('Paste a key, or leave the page.'));
  }
  await kvSet(keys.aiKey(user.id), { provider: provider_, apiKey });
  res.redirect(303, '/settings?saved=1');
});

/**
 * Can this person actually share a key with this project?
 *
 * Without the check the first person to name `owner/repo` owns that slot, and
 * nothing stops someone claiming a project they have never worked on — either
 * squatting it before the manager gets there or writing a dead key over a
 * working one. Push access is the same bar the project itself uses, and it
 * doubles as typo-catching: a misspelled repo fails here instead of quietly
 * storing a key nobody will ever read.
 */
async function canShareWith(token, owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return { ok: false, why: `No repository ${owner}/${repo}, or you cannot see it.` };
  if (!res.ok) return { ok: false, why: `GitHub said ${res.status} for ${owner}/${repo}.` };
  const body = await res.json().catch(() => ({}));
  if (!body?.permissions?.push) {
    return { ok: false, why: `You need write access to ${owner}/${repo} to share a key with it.` };
  }
  return { ok: true };
}

function parseRepoRef(raw) {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(String(raw || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

const backToSettings = (res, err) =>
  res.redirect(303, err ? `/settings?error=${encodeURIComponent(err)}` : '/settings?saved=1');

/** Share one key with everyone on a project. */
app.post('/settings/share', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');

  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Pick a project first.');

  // A provider shows a key once. Somebody who saved theirs here and no longer
  // has it to hand would otherwise be unable to share the very key they already
  // gave us — so reuse it rather than asking them to produce it again.
  let apiKey, provider_;
  if (req.body?.useMyKey) {
    const mine = await kvGet(keys.aiKey(user.id));
    if (!mine?.apiKey) {
      return backToSettings(res, 'You have no saved key to share — paste one below instead.');
    }
    apiKey = mine.apiKey;
    provider_ = mine.provider || 'anthropic';
  } else {
    apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey) return backToSettings(res, 'Paste the key to share.');
    provider_ = String(req.body?.provider || 'anthropic').trim();
  }

  const allowed = await canShareWith(user.token, ref.owner, ref.repo);
  if (!allowed.ok) return backToSettings(res, allowed.why);

  const slug = `${ref.owner}/${ref.repo}`;
  const existing = await kvGet(keys.projectAiKey(ref.owner, ref.repo));
  if (existing && existing.sharedById && existing.sharedById !== user.id) {
    return backToSettings(res, `${existing.sharedByLogin || 'Someone else'} already shares a key with ${slug}. They need to stop sharing first.`);
  }

  await kvSet(keys.projectAiKey(ref.owner, ref.repo), {
    provider: provider_, apiKey, sharedById: user.id, sharedByLogin: user.login,
  });
  const list = (await kvGet(keys.sharedProjects(user.id)))?.projects || [];
  if (!list.includes(slug)) {
    await kvSet(keys.sharedProjects(user.id), { projects: [...list, slug] });
  }
  backToSettings(res);
});

/** Stop sharing. The members who had no key of their own lose model tools. */
app.post('/settings/unshare', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Write the project as owner/repo.');

  const slug = `${ref.owner}/${ref.repo}`;
  const existing = await kvGet(keys.projectAiKey(ref.owner, ref.repo));
  // Only the person who put the key there can take it away; anyone else with
  // push access could otherwise drop a key that is not theirs.
  if (existing && existing.sharedById && existing.sharedById !== user.id) {
    return backToSettings(res, `That key was shared by someone else.`);
  }
  await kvSet(keys.projectAiKey(ref.owner, ref.repo), null);
  const list = (await kvGet(keys.sharedProjects(user.id)))?.projects || [];
  await kvSet(keys.sharedProjects(user.id), { projects: list.filter(p => p !== slug) });
  backToSettings(res);
});

/**
 * Lend the project a GitHub credential, so members without an account of their
 * own can act on it.
 *
 * Admin, not merely push: this hands a credential to everyone the roster names,
 * which is a decision about who works on the project rather than a change to
 * it. Whoever can already administer the repository is the person entitled to
 * make it.
 */
/**
 * May this person lend the project's GitHub access?
 *
 * The question teamctx actually cares about is "are you this project's
 * manager", not "do you hold a GitHub permission bit". So the manager gate in
 * the repo's own config.json is asked first: whoever ran `init` is the manager,
 * which for the common case — you set the project up, you own the repo — makes
 * this a step that simply passes instead of a second thing to go and arrange.
 *
 * Repository admin is the fallback for a project whose config has no manager
 * pinned yet. Lending hands a credential to everyone the roster names, so
 * without a manager recorded, the person who can administer the repository is
 * the one entitled to decide.
 */
async function mayLend(user, ref) {
  const headers = { Authorization: `Bearer ${user.token}`, Accept: 'application/vnd.github+json' };

  const repoRes = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers });
  if (repoRes.status === 401) {
    return { ok: false, why: 'GitHub rejected your sign-in. Sign out and sign in again.' };
  }
  if (repoRes.status === 404) {
    return { ok: false, why: `No repository ${ref.owner}/${ref.repo}, or your GitHub account cannot see it.` };
  }
  if (!repoRes.ok) {
    // Never fall through to a permissions message for a failure that was not
    // about permissions — a rate limit reads as "you are not allowed" otherwise.
    return { ok: false, why: `GitHub returned ${repoRes.status} for ${ref.owner}/${ref.repo}. Try again shortly.` };
  }
  const info = await repoRes.json().catch(() => ({}));

  const cfgRes = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/.teamctx/config.json`, { headers });
  if (cfgRes.status === 404) {
    return { ok: false, why: `${ref.owner}/${ref.repo} is not a teamctx project — no .teamctx/config.json in it.` };
  }
  let config = null;
  if (cfgRes.ok) {
    try {
      const body = await cfgRes.json();
      config = JSON.parse(Buffer.from(body.content || '', 'base64').toString('utf8'));
    } catch { /* unreadable config falls back to the admin check */ }
  }

  // The same shape resolveActor produces, so the manager gate is matched by the
  // one function that knows every form an identity takes.
  const actor = { key: `github:${user.id}`, name: user.name || user.login, login: user.login, source: 'github' };
  return lendDecision({ config, actor, isAdmin: !!info?.permissions?.admin, slug: `${ref.owner}/${ref.repo}` });
}

app.post('/settings/lend', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Write the project as owner/repo.');

  // A session minted before this feature shipped carries no token, and every
  // GitHub call below would 401. That surfaced as "you need admin access" to
  // someone who owned the repository, which is the worst kind of wrong error:
  // it names a cause the reader cannot act on and is not true.
  if (!user.token) {
    return backToSettings(res, 'Your sign-in predates this feature. Sign out and sign in again, then retry.');
  }

  const allowed = await mayLend(user, ref);
  if (!allowed.ok) return backToSettings(res, allowed.why);

  const slug = `${ref.owner}/${ref.repo}`;
  await kvSet(keys.projectGhCred(ref.owner, ref.repo), {
    token: user.token, lentById: user.id, lentByLogin: user.login,
  });
  const list = (await kvGet(keys.lentProjects(user.id)))?.projects || [];
  if (!list.includes(slug)) await kvSet(keys.lentProjects(user.id), { projects: [...list, slug] });
  backToSettings(res);
});

/** Stop lending. Members without a GitHub account lose access immediately. */
app.post('/settings/unlend', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Write the project as owner/repo.');

  const existing = await kvGet(keys.projectGhCred(ref.owner, ref.repo));
  if (existing?.lentById && existing.lentById !== user.id) {
    return backToSettings(res, 'That access was lent by someone else.');
  }
  await kvSet(keys.projectGhCred(ref.owner, ref.repo), null);
  const list = (await kvGet(keys.lentProjects(user.id)))?.projects || [];
  await kvSet(keys.lentProjects(user.id), { projects: list.filter(p => p !== `${ref.owner}/${ref.repo}`) });
  backToSettings(res);
});

// ---- The SDK's OAuth server: metadata, /authorize, /token, /register --

if (provider) {
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(process.env.TEAMCTX_BASE_URL
      || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`),
    scopesSupported: ['mcp:tools'],
    resourceName: 'teamctx',
  }));
} else {
  for (const path of ['/authorize', '/token', '/register', '/revoke',
                      '/.well-known/oauth-authorization-server']) {
    app.all(path, (_req, res) => res.status(503).json({
      error: 'oauth_not_configured',
      error_description: 'This deployment is missing GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET. See /oauth/status.',
    }));
  }
}

// ---- Minimal HTML ------------------------------------------------------

const esc = (v) => String(v).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const shell = (title, body, { wide = false } = {}) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — teamctx</title><style>
:root{color-scheme:light dark;--accent:#2f6feb;--line:#8883;--dim:#888}
@media(prefers-color-scheme:dark){:root{--accent:#6ea8fe}}
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;line-height:1.55}
body.wide{max-width:60rem}
h1{font-size:1.25rem;margin-bottom:.25rem}
h2{font-size:1rem;margin:0 0 .3rem}
/* Sections were three stacked h1s separated by rules, which reads as one long
   document rather than as things you can act on one at a time. */
.card{border:1px solid var(--line);border-radius:.6rem;padding:1.15rem 1.3rem;margin:0 0 1.1rem;break-inside:avoid}
.cols{margin-top:1.25rem}
@media(min-width:52rem){.cols{columns:2;column-gap:1.1rem}}
.bar{display:flex;align-items:center;gap:1.1rem;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:.7rem;margin-bottom:1.5rem;font-size:.9rem}
.bar .brand{font-weight:600;color:inherit;text-decoration:none;margin-right:.4rem}
.bar a{text-decoration:none;padding:.2rem 0;border-bottom:2px solid transparent}
.bar a:hover{border-bottom-color:var(--line)}
/* Saying which page you are on, rather than leaving every link identical. */
.bar a.on{color:inherit;font-weight:600;border-bottom-color:var(--accent)}
/* Who you are belongs at the edge of the column, away from the things you do. */
.bar .who{margin-left:auto;padding-left:1.1rem;border-left:1px solid var(--line)}
/* Three different things sat side by side looking identical: a link that goes
   somewhere, an action that makes something, and who you are. */
/* A <button> inside an <a> is invalid, and browsers render the pair as one
   stretched control with whatever follows crowding it. */
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:.6rem 1.4rem;border-radius:.4rem}
.btn:hover{filter:brightness(1.08)}
.actions{display:flex;align-items:center;gap:1.25rem;margin-top:2rem}
.bar h1{margin:0}
.card label:first-of-type{margin-top:.75rem}
.card button[type=submit]{margin-top:1rem}
p{color:#666;margin-top:0}
label{display:block;font-weight:500;margin:1.25rem 0 .35rem}
input,select{width:100%;box-sizing:border-box;padding:.6rem .7rem;font-size:1rem;border:1px solid var(--line);border-radius:.4rem;background:Field;color:FieldText}
/* The popup list is painted by the OS. A transparent select opted out of the
   colour scheme, which rendered that list white-on-white. */
option{background:Field;color:FieldText}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
button{margin-top:1.25rem;background:var(--accent);color:#fff;border:0;padding:.6rem 1.4rem;font-size:1rem;border-radius:.4rem;cursor:pointer}
button:hover{filter:brightness(1.08)}
a{color:var(--accent)}
.ok{background:#e8f5e9;color:#1b5e20;padding:.6rem .8rem;border-radius:.4rem;margin:1rem 0}
.muted{font-size:.85rem;color:#888}
.bad{background:#fdecea;color:#8b1a10;padding:.6rem .8rem;border-radius:.4rem;margin:1rem 0}
@media(prefers-color-scheme:dark){.ok{background:#1b3a1e;color:#c8e6c9}.bad{background:#3a1b18;color:#f5c6c2}}
button.link{background:none;border:0;padding:0;margin:0;color:var(--dim);
  font-size:.85rem;text-decoration:underline;cursor:pointer}
code{background:#8881;padding:.1rem .3rem;border-radius:.2rem}
</style></head><body${wide ? ' class="wide"' : ''}>${body}</body></html>`;

const settingsPage = ({ user, hasKey, saved, error, shared = [], lent = [], repos = [] }) => shell('Settings', `
${navBar({ user, current: '/settings' })}
<h1>Settings</h1>
${saved ? '<div class="ok">Saved.</div>' : ''}
${error ? `<div class="bad">${esc(error)}</div>` : ''}

<div class="cols">
<section class="card">
<h2>Your AI key</h2>
<p class="muted">Used only by the tools that call a model. Stored against your
GitHub account, never written to your repo.</p>
<form method="POST" action="/settings">
  <label for="provider">Provider</label>
  <select id="provider" name="provider">
    <option value="anthropic">Anthropic</option>
    <option value="openai">OpenAI</option>
    <option value="gemini">Google Gemini</option>
  </select>
  <label for="apiKey">API key${hasKey ? ' (a key is already saved — entering one replaces it)' : ''}</label>
  <input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" required>
  <button type="submit">Save</button>
</form>

</section>

<section class="card">
<h2>Share a key with a project</h2>
<p class="muted">Used by anyone on the project who has no key of their own. Never
overrides someone's own key. You pay for what the project spends.</p>
${shared.length ? `<p class="muted">Sharing a key with:</p>${shared.map(slug => `
<form method="POST" action="/settings/unshare" style="margin:.35rem 0">
  <input type="hidden" name="project" value="${esc(slug)}">
  <code>${esc(slug)}</code>
  <button type="submit" class="link">Stop sharing</button>
</form>`).join('')}` : ''}
<form method="POST" action="/settings/share">
  <label for="project">Project</label>
  ${projectPicker('project', repos)}
${hasKey ? `
  <label style="font-weight:400;margin-top:1rem">
    <input type="checkbox" name="useMyKey" value="1" checked
           onchange="document.getElementById('shareKeyFields').hidden = this.checked"
           style="width:auto;margin-right:.4rem">
    Share the key I already saved above
  </label>
  <p class="muted">A provider shows a key once. If you no longer have it to hand,
  this is the way to share it.</p>` : ''}
  <div id="shareKeyFields"${hasKey ? ' hidden' : ''}>
    <label for="shareProvider">Provider</label>
    <select id="shareProvider" name="provider">
      <option value="anthropic">Anthropic</option>
      <option value="openai">OpenAI</option>
      <option value="gemini">Google Gemini</option>
    </select>
    <label for="shareKey">API key to share</label>
    <input id="shareKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…">
  </div>
  <button type="submit">Share with project</button>
</form>

</section>

<section class="card">
<h2>Let members join without GitHub</h2>
<p class="muted">Lets people on the roster sign in with Google instead of GitHub,
using the email you invited. Their work is committed under their own name and
still comes to you for review. Roster only, this repository only.</p>
${lent.length ? `<p class="muted">Lending access to:</p>${lent.map(slug => `
<form method="POST" action="/settings/unlend" style="margin:.35rem 0">
  <input type="hidden" name="project" value="${esc(slug)}">
  <code>${esc(slug)}</code>
  <button type="submit" class="link">Stop lending</button>
</form>`).join('')}` : ''}
<form method="POST" action="/settings/lend">
  <label for="lendProject">Project</label>
  ${projectPicker('lendProject', repos)}
  <button type="submit">Lend GitHub access</button>
</form>
</section>
</div>`, { wide: true });

const choosePage = (state) => shell('Connect', `
<h1>Connect to teamctx</h1>
<p>How do you sign in?</p>
<p><a href="/oauth/choose/google?state=${encodeURIComponent(state)}">
  <button type="button">Continue with Google</button></a></p>
<p><a href="/oauth/choose/github?state=${encodeURIComponent(state)}">
  <button type="button">Continue with GitHub</button></a></p>
<p class="muted">Use Google if someone invited you to a project by email — sign
in with that same address. Use GitHub if you work on the repository directly.</p>`);

/**
 * Pick a project rather than spell one.
 *
 * Falls back to a text field when the listing failed or is empty — a dropdown
 * with nothing in it is worse than the field it replaced.
 */
const projectPicker = (id, repos) => (repos.length
  // A `select` only jumps to the first letter, so finding one repo among
  // dozens means scrolling. A datalist filters on any part of what you type,
  // and still accepts a name that is not in the list — which matters, since the
  // listing is capped and can miss one.
  ? `<input list="${id}-list" id="${id}" name="project" placeholder="Type to search, or paste owner/repo"
           autocomplete="off" required>
     <datalist id="${id}-list">
       ${repos.map(r => `<option value="${esc(r.fullName)}">`).join('')}
     </datalist>`
  : `<input id="${id}" name="project" placeholder="owner/repo" required>`);

/**
 * The same navigation on every page, saying where you are.
 *
 * Each page carried its own header, so the links differed by page and none of
 * them told you which one you were looking at. Signed out, only what is
 * reachable is shown — offering Settings to somebody who cannot open it is a
 * dead end dressed as a choice.
 */
const navBar = ({ user, current }) => {
  const link = (href, label) => (href === current
    ? `<a href="${href}" class="on" aria-current="page">${label}</a>`
    : `<a href="${href}">${label}</a>`);
  return `<nav class="bar">
  <a href="/" class="brand">teamctx</a>
  ${link('/', 'Home')}
  ${user ? link('/settings', 'Settings') : ''}
  ${user ? link('/settings/new-project', 'New project') : ''}
  <span class="who muted">${user ? `${esc(user.login)}
      <form method="POST" action="/settings/logout" style="display:inline;margin:0">
        <button type="submit" class="link">Sign out</button>
      </form>` : '<a href="/settings/signin">Sign in</a>'}</span>
</nav>`;
};

const homePage = ({ user, projects = [] }) => shell('teamctx', `
${navBar({ user, current: '/' })}
<h1>teamctx</h1>
<p>Version control for the context behind your team's work: <strong>why</strong>
you decided something, <strong>what</strong> that requires, and <strong>how</strong>
it gets done. Kept in your own git repository, and handed to each person's AI
assistant as the slice their role needs. Nothing to install. Nobody has to learn
a new tool.</p>

<h2 style="font-size:1rem;margin-top:2rem">How it works</h2>
<ol style="line-height:1.9;padding-left:1.2rem">
  <li><strong>Sign in with GitHub.</strong> Only the person setting the project
    up needs an account.</li>
  <li><strong>Point it at a project.</strong> Create a new private repository,
    or use one you already have.</li>
  <li><strong>Add your AI key.</strong> One key. Share it with the project and
    your team can use it too.</li>
  <li><strong>Connect your assistant.</strong> Paste one URL into Claude,
    ChatGPT or whatever you use.</li>
  <li><strong>Invite your team.</strong> They sign in with Google and start
    working — no GitHub account needed.</li>
</ol>

<p>From there it is a loop, not a setup wizard: your team pulls the current
context and their tasks, sends work back, and you review it on your own
cadence.</p>

<p class="actions">
  <a class="btn" href="${user ? '/settings/new-project' : '/settings/signin'}">${user ? 'Create a new project' : 'Start here'}</a>
</p>
${user ? '' : '<p class="muted">Signing in creates nothing on its own — you choose the project on the next screen.</p>'}
${user && projects.length ? `
<h2 style="font-size:1rem;margin-top:2rem">Your projects</h2>
<p class="muted">Keys and access are set per project, all from one page.</p>
<ul style="line-height:1.9;padding-left:1.2rem">
  ${projects.map(p => `<li><code>${esc(p)}</code></li>`).join('')}
</ul>` : ''}
${user ? `<p class="muted" style="margin-top:2rem">Signed in as <strong>${esc(user.login)}</strong>.</p>` : ''}`);

const newProjectPage = ({ user, orgs, projectName = '', orgLogin = '', error = null, suggestion = null, repos = [] }) => shell('New project', `
${navBar({ user, current: '/settings/new-project' })}
<h1>Create a new teamctx project</h1>
<p>Signed in as <strong>${esc(user.login)}</strong>. This creates a new private
GitHub repository and sets it up for teamctx — nothing to install, nothing to
type in a terminal.</p>
${error ? `<div class="bad">${esc(error)}</div>` : ''}
${suggestion ? `<p class="muted"><code>${esc(suggestion)}</code> is free — click to use it:
  <button type="button" class="link" onclick="document.getElementById('projectName').value='${esc(suggestion)}'">use ${esc(suggestion)}</button></p>` : ''}
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
</form>
${repos.length ? `
<h2 style="margin-top:2.5rem">Or use a repository you already have</h2>
<p class="muted">teamctx adds a <code>.teamctx/</code> directory to it and leaves
everything else alone.</p>
<form method="POST" action="/settings/new-project">
  <label for="existingRepo">Repository</label>
  <input list="existing-list" id="existingRepo" name="existingRepo"
         placeholder="Type to search, or paste owner/repo" autocomplete="off" required>
  <datalist id="existing-list">
    ${repos.map(r => `<option value="${esc(r.fullName)}">`).join('')}
  </datalist>
  <label for="existingName">Project name</label>
  <input id="existingName" name="projectName" placeholder="Q3 GTM Strategy" required>
  <button type="submit">Set it up</button>
</form>` : ''}`);

const newProjectSuccessPage = ({ owner, repo, baseUrl }) => shell('Project created', `
${navBar({ user: null, current: null })}
<h1>Your project is ready</h1>
<p><code>${esc(owner)}/${esc(repo)}</code> was created on GitHub and initialized for teamctx.</p>
<label>Paste this into your AI client as a custom connector</label>
<input readonly value="${esc(baseUrl)}/api/mcp/${esc(owner)}/${esc(repo)}" onclick="this.select()">
<p class="muted">Claude: Settings → Connectors → Add custom connector. Then
approve the GitHub consent screen.</p>

<h2 style="margin-top:2.5rem">Then, in that chat</h2>
<ol style="line-height:1.9;padding-left:1.2rem">
  <li><strong>Tell it what the project is about.</strong> Paste from a
    conversation you have already had, if you have one — it does not need to be
    tidy, and you do not need to learn how teamctx stores it.</li>
  <li><strong>Ask it to turn that into tasks.</strong> It proposes the work; you
    keep what is right.</li>
  <li><strong>Invite whoever is doing it.</strong> By email — they sign in with
    Google, no GitHub account needed.</li>
  <li><strong>Review what comes back.</strong> Their work queues for you rather
    than landing, and you clear it on your own cadence.</li>
</ol>
<p class="muted">That last pair is the loop, not the end of setup: they keep
pulling the current context and sending work back, you keep reviewing.</p>

<p class="actions"><a class="btn" href="/settings">Add your AI key</a>
  <a href="/">Home</a></p>
<p class="muted">The model-backed tools need one. Share it with the project and
your team can use it too.</p>`);

const newProjectRetryPage = ({ owner, repo, projectName, error }) => shell('Almost there', `
${navBar({ user: null, current: null })}
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

const signInPage = () => shell('Sign in', `
${navBar({ user: null, current: '/settings' })}
<h1>Sign in</h1>
<p>Sign in with GitHub to set the API key used by the teamctx tools that call
a model.</p>
<p class="actions"><a class="btn" href="/settings/signin">Sign in with GitHub</a></p>
<p class="muted">GitHub will not prompt you again if you have already
authorised teamctx. To sign in as a different account, revoke teamctx under
<a href="https://github.com/settings/applications" target="_blank" rel="noreferrer">GitHub &rarr; Authorized OAuth Apps</a> first.</p>`);

const errorPage = (message) => shell('Error', `
${navBar({ user: null, current: null })}
<h1>Something went wrong</h1>
<p>${String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
<p class="muted">Nothing was changed. <a href="/">Back to the start</a>.</p>`);

// An Express app is already a (req, res) handler — exactly Vercel's shape.
export default (req, res) => app(req, res);
export { app };
