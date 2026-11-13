import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { providerFromEnv, oauthConfigStatus, GITHUB_SCOPES, OAuthCallbackError, setBindCookie, readBindCookie, bindMatches, tokenHash, redirectTarget } from '../src/oauth/provider.js';
import { kvGet, kvSet, kvTake, kvDelete, keys, TTL, isPersistent, secretsConfigured } from '../src/oauth/kv.js';
import { liveProjects } from '../src/oauth/live-projects.js';
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
import { GithubSession, listUserOrgs, createRepo, slugifyProjectName, suggestAvailableName, listPushableRepos, repoExistence } from '../src/adapters/github.js';
import { runWithSession } from '../src/session-context.js';
import { initProject } from '../cli/commands/init.core.js';
import { readProjectView, readContributionsView, readRecordTrailView, attachFileOutput, readFileOutput, ProjectViewError, StaleSignInError } from '../src/oauth/project-view.js';
import { FileOutputError, MAX_PAGE_UPLOAD_BYTES, MAX_OUTPUT_FILE_BYTES, humanBytes } from '../src/file-output.js';
import Busboy from 'busboy';
import { TOOLS, callTool } from '../mcp/server.js';
import { baseUrlFrom } from '../src/base-url.js';
import { resolveKey } from '../src/numbering.js';
import { isReturnable, parseViewParams, TIPS_PROJECT } from '../src/view-url.js';
import { parseProjectRef } from '../src/project-ref.js';
// Page templates. They used to sit at the bottom of this file, which left it
// mostly HTML with the routes buried in it — see #103 part 1.
import { settingsPage } from '../src/views/settings.js';
import { isSlackWebhook } from '../src/slack-notify.js';
import { projectsPage } from '../src/views/projects.js';
import { projectPage } from '../src/views/project.js';
import { tipsPage } from '../src/views/tips.js';
import { contributionsPage } from '../src/views/contributions.js';
import { recordHistoryPage } from '../src/views/record-history-page.js';
import { RecordNotFoundError } from '../cli/commands/records.core.js';
import { choosePage, signInPage, lendsNothing } from '../src/views/connect.js';
import { consentPage } from '../src/views/consent.js';
import { homePage } from '../src/views/home.js';
import { newProjectPage, newProjectSuccessPage, newProjectRetryPage } from '../src/views/new-project.js';
import { errorPage } from '../src/views/error.js';
import { addAgent, removeAgent, MemberNotFoundError } from '../cli/commands/member.core.js';
import {
  createAgentToken, listAgents, revokeAgent, projectsWithAgentsBy,
  setAgentKey, clearAgentKey, agentKeyStatus,
} from '../src/oauth/agent-tokens.js';
import { verifyProviderKey } from '../src/providers/verify-key.js';

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

// A persistent deployment with no encryption key cannot store secrets (writes
// are refused) and any pre-encryption plaintext stays readable in the clear.
// Warn at startup so an operator sees it in the logs.
if (isPersistent() && !secretsConfigured()) {
  console.warn('teamctx: TEAMCTX_SECRET_KEYS is not set — secrets cannot be stored encrypted. '
    + 'Set TEAMCTX_SECRET_KEYS and TEAMCTX_SECRET_KEY_ACTIVE; see scripts/encrypt-existing-secrets.js.');
}

const app = express();
// Hop count, not `true` — express-rate-limit rejects blanket trust with
// ERR_ERL_PERMISSIVE_TRUST_PROXY because it makes IP limiting bypassable.
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));

// Security headers on every response: no content-type sniffing, keep the
// Referer to this origin, force HTTPS, and forbid framing (clickjacking). Only
// `frame-ancestors` for the CSP — a fuller policy would break the inline styles
// these pages use, and is out of scope here.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});

