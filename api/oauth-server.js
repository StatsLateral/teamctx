import express from 'express';
import { randomBytes } from 'crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { providerFromEnv, oauthConfigStatus, GITHUB_SCOPES, OAuthCallbackError } from '../src/oauth/provider.js';
import { kvGet, kvSet, kvTake, kvDelete, keys, TTL, isPersistent } from '../src/oauth/kv.js';
import { googleAuthorizeUrl, googleUserFromCode } from '../src/oauth/google.js';
import { projectKeyDecision } from '../src/oauth/project-key-decision.js';
import { managersOf } from '../src/managers.js';
import { matchesActor, managerKeys } from '../src/review.js';
import { readConfigJson } from '../src/oauth/member-access.js';
import {
  readPersonalKey, writePersonalKey, addProjectKey, removeProjectKey, projectsKeyedBy,
  adoptGithubRecords, linkGithubIdentity, projectsKnownFor, recordConnectedProject,
} from '../src/oauth/ai-keys.js';
import { primaryEmail } from '../src/oauth/github-identity.js';
import { lendDecision } from '../src/oauth/lend-decision.js';
import { GithubSession, listUserOrgs, createRepo, slugifyProjectName, suggestAvailableName, listPushableRepos } from '../src/adapters/github.js';
import { runWithSession } from '../src/session-context.js';
import { initProject } from '../cli/commands/init.core.js';
import { readProjectView, ProjectViewError } from '../src/oauth/project-view.js';
import { TOOLS, callTool } from '../mcp/server.js';
import { isReturnable, parseViewParams } from '../src/view-url.js';
import { parseProjectRef } from '../src/project-ref.js';
// Page templates. They used to sit at the bottom of this file, which left it
// mostly HTML with the routes buried in it — see #103 part 1.
import { settingsPage } from '../src/views/settings.js';
import { projectsPage } from '../src/views/projects.js';
import { projectPage } from '../src/views/project.js';
import { choosePage, signInPage, lendsNothing } from '../src/views/connect.js';
import { homePage } from '../src/views/home.js';
import { newProjectPage, newProjectSuccessPage, newProjectRetryPage } from '../src/views/new-project.js';
import { errorPage } from '../src/views/error.js';
import { addAgent, removeAgent, MemberNotFoundError } from '../cli/commands/member.core.js';
import {
  createAgentToken, listAgents, revokeAgent, projectsWithAgentsBy,
  setAgentKey, clearAgentKey, agentKeyStatus,
} from '../src/oauth/agent-tokens.js';
import { verifyProviderKey } from '../src/oauth/manager-checks.js';

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
        ...(await projectsKeyedBy({ email: user.email, githubId: user.id })),
        ...(user.id ? (await kvGet(keys.lentProjects(user.id)))?.projects || [] : []),
        ...(await projectsKnownFor(user.email)),
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
    // Google is optional, so its absence is a note rather than something
    // missing — but it has to be visible, since without it the sign-in chooser
    // silently never appears.
    googleSignIn: cfg.googleClientId && cfg.googleClientSecret
      ? 'enabled'
      : 'not configured — sign-in goes straight to GitHub',
    missing: Object.entries({ ...cfg, kv: isPersistent() })
      .filter(([name, present]) => !present && !name.startsWith('google'))
      .map(([name]) => name),
    // Which code is actually answering, so "it is deployed" stops being a
    // belief. Three rounds went into whether a missing field in a tool result
    // was a bug in the code or a build that predated it, and nothing served by
    // this deployment could say. The commit is what Vercel puts in the
    // environment; `features` is read off the running code itself, so it cannot
    // drift from it.
    build: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null,
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      features: deployedFeatures(),
    },
  });
});

/**
 * What the code answering this request can do, asked of the code.
 *
 * Not a hand-kept list: each entry is a real check against a module that is
 * loaded here, so it says what is running rather than what was intended. A
 * client missing `viewUrl` can be told in one request whether the server it
 * reached has it at all.
 */
