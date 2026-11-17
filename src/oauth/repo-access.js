/**
 * How the deployment gets a token to read and write a project's repository on
 * behalf of someone who has no GitHub credential of their own — a Google-signed
 * member or an agent (#110).
 *
 * Two sources, in order:
 *   1. A **GitHub App installation** on the project's repository. The token is
 *      minted fresh, scoped to that repository, and expires in an hour.
 *   2. The **legacy lent OAuth token** (`projectGhCred`), a user token with full
 *      `repo` scope. Kept working through the migration; the installation is
 *      preferred over it when a project has one.
 *
 * Everywhere that used to read `(await kvGet(keys.projectGhCred))?.token` calls
 * `projectRepoToken` instead, so the installation path reaches all of them at
 * once when the install flow lands. Until a project records an installation,
 * this resolves to exactly the legacy token, so it is a no-op for every existing
 * deployment.
 */
import { kvGet, keys } from './kv.js';
import { installationTokenFor } from './github-app.js';

/**
 * The credential a project lends, resolved to a usable token, or `null` when it
 * lends none. Returns `via` so a caller can tell an App installation from a
 * legacy lent token, and the stored record behind it.
 *
 * @returns {Promise<{ token: string, via: 'installation'|'lent', installation?: object, lent?: object }|null>}
 */
export async function projectRepoCredential(owner, repo, env = process.env) {
  const installation = await kvGet(keys.projectInstallation(owner, repo));
  if (installation?.installationId) {
    // Once a project is on an installation, that is the only credential — a
    // failed mint (the install was removed, the key is wrong) reads as no
    // access, never a silent widening back to the broader legacy token.
    const token = await installationTokenFor(installation.installationId, env);
    return token ? { token, via: 'installation', installation } : null;
  }
  const lent = await kvGet(keys.projectGhCred(owner, repo));
  if (lent?.token) return { token: lent.token, via: 'lent', lent };
  return null;
}

/** Just the token a project lends, or `null`. The common case. */
export async function projectRepoToken(owner, repo, env = process.env) {
  const cred = await projectRepoCredential(owner, repo, env);
  return cred?.token || null;
}

/**
 * Whether a project lends any GitHub access at all — an installation or a legacy
 * token — without minting a token to find out. For the "is access lent" gates.
 */
export async function projectLendsAccess(owner, repo) {
  const installation = await kvGet(keys.projectInstallation(owner, repo));
  if (installation?.installationId) return true;
  return !!(await kvGet(keys.projectGhCred(owner, repo)))?.token;
}
