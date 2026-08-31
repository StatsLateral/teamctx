import { managerKeys } from '../review.js';
import { matchesActor } from '../review.js';

/**
 * May this GitHub user lend a project's GitHub access?
 *
 * Two ways to qualify, and either is enough.
 *
 * **Repository admin.** Lending means handing out *your own* credential, so the
 * decision is about your account before it is about the project. Whoever can
 * administer the repository can already grant access to it by other means; this
 * is not a new authority, it is the same one spelled differently.
 *
 * **The project's manager**, matched against every identity the gate knows.
 * One person is a different key depending on how they connected — `git:<email>`
 * from a clone, `github:<id>` from the hosted server — so comparing a single
 * form refused people their own project. That is exactly how this went wrong
 * the first time.
 */
export function lendDecision({ config, actor, isAdmin = false, slug = 'this project' } = {}) {
  if (isAdmin) return { ok: true, via: 'admin' };

  const keys = managerKeys(config);
  if (keys.length === 0) {
    return {
      ok: false,
      why: `${slug} has no manager recorded, so lending needs admin access on the repository.`,
    };
  }
  if (keys.some(k => matchesActor(k, actor))) return { ok: true, via: 'manager' };

  return {
    ok: false,
    why: `${slug} is managed by someone else, and you do not have admin access on the repository.`,
  };
}