function deployedFeatures() {
  return {
    // The tools that hand back a link to the web view, and the floor under them.
    viewLinks: TOOLS.filter(t => /viewUrl/.test(t.description || '')).map(t => t.name),
    viewLinkFloor: typeof callTool === 'function' && /stampViewUrl/.test(String(callTool)),
  };
}

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
app.get('/oauth/choose', async (req, res) => {
  const state = String(req.query.state || '');
  if (!state) return res.status(400).send(errorPage('Missing state parameter.'));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Which project this connection is for, and whether it can accept a Google
  // sign-in at all. Google members reach a project only through the GitHub
  // access it lends, so offering that button on a project that lends none sends
  // somebody through a sign-in that ends in a refusal.
  const pending = await kvGet(keys.pending(state));
  const project = /\/mcp\/([^/]+)\/([^/?#]+)/.exec(String(pending?.resource || ''));
  const lends = project
    ? !!(await kvGet(keys.projectGhCred(project[1], project[2])))?.token
    : true;   // Nothing to go on: offer both rather than hide a way in.
  res.send(choosePage({
    state,
    project: project ? `${project[1]}/${project[2]}` : null,
    google: !!provider?.googleClientId && lends,
    lends,
  }));
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

  // Settings-page sign-in carries its own pending record, the same way the
  // GitHub callback tells the two flows apart. Same redirect URI as the connector
  // flow, so no second Google client has to be registered.
  const settingsPending = await kvTake(keys.pending(`settings-google:${state}`));
  if (settingsPending) {
    if (error) return res.status(400).send(errorPage(`Google returned: ${error}`));
    try {
      const googleUser = await googleUserFromCode({
        code: String(code),
        clientId: provider.googleClientId,
        clientSecret: provider.googleClientSecret,
        redirectUri: provider.googleCallbackUrl,
      });
      // No GitHub id and no token: somebody signed in this way can manage keys
      // stored by their address, and nothing that needs a GitHub credential.
      const sid = randomBytes(24).toString('base64url');
      await kvSet(keys.session(sid), {
        id: null, login: null, name: googleUser.name, email: googleUser.email, token: null, source: 'google',
      }, { ttlSeconds: TTL.session });
      res.setHeader('Set-Cookie',
        `teamctx_sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL.session}`);
      return res.redirect(303, settingsPending.returnTo || '/settings');
    } catch (e) {
      return res.status(400).send(errorPage(e.message));
    }
  }
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
      // Here, not when some later page happens to render: this is the moment
      // GitHub hands over a verified address for the account signing in, and a
      // project made in the next five minutes is gated on that account.
      try {
        await linkGithubIdentity({ email: githubUser.email, githubId: githubUser.id });
      } catch { /* best effort — never block a sign-in on it */ }
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

  // Signed out goes to the sign-in screen, never straight to a provider.
  // GitHub re-approves an already-authorised app without prompting, so a
  // redirect into GitHub here would sign the user back in the instant they
  // landed — making "signed out" a state you could never actually see.
  if (!user) return signInFor(res, '/settings');
  await renderSettings(req, res, user);
});

/**
 * The settings page, with whatever a POST needs to show once.
 *
 * Shared so a freshly issued agent token can be rendered into the page instead
 * of carried through a redirect, where it would sit in the address bar and the
 * browser's history.
 */
async function renderSettings(req, res, user, { newAgent = null } = {}) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // A GitHub sign-in is the one place both the id and the address are known, so
  // it is where records saved under the id are carried over to the address —
  // after which a Google sign-in with the same address finds them too.
  if (user.id && user.email) {
    try { await adoptGithubRecords({ email: user.email, githubId: user.id, githubLogin: user.login }); } catch { /* best effort */ }
  }
  const existing = await readPersonalKey({ email: user.email, githubId: user.id });
  const shared = await projectsKeyedBy({ email: user.email, githubId: user.id });
  // A dropdown instead of free text: nobody should have to remember the exact
  // spelling of a repository they already chose once. A Google sign-in has no
  // repository list, so it is offered the projects that address is known to be
  // on — connected to, added a key to, or lent access to.
  const repos = user.token
    ? await listPushableRepos(user.token)
    : (await projectsKnownFor(user.email)).map(fullName => ({ fullName, private: true }));
  const lent = [...new Set([
    ...(user.id ? (await kvGet(keys.lentProjects(user.id)))?.projects || [] : []),
    ...(user.email ? (await kvGet(keys.lentByAddress(user.email)))?.projects || [] : []),
  ])].sort();
  const agents = await agentsFor(user);
  if (newAgent) res.setHeader('Cache-Control', 'no-store');
  res.send(settingsPage({
    user, hasKey: !!existing, shared, lent, repos, agents, newAgent,
    saved: req.query.saved === '1',
    rotated: req.query.rotated ? String(req.query.rotated).split(',').filter(Boolean) : [],
    error: req.query.error ? String(req.query.error) : null,
    confirmRemove: req.query.confirmRemove ? String(req.query.confirmRemove) : null,
  }));
}

/**
 * The agents on projects this person manages, among those they issued agents for
 * or are known to be on.
 */
async function agentsFor(user) {
  if (!user.email) return [];
  const projects = [...new Set([
    ...(await projectsWithAgentsBy(user.email)),
    ...(await projectsKnownFor(user.email)),
  ].map(p => p.toLowerCase()))].sort();
  const out = [];
  for (const slug of projects) {
    const [owner, repo] = slug.split('/');
    const list = await listAgents(owner, repo);
    if (!list.length) continue;
    // Only a manager sees a project's agents. The projects above are ones this
    // address is known to be on, and being on a project does not entitle
    // anyone to who issued its agents or which keys they run on.
    if (!(await agentManagerAccess(user, { owner, repo })).ok) continue;
    for (const agent of list) agent.key = await agentKeyStatus(agent.id);
    out.push({ project: slug, agents: list });
  }
  return out;
}

/**
 * Which ways in this destination has, and why any of them is shut.
 *
 * One answer, in one place, for every screen that offers a sign-in. The rule
 * used to be written three times — the home page and the settings pages
 * redirected straight into GitHub, the connector weighed up lent access — so
 * the same person met a different set of buttons depending on where they
 * landed, with nothing on screen to say why.
 */
const NEEDS_GITHUB = ['/settings/new-project'];

async function waysInFor(returnTo) {
  // The path alone. A link from a chat carries what it points at in the query
  // string, and reading that as part of the repository name asked whether
  // `ledger?ws=product` lends access — which nothing does, so Google was shut
  // off for every deep link.
  const path = String(returnTo || '').split('?')[0];
  if (!provider?.googleClientId) {
    return { google: false, why: 'Google sign-in is not set up on this deployment.' };
  }
  if (NEEDS_GITHUB.includes(path)) {
    return {
      google: false,
      why: 'Creating a project creates a GitHub repository, so that step needs a GitHub account.',
    };
  }
  // A project is reachable without GitHub only through the access it lends,
  // which is the connector's rule — applied here too, rather than sending
  // somebody through a sign-in that ends in a refusal.
  const project = /^\/project\/([^/]+)\/([^/]+)$/.exec(path);
  if (project && !(await kvGet(keys.projectGhCred(project[1], project[2])))?.token) {
    return { google: false, why: lendsNothing(`${project[1]}/${project[2]}`) };
  }
  return { google: true, why: null };
}

/**
 * The one screen that offers a sign-in.
 *
 * Every "Sign in" in the product leads here and nowhere else. It used to lead
 * to `/settings/signin`, which is not a screen at all — it is the GitHub
 * kickoff, a redirect to github.com — so a member invited by email was thrown
 * at an account they do not have, with no sign that another way in existed.
 */
app.get('/signin', async (req, res) => {
  const user = await currentUser(req);
  const requestedReturnTo = String(req.query.returnTo || '');
  const returnTo = RETURN_TO.test(requestedReturnTo) ? requestedReturnTo : null;
  // Somebody already signed in has nothing to do here.
  if (user) return res.redirect(303, returnTo || '/settings');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(signInPage({ returnTo, ways: await waysInFor(returnTo) }));
});

/** Starts a Google login for the settings page. Only reached by clicking it. */
app.get('/settings/signin/google', async (req, res) => {
  if (!provider?.googleClientId) {
    return res.status(503).send(errorPage('Google sign-in is not configured on this deployment.'));
  }
  const state = randomBytes(18).toString('base64url');
  const requestedReturnTo = String(req.query.returnTo || '');
  const returnTo = RETURN_TO.test(requestedReturnTo) ? requestedReturnTo : null;
  await kvSet(
    keys.pending(`settings-google:${state}`),
    returnTo ? { kind: 'settings', returnTo } : { kind: 'settings' },
    { ttlSeconds: TTL.pending },
  );
  res.redirect(googleAuthorizeUrl({
    clientId: provider.googleClientId,
    redirectUri: provider.googleCallbackUrl,
    state,
  }));
});

/** Starts the GitHub login. Only reached by clicking Sign in. */
app.get('/settings/signin', async (req, res) => {
  const state = randomBytes(18).toString('base64url');
  const requestedReturnTo = String(req.query.returnTo || '');
  const returnTo = RETURN_TO.test(requestedReturnTo) ? requestedReturnTo : null;
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
  if (!user) return signInFor(res, '/settings/new-project');
  // Creating a project creates a GitHub repository, so it needs a GitHub sign-in.
  if (!user.id) return backToSettings(res, 'Creating a project creates a GitHub repository, so it needs a GitHub sign-in.');
  const orgs = await safeListOrgs(user.token);
  res.send(newProjectPage({ user, orgs, repos: await listPushableRepos(user.token) }));
});

app.post('/settings/new-project', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return signInFor(res, '/settings/new-project');
  if (!user.id) return backToSettings(res, 'Creating a project creates a GitHub repository, so it needs a GitHub sign-in.');

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
      // The email, not the GitHub id, so the same person is recognised whether
      // they come back through GitHub or sign in with Google. Falls back to the
      // id only when the token would not reveal an address.
      managerKey: user.email ? `git:${user.email}` : `github:${user.id}`,
      // Recorded so a clone knows this project is used through the connector.
      // Without it the terminal took a web-created project for an undeployed one,
      // and let manager changes through without the checks only the server runs.
      deployUrl: baseUrlFor(req),
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

  // Keys are stored by verified email, so the same person finds them whether
  // they signed in with GitHub or Google. Without an address there is nothing
  // to store them under that another sign-in could ever find.
  if (!user.email) {
    return backToSettings(res, 'Your sign-in did not come with a verified email address, so there is nowhere to keep a key. Sign out and sign in again.');
  }
  if (apiKey === '__clear__') {
    await writePersonalKey({ email: user.email, githubId: user.id, apiKey: null });
    return res.redirect(303, '/settings?saved=1');
  }
  if (!apiKey) {
    return res.status(400).send(errorPage('Paste a key, or leave the page.'));
  }
  const saved = await writePersonalKey({
    email: user.email, githubId: user.id, githubLogin: user.login, provider: provider_, apiKey,
  });
  // Said out loud rather than done quietly: replacing a key also replaces the
  // copy every project it was shared with is running on, and somebody who is
  // not told will keep debugging a key they believe they already changed.
  const also = saved?.alsoUpdated || [];
  res.redirect(303, also.length
    ? `/settings?saved=1&rotated=${encodeURIComponent(also.join(','))}`
    : '/settings?saved=1');
});

