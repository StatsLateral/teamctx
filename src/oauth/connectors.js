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
 * `primaryEmail` is the project's primary manager's verified email; omit it (or
 * pass the member's own) and only the member's own connection is considered.
 */
export async function pickConnection({ email, provider, primaryEmail } = {}) {
  const mine = await readConnection({ email, provider });
  if (mine) return { ...mine, via: 'own' };
  const primary = norm(primaryEmail);
  if (primary && primary !== norm(email)) {
    const managers = await readConnection({ email: primary, provider });
    if (managers) return { ...managers, via: 'project' };
  }
  return null;
}
