import express from 'express';
import { randomBytes } from 'crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { providerFromEnv, oauthConfigStatus, GITHUB_SCOPES, OAuthCallbackError } from '../src/oauth/provider.js';
import { kvGet, kvSet, kvTake, kvDelete, keys, TTL, isPersistent } from '../src/oauth/kv.js';

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
      return res.redirect(303, '/settings');
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
  res.send(settingsPage({
    user, hasKey: !!existing, shared,
    saved: req.query.saved === '1',
    error: req.query.error ? String(req.query.error) : null,
  }));
});

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
  if (!ref) return backToSettings(res, 'Write the project as owner/repo.');
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!apiKey) return backToSettings(res, 'Paste the key to share.');
  const provider_ = String(req.body?.provider || 'anthropic').trim();

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

const shell = (title, body) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — teamctx</title><style>
:root{color-scheme:light dark}
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;line-height:1.55}
h1{font-size:1.25rem;margin-bottom:.25rem}
p{color:#666;margin-top:0}
label{display:block;font-weight:500;margin:1.25rem 0 .35rem}
input,select{width:100%;box-sizing:border-box;padding:.6rem .7rem;font-size:1rem;border:1px solid #ccc;border-radius:.4rem;background:transparent;color:inherit}
button{margin-top:1.25rem;background:#1a1a1a;color:#fff;border:0;padding:.6rem 1.4rem;font-size:1rem;border-radius:.4rem;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#eee;color:#111}input,select{border-color:#444}}
.ok{background:#e8f5e9;color:#1b5e20;padding:.6rem .8rem;border-radius:.4rem;margin:1rem 0}
.muted{font-size:.85rem;color:#888}
.bad{background:#fdecea;color:#8b1a10;padding:.6rem .8rem;border-radius:.4rem;margin:1rem 0}
@media(prefers-color-scheme:dark){.ok{background:#1b3a1e;color:#c8e6c9}.bad{background:#3a1b18;color:#f5c6c2}}
button.link{background:none;border:0;padding:0;margin:0 0 0 .5rem;color:#888;
  font-size:.85rem;text-decoration:underline;cursor:pointer}
code{background:#8881;padding:.1rem .3rem;border-radius:.2rem}
</style></head><body>${body}</body></html>`;

const settingsPage = ({ user, hasKey, saved, error, shared = [] }) => shell('Settings', `
<h1>teamctx settings</h1>
<p>Signed in as <strong>${user.login}</strong>.
  <form method="POST" action="/settings/logout" style="display:inline;margin:0">
    <button type="submit" class="link">Sign out</button>
  </form>
</p>
${saved ? '<div class="ok">Saved.</div>' : ''}
${error ? `<div class="bad">${esc(error)}</div>` : ''}
<p class="muted">Your AI provider key is used only for the teamctx tools that call a
model — <code>ask</code>, <code>contribute</code>, <code>reflect</code>,
<code>role_add</code> and the two <code>suggest_*</code> tools. The other 21
tools work without it. Stored against your GitHub account; never written to
your repo.</p>
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

<hr style="margin:2.5rem 0;border:0;border-top:1px solid #8883">

<h1>Share a key with a project</h1>
<p class="muted">Most people on a project never set a key up — plenty of them
never sign in here at all and reach the project only through their agent. A key
shared with a project is used for anyone on it who has no key of their own, so
the model-backed tools work for the whole team. Someone who <em>has</em> saved
their own key above keeps using it; this never overrides it. You are paying for
what the project spends.</p>
${shared.length ? `<p class="muted">Sharing a key with:</p>${shared.map(slug => `
<form method="POST" action="/settings/unshare" style="margin:.35rem 0">
  <input type="hidden" name="project" value="${esc(slug)}">
  <code>${esc(slug)}</code>
  <button type="submit" class="link">Stop sharing</button>
</form>`).join('')}` : ''}
<form method="POST" action="/settings/share">
  <label for="project">Project</label>
  <input id="project" name="project" placeholder="owner/repo" required>
  <label for="shareProvider">Provider</label>
  <select id="shareProvider" name="provider">
    <option value="anthropic">Anthropic</option>
    <option value="openai">OpenAI</option>
    <option value="gemini">Google Gemini</option>
  </select>
  <label for="shareKey">API key to share</label>
  <input id="shareKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" required>
  <button type="submit">Share with project</button>
</form>`);

const signInPage = () => shell('Sign in', `
<h1>teamctx settings</h1>
<p>Sign in with GitHub to set the API key used by the teamctx tools that call
a model.</p>
<p><a href="/settings/signin"><button type="button">Sign in with GitHub</button></a></p>
<p class="muted">GitHub will not prompt you again if you have already
authorised teamctx. To sign in as a different account, revoke teamctx under
<a href="https://github.com/settings/applications" target="_blank" rel="noreferrer">GitHub &rarr; Authorized OAuth Apps</a> first.</p>`);

const errorPage = (message) => shell('Error', `
<h1>Something went wrong</h1>
<p>${String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`);

// An Express app is already a (req, res) handler — exactly Vercel's shape.
export default (req, res) => app(req, res);
export { app };