/**
 * Is this person the primary manager of this project?
 *
 * Read with their own GitHub credential, or the project's lent one for a Google
 * sign-in. A project that cannot be read answers no: this only ever stands in
 * the way of removing a key, and a key is the person's own to remove.
 */
async function isPrimaryManager(user, ref) {
  const token = user.token || (await kvGet(keys.projectGhCred(ref.owner, ref.repo)))?.token;
  if (!token) return false;
  let config;
  try { config = await readConfigJson({ owner: ref.owner, repo: ref.repo, token }); } catch { return false; }
  const { primary } = managersOf(config);
  // Every form a manager can be written in. A primary stored by GitHub id — the
  // web flow writes that when a session revealed no address — was never matched
  // by address alone, and so was never warned.
  const actor = { key: user.id ? `github:${user.id}` : `git:${String(user.email).toLowerCase()}`,
    email: String(user.email || '').toLowerCase(), login: user.login || null };
  return !!primary && matchesActor(primary, actor);
}

/**
 * May this person add a key to this project?
 *
 * Anyone on the project — see src/oauth/project-key-decision.js for the rule.
 * This only gathers what it needs. A GitHub sign-in is checked for push access
 * as before, which also catches a misspelled repository before a key is stored
 * against it; failing that, and for a Google sign-in, the project's own settings
 * are read to find them on the gate or the roster.
 *
 * A Google sign-in has no GitHub credential of its own, so that read goes
 * through the access the project lends. A project that has not lent any cannot
 * be read on their behalf, and the answer says so rather than calling them a
 * stranger.
 */