// Per-IP limits on the two endpoints an attacker would hammer: registration is
// the abuse vector, so it is the tighter. Only on a hosted deployment — the
// in-memory store would otherwise make the test suite order-dependent, and
// there is nothing to rate-limit in local dev.
if (isPersistent()) {
  const perHour = (limit) => rateLimit({ windowMs: 60 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false });
  app.use('/register', perHour(10));
  app.use('/authorize', perHour(30));
}

function baseUrlFor(req) {
  // See src/base-url.js: the request names the address, but only a host this
  // deployment already knows itself by is believed.
  return baseUrlFrom({
    host: req.get('x-forwarded-host') || req.get('host'),
    proto: req.get('x-forwarded-proto'),
  });
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
    missing: Object.entries({ ...cfg, kv: isPersistent(), secretKeys: !isPersistent() || secretsConfigured() })
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

/**
 * A sign-in callback failed. The raw error must never reach the person: it can
 * carry internal keys and ids — a deployment with no encryption key configured
 * leaked the session key this way, because storing the session is refused and
 * the message names the key. Log the detail server-side, and show a clean
 * message: a specific one when the deployment has no key set (nobody can sign
 * in until its administrator configures one), the safe message of a known
 * OAuth error, or a generic fallback otherwise.
 */
export function signInFailed(res, e, fallback = 'Sign-in could not be completed. Please try again.') {
  console.warn('teamctx sign-in failed:', e?.message || e);
  // The hint fires only on the condition that actually refuses the write — a
  // persistent deployment with no key. In local/in-memory mode an ephemeral key
  // is used, so a failure there is something else and gets the plain message.
  const msg = isPersistent() && !secretsConfigured()
    ? 'This deployment is not finished being set up: its administrator needs to configure an '
      + 'encryption key (TEAMCTX_SECRET_KEYS) before anyone can sign in. You were not signed in, '
      + 'and nothing was stored.'
    : e instanceof OAuthCallbackError ? e.message : fallback;
  return res.status(400).send(errorPage(msg));
}

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
    if (!bindMatches(settingsPending, readBindCookie(req))) {
      return res.status(400).send(errorPage('This sign-in was started in another browser. Start it again from the settings page.'));
    }
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
      return signInFailed(res, e);
    }
  }
  try {
    const redirectTo = await provider.handleGoogleCallback({
      code: code ? String(code) : null,
      state: String(state),
      error: error ? String(error) : null,
      errorDescription: errorDescription ? String(errorDescription) : null,
      bind: readBindCookie(req),
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
    if (!bindMatches(settingsPending, readBindCookie(req))) {
      return res.status(400).send(errorPage('This sign-in was started in another browser. Start it again from the settings page.'));
    }
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
      return signInFailed(res, e);
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
      bind: readBindCookie(req),
    });
    return res.redirect(redirectTo);
  } catch (e) {
    const msg = e instanceof OAuthCallbackError ? e.message : 'Authorization failed.';
    return res.status(400).send(errorPage(msg));
  }
});

// ---- Consent ----------------------------------------------------------
// Shown once per client and redirect origin, after the sign-in, before the
// first authorization code is issued.

app.get('/oauth/consent', async (req, res) => {
  const c = String(req.query.c || '');
  const rec = provider && c ? await provider.getConsent(c) : null;
  if (!rec) return res.status(400).send(errorPage('This approval request expired. Start the connection again from your assistant.'));
  const client = await kvGet(keys.client(rec.clientId));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(consentPage({
    clientName: client?.client_name || null,
    redirectTarget: redirectTarget(rec.redirectUri),
    identity: rec.identity || rec.subject,
    cToken: c,
  }));
});

