import { kvGet, keys } from './kv.js';
import { readProjectKeys } from './ai-keys.js';
import { verifyProviderKey } from '../providers/verify-key.js';

/**
 * The two checks that guard a change of manager on the hosted server.
 *
 * Both need the hosted store, which a clone cannot read, so they live here and
 * are handed to `cli/commands/manager.core.js` rather than run inside it.
 */

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
 * Before somebody becomes primary: is the project's lent GitHub access theirs?
 *
 * Members who signed in with Google — and agents — reach the project through
 * access one person lent. If that person is not the primary manager, the project
 * depends on somebody who can walk away with it, or who already has. So a
 * project that lends access can only be handed to the person lending it.
 *
 * A project that lends nothing has nothing here to depend on anyone, and passes.
 * Lending needs a GitHub sign-in, so an incoming primary without one cannot pass
 * on a project that lends; the refusal says so rather than pretending otherwise.
 */
export function lendCheckFor({ owner, repo }) {
  const slug = `${owner}/${repo}`;
  return async ({ email }) => {
    // A GitHub App installation is what the project actually reaches through when
    // it has one (#110), so the primary must be whoever installed it.
    const install = await kvGet(keys.projectInstallation(owner, repo));
    if (install?.installationId) {
      const incoming = String(email || '').toLowerCase();
      if (incoming && String(install.installedByEmail || '').toLowerCase() === incoming) {
        return { ok: true, note: 'GitHub App installed by them' };
      }
      const appSteps = `${email} installs the GitHub App on ${slug} themselves: if they are not a manager yet, add them as a co-manager; then they sign in to the teamctx settings page as ${email} and use Let members join without GitHub → Install the GitHub App. Then transfer again.`;
      return {
        ok: false,
        why: `${slug} runs on a GitHub App installation, and members who signed in with Google reach the project through it. `
          + `The primary manager has to be the one who installed it, so ${appSteps}`,
      };
    }
    const lent = await kvGet(keys.projectGhCred(owner, repo));
    if (!lent?.token) return { ok: true, note: 'no GitHub access lent' };
    const incoming = String(email || '').toLowerCase();
    if (incoming && String(lent.lentByEmail || '').toLowerCase() === incoming) {
      return { ok: true, note: 'GitHub access lent by them' };
    }
    const steps = `${email} lends it themselves first: if they are not a manager yet, add them as a co-manager; `
      + `then they sign in to the teamctx settings page with GitHub, as ${email}, and use Let members join `
      + 'without GitHub → Lend GitHub access. Lending needs a GitHub account with write access to the '
      + 'repository — a Google sign-in cannot lend. Then transfer again.';
    if (!lent.lentByEmail) {
      return {
        ok: false,
        why: `${slug} lends GitHub access, and it was lent before teamctx recorded who by. The primary manager `
          + `has to be the one lending it, so ${steps}`,
      };
    }
    return {
      ok: false,
      why: `${slug} lends GitHub access, and members who signed in with Google reach the project through it. `
        + `The primary manager has to be the one lending it, so the project does not depend on someone else — `
        + `so ${steps}`,
    };
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
  return async ({ email, key }) => {
    // When the project runs on a GitHub App installation (#110), stepping out is
    // the installer's dependency, the way lending is a lender's.
    const install = await kvGet(keys.projectInstallation(owner, repo));
    if (install?.installationId) {
      const leaving = String(email || '').toLowerCase();
      const who = leaving || key || 'this manager';
      const id = /^github:(\d+)$/.exec(String(key || ''))?.[1];
      const theirs = (leaving && String(install.installedByEmail || '').toLowerCase() === leaving)
        || (id && String(install.installedById) === id);
      if (theirs) {
        return {
          ok: false,
          why: `${slug} runs on a GitHub App ${who} installed, and members who signed in with Google reach it through that install. `
            + 'Have somebody who is staying install the App from the settings page first, then step out.',
        };
      }
      if (!install.installedByEmail && leaving) {
        return {
          ok: false,
          why: `${slug} runs on a GitHub App installed before teamctx recorded who by, so there is no way to tell whether it is `
            + `${leaving}'s. Whoever installed it can re-record it from the settings page, or somebody staying can install it in their place.`,
        };
      }
      return { ok: true };
    }
    const lent = await kvGet(keys.projectGhCred(owner, repo));
    if (!lent?.token) return { ok: true };
    const leaving = String(email || '').toLowerCase();
    const who = leaving || key || 'this manager';

    // A manager recorded the older ways — a GitHub id, or a login — has no
    // address, but the lent record carries both of those, so they can still be
    // matched. Checking the address alone let exactly those managers through.
    const id = /^github:(\d+)$/.exec(String(key || ''))?.[1];
    const login = /^@(.+)$/.exec(String(key || ''))?.[1];
    const theirs = (leaving && String(lent.lentByEmail || '').toLowerCase() === leaving)
      || (id && String(lent.lentById) === id)
      || (login && String(lent.lentByLogin || '').toLowerCase() === login.toLowerCase());
    if (theirs) {
      return {
        ok: false,
        why: `${slug}'s GitHub access is still lent by ${who}, and members who signed in with Google `
          + 'reach the project through it. Have somebody who is staying lend access from the settings page '
          + 'first, then step out.',
      };
    }
    if (!lent.lentByEmail && leaving) {
      return {
        ok: false,
        why: `${slug} lends GitHub access, and it was lent before teamctx recorded who by, so there is no `
          + `way to tell whether it is ${leaving}'s. Whoever lent it can lend it again from the settings page, `
          + 'which now records their address, or somebody who is staying can lend it in their place.',
      };
    }
    return { ok: true };
  };
}