async function mayAddProjectKey(user, ref) {
  const slug = `${ref.owner}/${ref.repo}`;
  let token = user.token;
  let hasPush = false;

  if (token) {
    const res = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return { ok: false, why: `No repository ${slug}, or you cannot see it.` };
    if (!res.ok) return { ok: false, why: `GitHub said ${res.status} for ${slug}.` };
    const body = await res.json().catch(() => ({}));
    hasPush = !!body?.permissions?.push;
  } else {
    const cred = await kvGet(keys.projectGhCred(ref.owner, ref.repo));
    if (!cred?.token) {
      return {
        ok: false,
        why: `${slug} has not lent GitHub access, so it cannot confirm people who signed in with Google. `
          + 'Ask its manager to lend access, or sign in with GitHub.',
      };
    }
    token = cred.token;
  }

  let config = null;
  if (!hasPush) {
    try { config = await readConfigJson({ owner: ref.owner, repo: ref.repo, token }); } catch { config = null; }
  }
  return projectKeyDecision({ config, email: user.email, hasPush, slug });
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
  if (!user.email) {
    return backToSettings(res, 'Your sign-in did not come with a verified email address, so a key added now could not be attributed to you. Sign out and sign in again.');
  }
  if (req.body?.useMyKey) {
    const mine = await readPersonalKey({ email: user.email, githubId: user.id });
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

  const allowed = await mayAddProjectKey(user, ref);
  if (!allowed.ok) return backToSettings(res, allowed.why);

  // One key per person, recorded against who added it. Nobody's key displaces
  // anyone else's any more; which one a project runs on is decided by who its
  // primary manager is, not by who got here first.
  await addProjectKey({
    owner: ref.owner, repo: ref.repo, email: user.email, provider: provider_, apiKey,
    githubId: user.id, githubLogin: user.login,
  });
  backToSettings(res);
});

