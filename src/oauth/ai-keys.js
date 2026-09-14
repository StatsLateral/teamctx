import { kvGet, kvSet, keys } from './kv.js';

/**
 * Where AI keys live on the hosted server, and which one a request runs on.
 *
 * Everything is keyed by verified email. The records this replaces were keyed by
 * GitHub id, so a person who saved a key while signed in with GitHub could not
 * find it when they arrived through Google — the same person, as far as the
 * manager gate and the roster were concerned, and a stranger to their own key.
 *
 * Records written before this change are still read, never rewritten behind the
 * owner's back: a personal key under a GitHub id, and a project's single shared
 * key. Nothing that works today stops working.
 *
 * Nothing here decides who may add a key; the settings page does that.
 */

const norm = email => String(email || '').trim().toLowerCase();

// ---- a person's own key ------------------------------------------------

export async function readPersonalKey({ email, githubId } = {}) {
  if (email) {
    const mine = await kvGet(keys.personalAiKey(norm(email)));
    if (mine?.apiKey) return mine;
  }
  if (githubId) {
    const legacy = await kvGet(keys.aiKey(String(githubId)));
    if (legacy?.apiKey) return legacy;
  }
  return null;
}

/**
 * Save or clear a person's own key.
 *
 * Clearing removes the GitHub-id record too. Otherwise a person who cleared
 * their key would find the old one quietly reappearing from the fallback.
 */
export async function writePersonalKey({ email, githubId, provider, apiKey } = {}) {
  if (!email) throw new Error('a verified email address is required to save a key');
  if (!apiKey) {
    await kvSet(keys.personalAiKey(norm(email)), null);
    if (githubId) await kvSet(keys.aiKey(String(githubId)), null);
    return null;
  }
  const record = { provider: provider || 'anthropic', apiKey };
  await kvSet(keys.personalAiKey(norm(email)), record);
  return record;
}

// ---- keys added to a project -------------------------------------------

/**
 * Every key added to a project.
 *
 * `byEmail` holds one entry per person. `legacy` is the single shared record from
 * before, if the project still has one — it carries a GitHub id rather than an
 * address, so it cannot be attributed to an email.
 */
export async function readProjectKeys(owner, repo) {
  const record = await kvGet(keys.projectAiKeys(owner, repo));
  const legacy = await kvGet(keys.projectAiKey(owner, repo));
  return {
    byEmail: record?.keys || {},
    legacy: legacy?.apiKey ? legacy : null,
  };
}

export async function addProjectKey({ owner, repo, email, provider, apiKey } = {}) {
  if (!email) throw new Error('a verified email address is required to add a project key');
  if (!apiKey) throw new Error('an API key is required');
  const who = norm(email);
  const record = (await kvGet(keys.projectAiKeys(owner, repo))) || { keys: {} };
  record.keys = {
    ...(record.keys || {}),
    [who]: { provider: provider || 'anthropic', apiKey, addedBy: who, addedAt: new Date().toISOString() },
  };
  await kvSet(keys.projectAiKeys(owner, repo), record);

  const slug = `${owner}/${repo}`;
  const mine = (await kvGet(keys.keysAddedBy(who)))?.projects || [];
  if (!mine.includes(slug)) await kvSet(keys.keysAddedBy(who), { projects: [...mine, slug] });
  return record.keys[who];
}

/** Only the person who added a key can take it away. */
export async function removeProjectKey({ owner, repo, email } = {}) {
  const who = norm(email);
  const record = (await kvGet(keys.projectAiKeys(owner, repo))) || { keys: {} };
  if (!record.keys?.[who]) return false;
  const { [who]: _gone, ...rest } = record.keys;
  await kvSet(keys.projectAiKeys(owner, repo), { ...record, keys: rest });

  const slug = `${owner}/${repo}`;
  const mine = (await kvGet(keys.keysAddedBy(who)))?.projects || [];
  await kvSet(keys.keysAddedBy(who), { projects: mine.filter(p => p !== slug) });
  return true;
}

/** Projects a person has added a key to. */
export async function projectsKeyedBy({ email, githubId } = {}) {
  const byEmail = email ? (await kvGet(keys.keysAddedBy(norm(email))))?.projects || [] : [];
  const legacy = githubId ? (await kvGet(keys.sharedProjects(String(githubId))))?.projects || [] : [];
  return [...new Set([...byEmail, ...legacy])].sort();
}

// ---- which key a request runs on ----------------------------------------

/**
 * The project key a request falls back to when the caller brought none.
 *
 * The primary manager's. Other people's keys are stored but never used unless
 * that person becomes primary, which is what makes a handoff a matter of
 * changing who is primary rather than moving a secret between people.
 *
 * A project from before this change has only its single shared record, and
 * keeps running on it until somebody adds a key under the new scheme.
 */
export function pickProjectKey({ projectKeys, primaryEmail } = {}) {
  const entry = primaryEmail ? projectKeys?.byEmail?.[norm(primaryEmail)] : null;
  if (entry?.apiKey) return { apiKey: entry.apiKey, provider: entry.provider || null, addedBy: entry.addedBy };
  if (projectKeys?.legacy?.apiKey) {
    return { apiKey: projectKeys.legacy.apiKey, provider: projectKeys.legacy.provider || null, addedBy: null };
  }
  return null;
}
