import { managerKeys, matchesActor } from '../review.js';
import { memberByEmail } from '../../cli/commands/member.core.js';

/**
 * May this person add a key to this project?
 *
 * Anyone on the project may: a manager, a roster member, or somebody with push
 * access to the repository. Not any signed-in stranger — a key attached to a
 * project spends that person's money on it, and one attached to a project they
 * are not on is either a mistake or a way to plant a key where it does not
 * belong.
 *
 * Push access is how a GitHub sign-in has always been checked, and it stays: it
 * is a stronger proof of being on the project than the roster is. A Google
 * sign-in has no push access to offer, so it is checked against the gate and the
 * roster instead, by the verified address it arrived with.
 *
 * Kept free of I/O so the rule can be read, and tested, on its own.
 */
export function projectKeyDecision({ config, email, hasPush = false, slug = 'this project' } = {}) {
  if (!email) {
    return {
      ok: false,
      why: 'Your sign-in did not come with a verified email address, so a key could not be '
        + 'attributed to you. Sign out and sign in again.',
    };
  }
  if (hasPush) return { ok: true, via: 'push' };

  if (!config) {
    return { ok: false, why: `Could not read ${slug}'s teamctx settings, so there is no way to tell whether you are on it.` };
  }

  const address = String(email).toLowerCase();
  const asActor = { key: `git:${address}`, email: address };
  if (managerKeys(config).some(k => matchesActor(k, asActor))) return { ok: true, via: 'manager' };
  if (memberByEmail(config.members, address)) return { ok: true, via: 'member' };

  return {
    ok: false,
    why: `${address} is not on ${slug}. Ask its manager to add that address, `
      + 'or sign in with the one they invited.',
  };
}