/** Stop sharing. The members who had no key of their own lose model tools. */
app.post('/settings/unshare', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Write the project as owner/repo.');

  const slug = `${ref.owner}/${ref.repo}`;

  // Warned, not refused. The key is theirs to remove, but if they are the
  // primary manager the project runs on it, and everyone without a key of their
  // own loses the model the moment it goes. So the first attempt stops to say so,
  // and a second, deliberate one goes through.
  if (!req.body?.confirm && user.email && await isPrimaryManager(user, ref)) {
    return res.redirect(303, `/settings?confirmRemove=${encodeURIComponent(slug)}`);
  }

  // Only the person who added a key can take it away — keyed by their own
  // address, so there is no path to anybody else's.
  const removed = user.email
    ? await removeProjectKey({ owner: ref.owner, repo: ref.repo, email: user.email })
    : false;

  // The single shared record from before this change, if it is theirs.
  const legacy = await kvGet(keys.projectAiKey(ref.owner, ref.repo));
  const legacyIsMine = legacy?.sharedById && legacy.sharedById === user.id;
  if (legacyIsMine) {
    await kvSet(keys.projectAiKey(ref.owner, ref.repo), null);
    const list = (await kvGet(keys.sharedProjects(user.id)))?.projects || [];
    await kvSet(keys.sharedProjects(user.id), { projects: list.filter(p => p !== slug) });
  }
  if (!removed && !legacyIsMine) {
    return backToSettings(res, `You have not added a key to ${slug}.`);
  }
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
  // With the address: managers are identified by email, and without it a manager
  // who is not a repository admin was never matched — which refused the lead a
  // project is being handed to, exactly the person who has to lend.
  const actor = {
    key: `github:${user.id}`, name: user.name || user.login, login: user.login,
    email: user.email ? String(user.email).toLowerCase() : null, source: 'github',
  };
  return lendDecision({ config, actor, isAdmin: !!info?.permissions?.admin, slug: `${ref.owner}/${ref.repo}` });
}

app.post('/settings/lend', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Write the project as owner/repo.');

  // Lending hands the project a GitHub credential, which only a GitHub sign-in
  // has. Asked first: a Google sign-in has no token either, and telling them
  // their sign-in is out of date sends them round a loop that cannot end.
  if (!user.id) return backToSettings(res, 'Lending GitHub access needs a GitHub sign-in.');

  // A GitHub session minted before this feature shipped carries no token, and
  // every GitHub call below would 401. That surfaced as "you need admin access"
  // to someone who owned the repository, which is the worst kind of wrong error:
  // it names a cause the reader cannot act on and is not true.
  if (!user.token) {
    return backToSettings(res, 'Your sign-in predates this feature. Sign out and sign in again, then retry.');
  }

  // The lender's address is what lets a manager be matched to access they lent.
  // Lending without one wrote a record nobody could be matched to, which then
  // blocked every manager from stepping out — with re-lending, the suggested
  // fix, writing the same unmatchable record again.
  if (!user.email) {
    return backToSettings(res, 'Your GitHub sign-in did not reveal a verified email address, and lending records who lent access by address. Sign out and sign in again to grant it.');
  }
  const allowed = await mayLend(user, ref);
  if (!allowed.ok) return backToSettings(res, allowed.why);

  const slug = `${ref.owner}/${ref.repo}`;
  await kvSet(keys.projectGhCred(ref.owner, ref.repo), {
    // The address is recorded so a manager can be matched to access they lent:
    // managers are identified by email, and a GitHub id says nothing about one.
    token: user.token, lentById: user.id, lentByLogin: user.login, lentByEmail: user.email || null,
  });
  const list = (await kvGet(keys.lentProjects(user.id)))?.projects || [];
  if (!list.includes(slug)) await kvSet(keys.lentProjects(user.id), { projects: [...list, slug] });
  const byAddress = (await kvGet(keys.lentByAddress(user.email)))?.projects || [];
  if (!byAddress.includes(slug)) await kvSet(keys.lentByAddress(user.email), { projects: [...byAddress, slug] });
  backToSettings(res);
});

