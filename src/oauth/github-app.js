/**
 * GitHub App access (#110).
 *
 * The hosted connector reaches a project's repository through a credential a
 * manager lends. Today that is an OAuth `repo` user token, which GitHub cannot
 * scope to one repository — it can read and write every repo the lender owns. A
 * GitHub App installed on only the project's repository fixes that: its
 * installation tokens are short-lived (one hour), limited to the installed
 * repositories, and carry only the permissions the app asked for.
 *
 * This module holds the deployment's App identity (its id and private key, from
 * the environment) and mints an installation token for a given installation id.
 * The JWT signing and the token caching are left to `@octokit/auth-app` rather
 * than hand-rolled: the private key is RSA and getting that wrong is a security
 * bug, not a style one.
 *
 * Phase 1 of the migration (see the design doc) adds this helper and the
 * credential-resolution shim; nothing stores an installation id until the
 * install flow lands, so on an existing deployment this is dormant and the
 * legacy lent token is still what answers.
 */
import { createAppAuth } from '@octokit/auth-app';

/**
 * The App's identity from the environment, or `null` when a deployment has not
 * registered one. `GITHUB_APP_PRIVATE_KEY` is a PEM; stored in an env var its
 * newlines are often escaped as `\n`, so those are restored.
 */
export function githubAppFromEnv(env = process.env) {
  const appId = env.GITHUB_APP_ID;
  const raw = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !raw) return null;
  const privateKey = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  return { appId: String(appId), privateKey };
}

/**
 * Whether this deployment can offer the GitHub App install. The slug is part of
 * it: without it the install URL cannot be built, so advertising the App without
 * one would dead-end. For the status page and the settings UI.
 */
export function githubAppConfigured(env = process.env) {
  return !!githubAppFromEnv(env) && !!env.GITHUB_APP_SLUG;
}

/**
 * The URL that walks a manager through installing the App on a repository, or
 * `null` when the deployment has not named its App (`GITHUB_APP_SLUG`). `state`
 * rides through GitHub's install flow and comes back to the setup callback, so
 * the callback knows which project the install was for and that it began here.
 */
export function githubAppInstallUrl(state, env = process.env) {
  const slug = env.GITHUB_APP_SLUG;
  if (!slug) return null;
  const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

// One auth instance per private key, reused so `@octokit/auth-app`'s own cache
// of installation tokens survives between calls on a warm instance. A cold
// serverless start simply mints a fresh token, which is one API call.
let cachedAuth = null;
let cachedFor = null;

function appAuth(env) {
  const app = githubAppFromEnv(env);
  if (!app) return null;
  if (!cachedAuth || cachedFor !== app.appId) {
    cachedAuth = createAppAuth({ appId: app.appId, privateKey: app.privateKey });
    cachedFor = app.appId;
  }
  return cachedAuth;
}

/**
 * A short-lived installation token for one installation, or `null` when the App
 * is not configured. Throws if GitHub refuses (e.g. the installation was
 * removed), so a caller can tell "no App here" from "the install is gone".
 *
 * @param {string|number} installationId
 * @param {Record<string,string>} [env]
 * @returns {Promise<string|null>}
 */
export async function installationTokenFor(installationId, env = process.env) {
  if (!installationId) return null;
  const auth = appAuth(env);
  if (!auth) return null;
  const { token } = await auth({ type: 'installation', installationId: Number(installationId) });
  return token;
}

/**
 * A JWT that authenticates as the App itself (not an installation), for the few
 * calls that are about the App rather than a repository — looking up which
 * installation covers a repo. `null` when the App is not configured.
 */
export async function appJwt(env = process.env) {
  const auth = appAuth(env);
  if (!auth) return null;
  const { token } = await auth({ type: 'app' });
  return token;
}

/**
 * The id of the App's installation on one repository, or `null` when the App is
 * not installed there (GitHub answers 404). Used by the setup callback to
 * confirm an install landed on the repository it was meant for before recording
 * it — never trusting the `installation_id` in the redirect on its own.
 */
export async function installationForRepo(owner, repo, env = process.env) {
  const jwt = await appJwt(env);
  if (!jwt) return null;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub said ${res.status} looking up the App installation for ${owner}/${repo}.`);
  const body = await res.json().catch(() => ({}));
  return body?.id ?? null;
}

// Testing seam: let a test reset the memoised auth instance between cases.
export function _resetAppAuthCache() {
  cachedAuth = null;
  cachedFor = null;
}
