import { kvGet, kvSet, keys } from './kv.js';

/**
 * Where a person's cloud-connector connections live on the hosted server, and
 * which connection a file read runs on (#248 prerequisite).
 *
 * A connection is the OAuth grant between a teamctx account and a provider
 * (Google Drive, Dropbox, SharePoint/M365). It is **per person, global, once** —
 * the same grant is used across every project the person is on — so there is
 * nothing per-project to connect or track. This mirrors how an AI key works
 * (src/oauth/ai-keys.js): a personal credential in encrypted KV, where the
 * primary manager's doubles as the project's fallback.
 *
 * Everything is keyed by verified email, like AI keys, so the same person is
 * recognised whether they signed in with GitHub or Google. The token record is a
 * credential and is encrypted at rest (the `teamctx:connector:token:` prefix);
 * the index of which providers a person has connected carries no secret.
 *
 * Nothing here decides who may connect, or runs the OAuth handshake — the
 * settings page and the per-provider routes do that. This is only the store and
 * the resolver.
 */

const norm = email => String(email || '').trim().toLowerCase();

// ---- a person's own connection -----------------------------------------

/** A person's connection for one provider, or null when they have not connected it. */
export async function readConnection({ email, provider } = {}) {
  if (!email || !provider) return null;
  const rec = await kvGet(keys.connectorToken(norm(email), provider));
  return rec && rec.accessToken ? rec : null;
}

/**
 * Save a person's connection for one provider, and add it to their index.
 *
 * Replacing an existing connection (a re-connect, a refreshed token) overwrites
 * in place — one account, one record per provider.
 */
export async function writeConnection({ email, provider, accessToken, refreshToken, expiresAt, account } = {}) {
  if (!email) throw new Error('a verified email address is required to connect an account');
  if (!provider) throw new Error('a provider is required to connect an account');
  if (!accessToken) throw new Error('an access token is required to connect an account');
  const record = {
    provider,
    accessToken,
    refreshToken: refreshToken || null,
    expiresAt: expiresAt || null,
    account: account || null,
    connectedAt: new Date().toISOString(),
  };
  await kvSet(keys.connectorToken(norm(email), provider), record);
  const have = (await kvGet(keys.connectorIndex(norm(email))))?.providers || [];
  if (!have.includes(provider)) {
    await kvSet(keys.connectorIndex(norm(email)), { providers: [...have, provider] });
  }
  return record;
}

/** Remove a person's connection for one provider. Returns whether one was there. */
export async function removeConnection({ email, provider } = {}) {
  if (!email || !provider) return false;
  const existing = await kvGet(keys.connectorToken(norm(email), provider));
  await kvSet(keys.connectorToken(norm(email), provider), null);
  const have = (await kvGet(keys.connectorIndex(norm(email))))?.providers || [];
  await kvSet(keys.connectorIndex(norm(email)), { providers: have.filter(p => p !== provider) });
  return !!(existing && existing.accessToken);
}

/** The providers a person has connected, for the settings page. */
export async function connectionsFor(email) {
  if (!email) return [];
  return (await kvGet(keys.connectorIndex(norm(email))))?.providers || [];
}

// ---- sharing a connection with a project --------------------------------

/**
 * Share one's connection with a project, so it can serve as the project's
 * fallback reader. This mirrors "add a key to a project" (ai-keys.js): the
 * person decides which projects their connection reaches, rather than it
 * reaching every project they happen to manage. No token moves — only a pointer
 * is recorded; the credential stays in the owner's own `connectorToken`.
 *
 * Idempotent. The caller gates who may share (the settings route does).
 */
export async function shareConnection({ owner, repo, email, provider } = {}) {
  if (!owner || !repo || !email || !provider) throw new Error('owner, repo, email and provider are required to share a connection');
  const who = norm(email);
  const record = (await kvGet(keys.projectConnectors(owner, repo))) || { shares: {} };
  const have = record.shares?.[who] || [];
  if (!have.includes(provider)) {
    record.shares = { ...(record.shares || {}), [who]: [...have, provider] };
    await kvSet(keys.projectConnectors(owner, repo), record);
  }
  const slug = `${owner}/${repo}`;
  const index = (await kvGet(keys.connectorsSharedBy(who)))?.shares || [];
  if (!index.some(s => s.slug === slug && s.provider === provider)) {
    await kvSet(keys.connectorsSharedBy(who), { shares: [...index, { slug, provider }] });
  }
  return true;
}

/** Stop sharing one's connection with a project. Returns whether one was there. */
export async function unshareConnection({ owner, repo, email, provider } = {}) {
  if (!owner || !repo || !email || !provider) return false;
  const who = norm(email);
  const record = (await kvGet(keys.projectConnectors(owner, repo))) || { shares: {} };
  const have = record.shares?.[who] || [];
  const had = have.includes(provider);
  if (had) {
    const left = have.filter(p => p !== provider);
    const shares = { ...(record.shares || {}) };
    if (left.length) shares[who] = left; else delete shares[who];
    await kvSet(keys.projectConnectors(owner, repo), { ...record, shares });
  }
  const slug = `${owner}/${repo}`;
  const index = (await kvGet(keys.connectorsSharedBy(who)))?.shares || [];
  await kvSet(keys.connectorsSharedBy(who), { shares: index.filter(s => !(s.slug === slug && s.provider === provider)) });
  return had;
}

/** Whether this person has shared this provider's connection with this project. */
export async function connectionSharedWith({ owner, repo, email, provider } = {}) {
  if (!owner || !repo || !email || !provider) return false;
  const record = await kvGet(keys.projectConnectors(owner, repo));
  return !!record?.shares?.[norm(email)]?.includes(provider);
}

/** The projects a person has shared a connection with, as `{ slug, provider }[]`. */
export async function connectorSharesBy(email) {
  if (!email) return [];
  return (await kvGet(keys.connectorsSharedBy(norm(email))))?.shares || [];
}

// ---- which connection a read runs on ------------------------------------

/**
 * The connection a server-side file read uses for one person and provider:
 * their own first, then the project's primary manager's, else null.
 *
 * This is the member → manager fallback. The manager's token is used on the
 * member's behalf, server-side, and never handed out — the member only ever
 * gets the answer it produced. `via` says which one answered, so a verdict built
 * on it stays traceable.
 *
 * The manager's connection serves a project only when the manager has
 * explicitly shared it there (connectionSharedWith) — the same deliberate
 * per-project choice "add a key to a project" is, not every project they manage.
 * So the fallback needs `owner`, `repo` and the primary manager's `primaryEmail`;
 * with any of them missing, only the person's own connection is considered.
 */
export async function pickConnection({ email, provider, owner, repo, primaryEmail } = {}) {
  const mine = await readConnection({ email, provider });
  if (mine) return { ...mine, via: 'own' };
  const primary = norm(primaryEmail);
  if (primary && primary !== norm(email) && owner && repo
      && await connectionSharedWith({ owner, repo, email: primary, provider })) {
    const managers = await readConnection({ email: primary, provider });
    if (managers) return { ...managers, via: 'project' };
  }
  return null;
}