app.post('/oauth/consent', async (req, res) => {
  const c = String(req.body?.c || '');
  if (!provider || !c) return res.status(400).send(errorPage('Missing approval token.'));
  try {
    const redirectTo = String(req.body?.decision) === 'approve'
      ? await provider.approveConsent(c, readBindCookie(req))
      : await provider.denyConsent(c);
    // 303, not Express's default 302: behind Vercel's rewrite layer a 302 reaches
    // the browser as a 307, which repeats this POST at the client's callback.
    return res.redirect(303, redirectTo);
  } catch (e) {
    const msg = e instanceof OAuthCallbackError ? e.message : 'Could not complete the approval.';
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
  const slack = await slackFor(user, repos);
  if (newAgent) res.setHeader('Cache-Control', 'no-store');
  res.send(settingsPage({
    user, hasKey: !!existing, shared, lent, repos, agents, newAgent, slack,
    secretsMissing: isPersistent() && !secretsConfigured(),
    saved: req.query.saved === '1',
    rotated: req.query.rotated ? String(req.query.rotated).split(',').filter(Boolean) : [],
    stillShared: req.query.stillShared ? String(req.query.stillShared).split(',').filter(Boolean) : [],
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
 * The Slack notices set on projects this person manages (#182): who set each and
 * when, never the webhook itself, which is a credential.
 */
async function slackFor(user, repos = []) {
  if (!user.email) return [];
  // The repositories they can push to as well, so a co-manager can see and stop
  // a notice another manager set. Only those with a webhook are checked.
  const projects = [...new Set([
    ...((await kvGet(keys.slackSetBy(user.email)))?.projects || []),
    ...(await projectsKnownFor(user.email)),
    ...repos.map(r => r.fullName),
  ].filter(Boolean).map(p => p.toLowerCase()))].sort();
  const out = [];
  for (const slug of projects) {
    const [owner, repo] = slug.split('/');
    const saved = await kvGet(keys.slackWebhook(owner, repo));
    if (!saved?.url) continue;
    if (!(await slackManagerAccess(user, { owner, repo })).ok) continue;
    out.push({ project: slug, setBy: saved.setBy || null, setAt: saved.setAt || null });
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
  const returnTo = isReturnable(requestedReturnTo) ? requestedReturnTo : null;
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
  const returnTo = isReturnable(requestedReturnTo) ? requestedReturnTo : null;
  const bind = randomBytes(18).toString('base64url');
  await kvSet(
    keys.pending(`settings-google:${state}`),
    { kind: 'settings', bindHash: tokenHash(bind), ...(returnTo ? { returnTo } : {}) },
    { ttlSeconds: TTL.pending },
  );
  setBindCookie(res, bind);
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
  const returnTo = isReturnable(requestedReturnTo) ? requestedReturnTo : null;
  const bind = randomBytes(18).toString('base64url');
  await kvSet(
    keys.pending(`settings:${state}`),
    { kind: 'settings', bindHash: tokenHash(bind), ...(returnTo ? { returnTo } : {}) },
    { ttlSeconds: TTL.pending },
  );
  setBindCookie(res, bind);
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
      return res.status(500).send(errorPage(e.message, { user }));
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
    // Named, not removed: taking a key out of a project is its own deliberate
    // act with its own confirmation, and somebody who is not told goes on paying
    // for a key they believe they retired.
    const cleared = await writePersonalKey({ email: user.email, githubId: user.id, apiKey: null });
    const still = cleared?.stillShared || [];
    return res.redirect(303, still.length
      ? `/settings?saved=1&stillShared=${encodeURIComponent(still.join(','))}`
      : '/settings?saved=1');
  }
  if (!apiKey) {
    return res.status(400).send(errorPage('Paste a key, or leave the page.', { user }));
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
 * The identity a signed-in person matches the project's manager gate with, or
 * null when they are not a manager. Whichever identity the gate recognised is
 * the one handed on: a manager recorded as github:<id> passed a check by
 * address and was then refused by a roster write, which checks the gate again
 * with the actor it is given.
 */
function matchManager(config, user) {
  if (!user.email) return null;
  const actor = {
    key: `git:${String(user.email).toLowerCase()}`,
    name: user.name || user.login || user.email,
    email: String(user.email).toLowerCase(),
    login: user.login || null,
    source: user.id ? 'github' : 'google',
  };
  const managers = managerKeys(config);
  const byId = user.id ? { ...actor, key: `github:${user.id}` } : null;
  return managers.some(k => matchesActor(k, actor)) ? actor
    : (byId && managers.some(k => matchesActor(k, byId)) ? byId : null);
}

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
  if (!managerKeys(config).length) return { ok: false, why: `${slug} has no manager on record, so nobody can issue agents for it.` };
  const matched = matchManager(config, user);
  if (!matched) {
    return { ok: false, why: `Only a manager of ${slug} can issue or revoke its agents.` };
  }
  return { ok: true, actor: matched, token: lent.token };
}

/**
 * Whether this person may set or clear a project's Slack notices: a manager of
 * it, read through their own GitHub sign-in or the access the project lends.
 */
async function slackManagerAccess(user, ref) {
  const slug = `${ref.owner}/${ref.repo}`;
  // Their own sign-in first, then the access the project lends: a GitHub
  // account an organisation keeps out of the repository can still be a manager.
  const tokens = [user.token, (await kvGet(keys.projectGhCred(ref.owner, ref.repo)))?.token].filter(Boolean);
  if (!tokens.length) {
    return { ok: false, why: `${slug} cannot be read without GitHub access. Sign in with GitHub, or ask its manager to lend access below.` };
  }
  let config = null;
  let lastError = null;
  for (const token of tokens) {
    try { config = await readConfigJson({ owner: ref.owner, repo: ref.repo, token }); break; } catch (e) { lastError = e; }
  }
  if (!config) return { ok: false, why: lastError.message };
  if (!matchManager(config, user)) return { ok: false, why: `Only a manager of ${slug} can set its Slack notices.` };
  return { ok: true };
}

/**
 * Set or clear the Slack webhook a project's waiting items are announced to
 * (#182). Kept in the store, never the repository, and never shown again.
 */
app.post('/settings/slack', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect(303, '/settings');
  const ref = parseRepoRef(req.body?.project);
  if (!ref) return backToSettings(res, 'Pick a project first.');
  if (!user.email) {
    return backToSettings(res, 'Your sign-in did not come with a verified email address, so who set this could not be recorded. Sign out and sign in again.');
  }
  const access = await slackManagerAccess(user, ref);
  if (!access.ok) return backToSettings(res, access.why);

  const slug = `${ref.owner}/${ref.repo}`.toLowerCase();
  if (req.body?.clear) {
    await kvDelete(keys.slackWebhook(ref.owner, ref.repo));
    return backToSettings(res);
  }
  const url = String(req.body?.webhook || '').trim();
  if (!isSlackWebhook(url)) {
    return backToSettings(res, 'That is not a Slack incoming webhook. It starts with https://hooks.slack.com/services/.');
  }
  await kvSet(keys.slackWebhook(ref.owner, ref.repo), { url, setBy: user.email, setAt: new Date().toISOString() });
  const mine = (await kvGet(keys.slackSetBy(user.email)))?.projects || [];
  if (!mine.includes(slug)) await kvSet(keys.slackSetBy(user.email), { projects: [...mine, slug] });
  backToSettings(res);
});

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


const signInFor = (res, path) => res.redirect(303, `/signin?returnTo=${encodeURIComponent(path)}`);

/**
 * GitHub refused the token this browser's sign-in holds. The person has done
 * nothing wrong and cannot fix it from an error page they did not expect, so
 * the session is dropped and they go through sign-in, then come back to the
 * page they were after. Logged without the token, so a recurrence has a trail.
 *
 * Once only: a second refusal inside a minute means a fresh token was refused
 * too, and sending them round again would loop. That one gets the error page.
 * Returns true when it redirected.
 */
async function recoverStaleSignIn(req, res, e, { owner, repo }) {
  if (!(e instanceof StaleSignInError)) return false;
  console.warn(`project: GitHub refused the browser sign-in token for ${owner}/${repo} (401)`);
  if (/(?:^|;\s*)teamctx_retry=1/.test(req.headers.cookie || '')) return false;
  const sid = readSessionId(req);
  if (sid) await kvDelete(keys.session(sid));
  res.setHeader('Set-Cookie', [
    'teamctx_sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    'teamctx_retry=1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60',
  ]);
  const back = isReturnable(req.originalUrl) ? req.originalUrl : `/project/${owner}/${repo}`;
  signInFor(res, back);
  return true;
}

/**
 * Tips & Tricks, for signed-in people. The link in every tool result lands here;
 * a signed-out click goes through sign-in and comes back to the same address.
 */
app.get('/tips', async (req, res) => {
  const user = await currentUser(req);
  const raw = typeof req.query.project === 'string' ? req.query.project : '';
  const project = TIPS_PROJECT.test(raw) ? raw : null;
  if (!user) return signInFor(res, `/tips${project ? `?project=${project}` : ''}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(tipsPage({ user, project, projectUrl: project ? `/project/${project}` : null }));
});

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
  // What teamctx has been told about, less whatever GitHub says no longer exists.
  const projects = user.email
    ? await liveProjects(await projectsKnownFor(user.email), {
      viewer: user.email,
      userToken: user.token,
      lentToken: async (owner, repo) => (await kvGet(keys.projectGhCred(owner, repo)))?.token || null,
      check: repoExistence,
    })
    : [];
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
  // matches either, and anywhere in the name. A space, a dash and an underscore
  // count as the same, so "vietnam 3" finds vietnam-3: a repository name has no
  // spaces, and people type a project's name the way it reads.
  const needle = search ? typed.trim().toLowerCase() : '';
  const loose = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '-');
  const matches = needle
    ? repos.map(r => r.fullName).filter(name => loose(name).includes(loose(needle))).slice(0, 25)
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
    // A denial is written for the person and says which of the three reasons it
    // was, so it is theirs to read. Anything else came from upstream, and this
    // route takes an arbitrary `owner/repo` from a form — so reflecting that
    // text would let any signed-in person probe repositories and read back
    // whatever GitHub said about them. The detail goes to the log instead.
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    if (!denied) console.warn(`projects: opening ${ref.owner}/${ref.repo} failed:`, e);
    return renderProjects(req, res, user, {
      typed,
      error: denied ? e.message
        : `${ref.owner}/${ref.repo} could not be opened. Check the name, and that the `
          + 'project has lent GitHub access and has your address on it.',
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
    const navigation = new URLSearchParams(parseViewParams(req.query));
    for (const key of ['view', 'history', 'taskWs', 'taskOwner', 'tab', 'page', 'ipage']) {
      const value = req.query[key];
      if (typeof value !== 'string') continue;
      const parameter = new URLSearchParams({ [key]: value });
      if (isReturnable(`/project/${owner}/${repo}?${parameter}`)) navigation.set(key, value);
    }
    const back = navigation.toString();
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
    let selected = known ? asked.ws : null;
    // A task number resolves to the same thing its id does. Links carry the internal id,
    // which never changes — but the number is what a person has in front of them, on
    // the page or in a prompt, so `?task=3.2` has to reach the row that
    // `?task=task-1a2b…` reaches. Resolved against what this reader was actually
    // sent, so a key in a part of the work they are not on resolves to nothing,
    // the same as an unknown id.
    const reachable = { tasks: [...(view.tasks?.open || []), ...(view.tasks?.done || [])] };
    const named = asked.item || asked.task || asked.review || null;
    // A waiting item has a number too (`1.6`), so a link or a sentence that says
    // "1.6" reaches it. A task of that number wins: an item about an existing task
    // carries that task's number, and the task is the thing it is about.
    const resolved = resolveKey(named, reachable);
    const wanted = named && resolved === named ? ((view.pending || []).find(q => q.number === named)?.id ?? named) : resolved;
    // Dropped unless it names something this reader was actually sent. `ws`
    // already falls back that way; `item` did not, and rode along in the view
    // toggle's own links — so a value that pointed at nothing was still written
    // back into the page, which is the one thing this route says it never does.
    const reaches = reachable.tasks.some(x => x?.id === wanted)
      || (view.pending || []).some(q => q.id === wanted);
    const item = reaches ? wanted : null;
    res.send(projectPage({
      user,
      view,
      selected,
      item,
      history: req.query.history === '1',
      // So a copied prompt can carry the address of the page it was copied
      // from, which is the one thing that tells a reader where it came from.
      origin: baseUrlFor(req),
      note: asked.ws && !known ? 'That part of the work is not here, or not yours to see.' : null,
    }));
  } catch (e) {
    if (await recoverStaleSignIn(req, res, e, { owner, repo })) return;
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    // An old-format project is not a failure of this server: say what to do.
    const status = e.code === 'LEGACY_FORMAT' ? 409 : denied ? 403 : 500;
    res.status(status).send(errorPage(e.message, { user }));
  }
});

/**
 * Read a single file off a multipart upload, into memory, with a hard size
 * cap. busboy stops at the cap and marks the stream truncated rather than
 * buffering an unbounded body; `title` and `note` ride along as fields. One
 * file only — the page attaches one output at a time.
 */
function readUpload(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_PAGE_UPLOAD_BYTES, fields: 10, fieldSize: 4000 } });
    } catch (e) { reject(e); return; }
    const fields = {};
    let file = null;
    let truncated = false;
    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { truncated = true; });
      stream.on('close', () => { file = { bytes: Buffer.concat(chunks), name: info?.filename || 'file' }; });
    });
    bb.on('field', (name, val) => { if (name === 'title' || name === 'note') fields[name] = val; });
    bb.on('error', reject);
    bb.on('close', () => resolve({ file, fields, truncated }));
    req.pipe(bb);
  });
}

/**
 * Attach a file as a working output on a task, from the page (#247). A member
 * uploads one file; it is size- and type-checked, stored in the repository and
 * recorded like any other output. Large files and other types are refused with
 * a message, never trimmed, and the command line takes a larger file.
 */
app.post('/project/:owner/:repo/task/:taskId/attach', async (req, res) => {
  const user = await currentUser(req);
  const owner = String(req.params.owner || '');
  const repo = String(req.params.repo || '');
  const taskId = String(req.params.taskId || '');
  const back = `/project/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?task=${encodeURIComponent(taskId)}`;
  if (!user) return signInFor(res, back);

  let parsed;
  try {
    parsed = await readUpload(req);
  } catch {
    return res.status(400).send(errorPage('That upload could not be read. Try choosing the file again.', { user }));
  }
  if (parsed.truncated) {
    return res.status(413).send(errorPage(
      `That file is larger than the ${humanBytes(MAX_PAGE_UPLOAD_BYTES)} the page takes. `
      + `The command line takes up to ${humanBytes(MAX_OUTPUT_FILE_BYTES)}: teamctx task attach.`, { user }));
  }
  if (!parsed.file || !parsed.file.bytes.length) {
    return res.status(400).send(errorPage('No file was chosen.', { user }));
  }
  try {
    await attachFileOutput({
      owner, repo, user, taskId,
      bytes: parsed.file.bytes, fileName: parsed.file.name,
      title: parsed.fields.title, note: parsed.fields.note,
    });
  } catch (e) {
    if (await recoverStaleSignIn(req, res, e, { owner, repo })) return;
    if (e instanceof FileOutputError) return res.status(400).send(errorPage(e.message, { user }));
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    if (!denied) console.warn(`attach: ${owner}/${repo} task ${taskId} failed:`, e);
    return res.status(denied ? 403 : 500).send(errorPage(
      denied ? e.message : 'The file could not be saved. Try again.', { user }));
  }
  res.redirect(303, back);
});

/**
 * Download a file output as an attachment (#247), with the type teamctx sniffed
 * when it was attached and never inline, so a file never renders in the browser.
 * The same scope gate as the page: an out-of-scope task serves nothing.
 */
app.get('/project/:owner/:repo/task/:taskId/file/:outputId', async (req, res) => {
  const user = await currentUser(req);
  const owner = String(req.params.owner || '');
  const repo = String(req.params.repo || '');
  const taskId = String(req.params.taskId || '');
  const outputId = String(req.params.outputId || '');
  if (!user) return signInFor(res, `/project/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  let file;
  try {
    file = await readFileOutput({ owner, repo, user, taskId, outputId });
  } catch (e) {
    if (await recoverStaleSignIn(req, res, e, { owner, repo })) return;
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    if (!denied) console.warn(`download: ${owner}/${repo} task ${taskId} failed:`, e);
    return res.status(denied ? 403 : 500).send(errorPage(
      denied ? e.message : 'That file could not be read.', { user }));
  }
  if (!file) return res.status(404).send(errorPage('That file is not here, or not yours to see.', { user }));
  // Attachment, never inline, with nosniff: a downloaded file is saved, not
  // opened in the page, so an uploaded document can never run as one.
  const safeName = String(file.name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  res.setHeader('Content-Type', file.type);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file.bytes);
});

/**
 * Every contribution to a project, latest first, by date or by contributor.
 * The manager's: see readContributionsView.
 */
app.get('/project/:owner/:repo/contributions', async (req, res) => {
  const user = await currentUser(req);
  const owner = String(req.params.owner || '');
  const repo = String(req.params.repo || '');
  const by = req.query.group === 'person' ? 'person' : 'date';
  if (!user) return signInFor(res, `/project/${owner}/${repo}/contributions${by === 'person' ? '?group=person' : ''}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    res.send(contributionsPage({ user, view: await readContributionsView({ owner, repo, user }), by }));
  } catch (e) {
    if (await recoverStaleSignIn(req, res, e, { owner, repo })) return;
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    res.status(e.code === 'LEGACY_FORMAT' ? 409 : denied ? 403 : 500).send(errorPage(e.message, { user }));
  }
});

/** One governed record's trail — its versions, who changed and approved it (#265). */
app.get('/project/:owner/:repo/record/:id', async (req, res) => {
  const user = await currentUser(req);
  const owner = String(req.params.owner || '');
  const repo = String(req.params.repo || '');
  const id = String(req.params.id || '');
  if (!user) return signInFor(res, `/project/${owner}/${repo}/record/${id}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    res.send(recordHistoryPage({ user, view: await readRecordTrailView({ owner, repo, user, id }) }));
  } catch (e) {
    if (await recoverStaleSignIn(req, res, e, { owner, repo })) return;
    const notFound = e instanceof RecordNotFoundError;
    const denied = e instanceof ProjectViewError || e.code === 'MEMBER_ACCESS_DENIED';
    res.status(notFound ? 404 : e.code === 'LEGACY_FORMAT' ? 409 : denied ? 403 : 500).send(errorPage(e.message, { user }));
  }
});

// ---- The SDK's OAuth server: metadata, /authorize, /token, /register --

if (provider) {
  // RFC 8414: the `issuer` in the metadata is the identifier a client found the
  // server by, and a strict client rejects metadata whose issuer is not exactly
  // that. The protected-resource document names this server without a trailing
  // slash, and the SDK reports `new URL(base).href`, which always has one. Only
  // the string changes; every endpoint it points at is the same, so clients that
  // never checked are unaffected.
  app.use('/.well-known/oauth-authorization-server', (_req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => send(typeof body?.issuer === 'string' ? { ...body, issuer: body.issuer.replace(/\/+$/, '') } : body);
    next();
  });
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
