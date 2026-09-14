import { kvGet, keys } from './kv.js';
import { readProjectKeys } from './ai-keys.js';

/**
 * The two checks that guard a change of manager on the hosted server.
 *
 * Both need the hosted store, which a clone cannot read, so they live here and
 * are handed to `cli/commands/manager.core.js` rather than run inside it.
 */

const LIST_MODELS = {
  anthropic: key => ['https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }],
  openai: key => ['https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }],
  // The key rides in a header, not the query string, so it never lands in a log.
  gemini: key => ['https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': key } }],
};

/**
 * Does this key work? Asked of the provider's list-models endpoint.
 *
 * It spends nothing: listing models needs a valid key and generates no tokens.
 * A rejected key and an unreachable provider are told apart, because calling a
 * working key broken over a network blip would refuse a promotion for nothing.
 */
export async function verifyProviderKey({ provider = 'anthropic', apiKey } = {}, fetchImpl = globalThis.fetch) {
  const build = LIST_MODELS[provider];
  if (!build) return { ok: false, why: `Unknown provider "${provider}", so the key could not be checked.` };
  if (!apiKey) return { ok: false, why: 'There is no key to check.' };
  let res;
  try {
    const [url, init] = build(apiKey);
    res = await fetchImpl(url, { method: 'GET', ...init });
  } catch {
    return { ok: false, transient: true, why: `Could not reach ${provider} to check the key just now. Try again in a minute.` };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    return { ok: false, why: `${provider} rejected the key (${res.status}).` };
  }
  return { ok: false, transient: true, why: `${provider} answered ${res.status} when checking the key. Try again in a minute.` };
}

/**
 * Before somebody becomes a manager: have they added a working key here?
 *
 * The project runs on its primary manager's key, and the incoming manager brings
 * their own rather than inheriting the builder's. So a promotion needs a key they
 * added to this project, by the address they are being promoted as — a key
 * someone else added, or one saved before keys were stored by address, does not
 * count, because it is not theirs.
 */
export function keyCheckFor({ owner, repo }, fetchImpl) {
  const slug = `${owner}/${repo}`;
  return async ({ email }) => {
    const entry = (await readProjectKeys(owner, repo)).byEmail[String(email).toLowerCase()];
    if (!entry?.apiKey) {
      return {
        ok: false,
        why: `${email} has not added a key to ${slug}. A manager brings their own key: they sign in to `
          + `the teamctx settings page as ${email}, add a key to ${slug}, and then they can be made a manager.`,
      };
    }
    const checked = await verifyProviderKey(entry, fetchImpl);
    if (!checked.ok) {
      return { ok: false, why: `The key ${email} added to ${slug} did not pass a check: ${checked.why}` };
    }
    return { ok: true, note: `key verified with ${entry.provider || 'anthropic'}` };
  };
}

/**
 * Before somebody leaves: does the project still run on something of theirs?
 *
 * Lent GitHub access belongs to whoever lent it, and only they can withdraw it.
 * Every member who signed in with Google reaches the project through it, so a
 * manager who steps out while it is still theirs can take those members' access
 * with them later, without being a manager any more.
 *
 * A lent record from before the lender's address was recorded cannot be matched
 * to anybody. That is refused too, with the one-step fix, rather than assumed to
 * be someone else's — assuming wrong strands every Google member at once.
 *
 * Their project key is not checked: the project runs on the primary manager's
 * key, and somebody stepping out is not, or is no longer, primary.
 */
export function stepOutCheckFor({ owner, repo }) {
  const slug = `${owner}/${repo}`;
  return async ({ email }) => {
    const lent = await kvGet(keys.projectGhCred(owner, repo));
    if (!lent?.token) return { ok: true };
    const leaving = String(email || '').toLowerCase();
    if (!lent.lentByEmail) {
      return {
        ok: false,
        why: `${slug} lends GitHub access, and it was lent before teamctx recorded who by, so there is no `
          + `way to tell whether it is ${leaving}'s. Whoever lent it can lend it again from the settings page `
          + 'to record it, or somebody else can lend it in their place.',
      };
    }
    if (String(lent.lentByEmail).toLowerCase() === leaving) {
      return {
        ok: false,
        why: `${slug}'s GitHub access is still lent by ${leaving}, and members who signed in with Google `
          + 'reach the project through it. Have somebody who is staying lend access from the settings page '
          + 'first, then step out.',
      };
    }
    return { ok: true };
  };
}