/** Stop lending. Members without a GitHub account lose access immediately. */
app.post('/settings/unlend', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Write the project as owner/repo.');

  // Withdrawing needs no GitHub credential — only to be the person who lent it,
  // recognised by GitHub id or by address. Somebody who lent access signed in
  // with GitHub can withdraw it signed in with Google.
  const slug = `${ref.owner}/${ref.repo}`;
  const existing = await kvGet(keys.projectGhCred(ref.owner, ref.repo));
  const mine = existing && (
    (user.id && String(existing.lentById) === String(user.id))
    || (user.email && existing.lentByEmail && String(existing.lentByEmail).toLowerCase() === String(user.email).toLowerCase())
  );
  if (existing && !mine) return backToSettings(res, 'That access was lent by someone else.');
  await kvSet(keys.projectGhCred(ref.owner, ref.repo), null);
  const lender = existing?.lentById || user.id;
  if (lender) {
    const list = (await kvGet(keys.lentProjects(lender)))?.projects || [];
    await kvSet(keys.lentProjects(lender), { projects: list.filter(p => p !== slug) });
  }
  if (user.email) {
    const byAddress = (await kvGet(keys.lentByAddress(user.email)))?.projects || [];
    await kvSet(keys.lentByAddress(user.email), { projects: byAddress.filter(p => p !== slug) });
  }
  backToSettings(res);
});

/**
 * Is this person a manager of this project, and can an agent reach it?
 *
 * Read through the project's lent GitHub access, because that is what an agent
 * reads through: a project that lends none could issue a token that never
 * works. A manager is matched by every form one is written in. A project with
 * no manager on record is refused outright — with no gate, everyone passes as
 * a manager, and issuing an agent is not something everyone should do.
 */
async function agentManagerAccess(user, ref) {
  const slug = `${ref.owner}/${ref.repo}`;
  if (!user.email) {
    return { ok: false, why: 'Your sign-in did not come with a verified email address, so an agent could not be recorded against you. Sign out and sign in again.' };
  }
  const lent = await kvGet(keys.projectGhCred(ref.owner, ref.repo));
  if (!lent?.token) {
    return { ok: false, why: `${slug} does not lend GitHub access, and an agent reads the project through it. Lend it first, below.` };
  }
  let config;
  try { config = await readConfigJson({ owner: ref.owner, repo: ref.repo, token: lent.token }); } catch (e) {
    return { ok: false, why: e.message };
  }
  const actor = {
    key: `git:${String(user.email).toLowerCase()}`,
    name: user.name || user.login || user.email,
    email: String(user.email).toLowerCase(),
    login: user.login || null,
    source: user.id ? 'github' : 'google',
  };
  const managers = managerKeys(config);
  if (!managers.length) return { ok: false, why: `${slug} has no manager on record, so nobody can issue agents for it.` };
  const byId = user.id ? { ...actor, key: `github:${user.id}` } : null;
  // Whichever identity the gate recognised is the one handed on. A manager
  // recorded as github:<id> passed here but was refused by the roster write,
  // which checks the gate again with the actor it is given.
  const matched = managers.some(k => matchesActor(k, actor)) ? actor
    : (byId && managers.some(k => matchesActor(k, byId)) ? byId : null);
  if (!matched) {
    return { ok: false, why: `Only a manager of ${slug} can issue or revoke its agents.` };
  }
  return { ok: true, actor: matched, token: lent.token };
}

/** Run a roster change against the repository, as the manager, through the lent access. */
async function asManagerOnRepo(ref, access, fn) {
  const session = new GithubSession({ owner: ref.owner, repo: ref.repo, ghToken: access.token });
  await session.prefetch();
  return runWithSession(session, fn);
}

/**
 * Check a key a manager is giving an agent, with the provider's free model list.
 *
 * A key the provider rejects is refused, since the agent would fall back on
 * every call and the manager would think it was running on its own key. A
 * provider that cannot be reached just now is no reason to refuse a key that
 * may well work, so that one is accepted.
 */
async function checkAgentKey({ provider, apiKey }) {
  const checked = await verifyProviderKey({ provider, apiKey });
  if (checked.ok || checked.transient) return { ok: true };
  return { ok: false, why: `That key was not saved: ${checked.why}` };
}

