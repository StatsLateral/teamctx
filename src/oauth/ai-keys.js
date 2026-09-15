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
    // A cleared key leaves a marker rather than nothing. Without it, clearing
    // while signed in with Google — which has no GitHub id to clear the old
    // record by — fell straight back to that old record, and the key the person
    // had just removed carried on being used.
    if (mine) return mine.apiKey ? mine : null;
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
    await kvSet(keys.personalAiKey(norm(email)), { cleared: true, clearedAt: new Date().toISOString() });
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

export async function addProjectKey({ owner, repo, email, provider, apiKey, githubId, githubLogin } = {}) {
  if (!email) throw new Error('a verified email address is required to add a project key');
  if (!apiKey) throw new Error('an API key is required');
  const who = norm(email);
  const record = (await kvGet(keys.projectAiKeys(owner, repo))) || { keys: {} };
  // A key carried over from the project's old single shared record stays the
  // project's fallback when its owner replaces it; replacing a key is not the
  // same as giving up being the one the project leaned on.
  const wasFallback = !!record.keys?.[who]?.fromLegacy;
  record.keys = {
    ...(record.keys || {}),
    [who]: {
      ...(wasFallback ? { fromLegacy: true } : {}),
      provider: provider || 'anthropic', apiKey, addedBy: who, addedAt: new Date().toISOString(),
      // Recorded too, because some primary managers are stored by GitHub id or
      // login rather than by address, and their key has to be findable by that.
      ...(githubId ? { addedById: String(githubId) } : {}),
      ...(githubLogin ? { addedByLogin: String(githubLogin) } : {}),
    },
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
 * The project key that belongs to a manager, however the manager is written.
 *
 * Managers written from now on are `git:<email>`. Older ones can be
 * `github:<id>` — the web flow writes that when a session revealed no address —
 * or `@<login>`, and those have no address to look a key up by. Matching only
 * by address left such a primary unable to have their own key used at all.
 */
export function entryFor(projectKeys, managerKey) {
  const entries = Object.values(projectKeys?.byEmail || {});
  const key = String(managerKey || '').trim();
  const email = /^git:(.+)$/i.exec(key)?.[1];
  if (email) return projectKeys?.byEmail?.[norm(email)] || null;
  const id = /^github:(\d+)$/.exec(key)?.[1];
  if (id) return entries.find(e => e.addedById === id) || null;
  const login = /^@(.+)$/.exec(key)?.[1];
  if (login) return entries.find(e => String(e.addedByLogin || '').toLowerCase() === login.toLowerCase()) || null;
  return null;
}

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
export function pickProjectKey({ projectKeys, primaryKey } = {}) {
  const entry = entryFor(projectKeys, primaryKey);
  if (entry?.apiKey) return { apiKey: entry.apiKey, provider: entry.provider || null, addedBy: entry.addedBy };
  // The old single shared key, once carried over under its owner's address. It
  // keeps doing the job it did before — the fallback when the primary has added
  // none — and now its owner can see it and remove it from either sign-in.
  const carried = Object.values(projectKeys?.byEmail || {}).find(e => e.fromLegacy && e.apiKey);
  if (carried) return { apiKey: carried.apiKey, provider: carried.provider || null, addedBy: carried.addedBy };
  if (projectKeys?.legacy?.apiKey) {
    return { apiKey: projectKeys.legacy.apiKey, provider: projectKeys.legacy.provider || null, addedBy: null };
  }
  return null;
}

// ---- records saved before keys were stored by address --------------------

async function addToList(listKey, slug) {
  const list = (await kvGet(listKey))?.projects || [];
  if (!list.includes(slug)) await kvSet(listKey, { projects: [...list, slug] });
}

/**
 * Carry a GitHub account's older records over to its verified address.
 *
 * Records saved before this change were keyed by GitHub id. They were still
 * read on a GitHub sign-in, but a Google sign-in has no GitHub id to read them
 * by — so the same person saw their keys and their lent access through one
 * sign-in and nothing through the other. Run on a GitHub sign-in, which is the
 * one place both the id and the address are known, it moves them to the
 * address so every sign-in finds them.
 *
 * Nothing is lost or changes behaviour. A personal key is copied only when the
 * address has none. The project's old single shared key moves into the
 * per-person record marked as carried over, and keeps being the project's
 * fallback. Lent access gains the lender's address. Safe to run repeatedly.
 */
export async function adoptGithubRecords({ email, githubId, githubLogin } = {}) {
  if (!email || !githubId) return;
  const who = norm(email);
  const id = String(githubId);

  if (!(await kvGet(keys.personalAiKey(who)))) {
    const legacy = await kvGet(keys.aiKey(id));
    if (legacy?.apiKey) await kvSet(keys.personalAiKey(who), { provider: legacy.provider || 'anthropic', apiKey: legacy.apiKey });
  }

  const shared = (await kvGet(keys.sharedProjects(id)))?.projects || [];
  for (const slug of shared) {
    const [owner, repo] = slug.split('/');
    if (!owner || !repo) continue;
    const legacy = await kvGet(keys.projectAiKey(owner, repo));
    if (!legacy?.apiKey || String(legacy.sharedById) !== id) continue;
    const record = (await kvGet(keys.projectAiKeys(owner, repo))) || { keys: {} };
    if (!record.keys?.[who]) {
      record.keys = {
        ...(record.keys || {}),
        [who]: {
          provider: legacy.provider || 'anthropic', apiKey: legacy.apiKey,
          addedBy: who, addedAt: new Date().toISOString(),
          addedById: id, ...(githubLogin ? { addedByLogin: String(githubLogin) } : {}),
          fromLegacy: true,
        },
      };
    } else {
      record.keys[who] = { ...record.keys[who], fromLegacy: true };
    }
    await kvSet(keys.projectAiKeys(owner, repo), record);
    // Moved rather than copied: two records of one key is a key its owner could
    // remove from one place and still have running from the other.
    await kvSet(keys.projectAiKey(owner, repo), null);
    await addToList(keys.keysAddedBy(who), slug);
  }
  if (shared.length) await kvSet(keys.sharedProjects(id), { projects: [] });

  const lent = (await kvGet(keys.lentProjects(id)))?.projects || [];
  for (const slug of lent) {
    const [owner, repo] = slug.split('/');
    if (!owner || !repo) continue;
    const cred = await kvGet(keys.projectGhCred(owner, repo));
    if (!cred?.token || String(cred.lentById) !== id) continue;
    if (!cred.lentByEmail) await kvSet(keys.projectGhCred(owner, repo), { ...cred, lentByEmail: who });
    await addToList(keys.lentByAddress(who), slug);
  }
}

/** Record that an address connected to a project, for the settings page. */
export async function recordConnectedProject({ email, owner, repo } = {}) {
  if (!email || !owner || !repo) return;
  await addToList(keys.connectedProjects(norm(email)), `${owner}/${repo}`);
}

/** Every project an address is known to be on, for a Google sign-in's picker. */
export async function projectsKnownFor(email) {
  if (!email) return [];
  const who = norm(email);
  const lists = await Promise.all([
    kvGet(keys.connectedProjects(who)), kvGet(keys.keysAddedBy(who)), kvGet(keys.lentByAddress(who)),
  ]);
  return [...new Set(lists.flatMap(l => l?.projects || []))].sort();
}

