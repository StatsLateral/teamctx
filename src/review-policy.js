/**
 * How much of a contribution needs a human in front of it.
 *
 * Review used to be all-or-nothing and unsettable: every contribution queued
 * for the manager. That is right for a team where the shared context is the
 * spec, and wrong for a small group aligning on something, where one person
 * ends up approving every note anyone writes before anyone else can see it.
 *
 * The choice is not "review notes or don't", though, which is why this is not a
 * boolean. A contribution is not an append: the distiller returns operations,
 * and some of those delete statements other people put there. So the axis that
 * matters is whether a contribution can *lose* information, not who sent it.
 */
import { managerKeys } from './review.js';

export const POLICIES = ['all', 'additive', 'none'];

/**
 * What a project with no policy recorded means.
 *
 * `all` rather than the new-project default, so upgrading changes nothing for
 * anyone: a project that has never heard of this setting keeps queueing
 * everything, exactly as it did before.
 */
export const DEFAULT_POLICY = 'all';

/**
 * What `init` records for a new project.
 *
 * Additive, because the common case — somebody adding what they know — should
 * not wait on an approval, and the case that can destroy someone else's work
 * still should. A team that wants the older behaviour is one command away.
 */
export const NEW_PROJECT_POLICY = 'additive';

const ADDITIVE_OPS = new Set(['addWhy', 'addWhat', 'addHow']);

export class InvalidReviewPolicyError extends Error {
  constructor(value) {
    super(`unknown review policy "${value}". Valid: ${POLICIES.join(', ')}.`);
    this.code = 'INVALID_REVIEW_POLICY';
  }
}

export function reviewPolicy(config) {
  const raw = config?.reviewPolicy;
  return POLICIES.includes(raw) ? raw : DEFAULT_POLICY;
}

/**
 * Does this set of operations only add?
 *
 * Unknown types count as destructive. A type this file has never heard of is
 * one added after it was written, and guessing "probably harmless" about an
 * operation we cannot describe is how a gate stops being one.
 */
export function isAdditive(operations) {
  const ops = operations || [];
  if (ops.length === 0) return true;
  return ops.every(op => ADDITIVE_OPS.has(op?.type));
}

/**
 * Must a human see this before it lands?
 *
 * Deliberately says nothing about who is calling. `apply: true` remains
 * manager-gated in `contributeCore`; this answers the different question of
 * whether review is required at all, and a member passing it is not thereby
 * acting as the manager.
 */
export function needsReview(config, operations) {
  const policy = reviewPolicy(config);
  if (policy === 'none') return false;
  if (policy === 'additive') return !isAdditive(operations);
  return true;
}

/**
 * May this caller rewrite shared context wholesale (`reflect`)?
 *
 * Under `none` anyone may, which is what the command did before this existed —
 * so no project loses a behaviour it was relying on. Under any other policy it
 * is the manager's, because a full-tree rewrite is the most destructive thing
 * in the product and there is no smaller unit of it to review.
 */
export function reflectNeedsManager(config) {
  return reviewPolicy(config) !== 'none' && managerKeys(config).length > 0;
}