/** Issue an agent: its roster entry first, then the token, shown once. */
app.post('/settings/agents', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Pick a project first.');
  const name = String(req.body?.agentName || '').trim();
  if (!name) return backToSettings(res, 'Give the agent a name.');
  const workstreams = String(req.body?.agentWorkstreams || '')
    .split(',').map(w => w.trim()).filter(Boolean);

  const access = await agentManagerAccess(user, ref);
  if (!access.ok) return backToSettings(res, access.why);

  // Optional. Checked before anything is written, so a rejected key leaves no
  // agent behind to clean up.
  const apiKey = String(req.body?.agentApiKey || '').trim();
  const keyProvider = String(req.body?.agentProvider || 'anthropic').trim();
  if (apiKey) {
    const checked = await checkAgentKey({ provider: keyProvider, apiKey });
    if (!checked.ok) return backToSettings(res, checked.why);
  }

  const id = randomBytes(6).toString('hex');
  // The roster entry before the token. A token whose entry failed to write
  // would be refused on every call, which is a credential that only looks live.
  try {
    await asManagerOnRepo(ref, access, () => addAgent({
      id, name, workstreams: workstreams.length ? workstreams : undefined, actor: access.actor,
    }));
  } catch (e) {
    return backToSettings(res, e.message);
  }
  const { token } = await createAgentToken({ owner: ref.owner, repo: ref.repo, id, name, issuedBy: user.email });
  if (apiKey) await setAgentKey({ id, provider: keyProvider, apiKey, setBy: user.email });
  await renderSettings(req, res, user, {
    newAgent: {
      name, token, project: `${ref.owner}/${ref.repo}`,
      url: `${baseUrlFor(req)}/api/mcp/${ref.owner}/${ref.repo}`,
    },
  });
});

/** Give an agent its own key, replace it, or put it back on the project key. */
app.post('/settings/agents/key', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  const id = String(req.body?.id || '').trim();
  if (!ref || !id) return backToSettings(res, 'Pick the agent first.');

  const access = await agentManagerAccess(user, ref);
  if (!access.ok) return backToSettings(res, access.why);
  if (!(await listAgents(ref.owner, ref.repo)).some(a => a.id === id)) {
    return backToSettings(res, 'No such agent on that project — it may have been revoked.');
  }

  if (req.body?.clear) {
    await clearAgentKey(id);
    return backToSettings(res);
  }
  const apiKey = String(req.body?.apiKey || '').trim();
  const keyProvider = String(req.body?.provider || 'anthropic').trim();
  if (!apiKey) return backToSettings(res, 'Paste the key to give the agent.');
  const checked = await checkAgentKey({ provider: keyProvider, apiKey });
  if (!checked.ok) return backToSettings(res, checked.why);
  await setAgentKey({ id, provider: keyProvider, apiKey, setBy: user.email });
  backToSettings(res);
});

/** Revoke an agent: the token first, so it stops working even if the roster write fails. */
app.post('/settings/agents/revoke', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  const id = String(req.body?.id || '').trim();
  if (!ref || !id) return backToSettings(res, 'Pick the agent to revoke.');

  const access = await agentManagerAccess(user, ref);
  if (!access.ok) return backToSettings(res, access.why);

  const revoked = await revokeAgent({ owner: ref.owner, repo: ref.repo, id });
  try {
    await asManagerOnRepo(ref, access, () => removeAgent({ id, actor: access.actor }));
  } catch (e) {
    // Already off the roster is the state this was after.
    if (!(e instanceof MemberNotFoundError)) {
      return backToSettings(res, `The token is revoked, but its roster entry could not be removed: ${e.message}`);
    }
  }
  if (!revoked) return backToSettings(res, 'No such agent on that project — it may already be revoked.');
  backToSettings(res);
});

/**
 * Where a sign-in may send somebody afterwards.
 *
 * Allow-listed rather than trusted, because this is the one place a path from
 * the query string drives a redirect — and it now has to carry what a link from
 * a chat points at, so the rule lives beside the link format itself.
 */
const RETURN_TO = { test: isReturnable };

const signInFor = (res, path) => res.redirect(303, `/signin?returnTo=${encodeURIComponent(path)}`);

/** The projects this person is on, as somewhere to start looking. */
app.get('/projects', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return signInFor(res, '/projects');
  await renderProjects(req, res, user);
});

/**
 * The list, the box, and whatever the box has to say for itself.
 *
 * Shared with the POST so a reference that could not be opened comes back on the
 * page it was typed on, with the text still in the box — rather than on an error
 * page, which loses it and leaves nowhere to correct it.
 */
async function renderProjects(req, res, user, { typed = '', error = null, search = false } = {}) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const projects = user.email ? await projectsKnownFor(user.email) : [];
  // Repositories this person can reach, as suggestions. A Google sign-in has no
  // repository list at all, which is exactly why the box takes a pasted link.
  let repos = [];
  if (user.token) {
    try { repos = await listPushableRepos(user.token); } catch { /* suggestions are optional */ }
  }
  // Searched here rather than left to the browser. A datalist narrows on what a
  // browser decides to match, and several of them match only the start of the
  // value — so with `owner/repo` in the list, typing a repository's own name
  // found nothing at all while the owner's name found every one of them. This
  // matches either, and anywhere in the name.
  const needle = search ? typed.trim().toLowerCase() : '';
  const matches = needle
    ? repos.map(r => r.fullName).filter(name => String(name).toLowerCase().includes(needle)).slice(0, 25)
    : [];
  res.send(projectsPage({
    user, projects, repos, typed, error, query: needle ? typed.trim() : null, matches,
  }));
}

/**
 * Open a project by whatever somebody pasted.
 *
 * The access check is `readProjectView` itself rather than a cheaper lookalike:
 * reading the project is what they are about to do, and a second
 * implementation of "may they?" is a second thing to keep in step with the
 * connector. So what comes back here is the same answer, with the same reasons —
 * no teamctx project in that repository, no GitHub access lent to a Google
 * sign-in, or an address that is not on the roster.
 */
app.post('/projects', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return signInFor(res, '/projects');
  const typed = String(req.body?.ref || '').trim();
  const ref = parseProjectRef(typed);
  // Not a reference to a repository, so it is something to look for. Typing part
  // of a name is the ordinary way to find a project, not a mistake to correct.
  if (!ref) {
    if (!typed) {
      return renderProjects(req, res, user, {
        error: 'Type the name of a project, or paste the link you were sent.',
      });
    }
    return renderProjects(req, res, user, { typed, search: true });
  }
  try {
    await readProjectView({ owner: ref.owner, repo: ref.repo, user });
  } catch (e) {
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    return renderProjects(req, res, user, {
      typed,
      error: denied ? e.message : `${ref.owner}/${ref.repo} could not be opened: ${e.message}`,
    });
  }
  // On the list from here on, for the same reason as arriving by link: being able
  // to read a project is the only thing that ever qualified it for the list.
  if (user.email) {
    try { await recordConnectedProject({ email: user.email, owner: ref.owner, repo: ref.repo }); } catch { /* best effort */ }
  }
  res.redirect(303, `/project/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`);
});

/**
 * Where one project stands: its parts, its tasks, and what is waiting on the
 * manager. Read-only — see src/oauth/project-view.js.
 */
app.get('/project/:owner/:repo', async (req, res) => {
  const user = await currentUser(req);
  const owner = String(req.params.owner || '');
  const repo = String(req.params.repo || '');
  if (!user) {
    // Carry what the link pointed at through the sign-in and back, or somebody
    // following a link to one statement lands on the project and has to find it
    // again — which is the whole thing this was built to save them.
    const back = new URLSearchParams(parseViewParams(req.query)).toString();
    return signInFor(res, `/project/${owner}/${repo}${back ? `?${back}` : ''}`);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const view = await readProjectView({ owner, repo, user });
    // Remembered now that the project has let them in, so the next visit starts
    // from the list rather than from the link. A person who arrives by clicking
    // one has never "added" anything, and being able to read a project is the
    // only thing that ever qualified it for their list.
    if (user.email) {
      try { await recordConnectedProject({ email: user.email, owner, repo }); } catch { /* best effort */ }
    }
    // Which part of the work to open, and what to point at inside it. Read
    // through the link's own rules, so a value the page would not have written
    // never reaches it, then checked against what exists: anything unknown or
    // out of scope falls back to the nearest thing that does, with a quiet
    // note, and the value asked for is never echoed back.
    const asked = parseViewParams(req.query);
    const known = view.workstreams.some(w => w.id === asked.ws);
    const selected = known ? asked.ws : null;
    const item = asked.item || asked.task || asked.review || null;
    res.send(projectPage({
      user,
      view,
      selected,
      viewMode: req.query.view === 'list' ? 'list' : 'columns',
      item,
      // So a copied prompt can carry the address of the page it was copied
      // from, which is the one thing that tells a reader where it came from.
      origin: baseUrlFor(req),
      note: asked.ws && !known ? 'That part of the work is not here, or not yours to see.' : null,
    }));
  } catch (e) {
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    res.status(denied ? 403 : 500).send(errorPage(e.message));
  }
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

// An Express app is already a (req, res) handler — exactly Vercel's shape.
export default (req, res) => app(req, res);
export { app };
