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

export const POLICIES = ['all', 'additive', 'none'];

/**
 * What a project with no policy recorded means, and what `init` records.
 *
 * One value, where there used to be two. A project that has never heard of this
 * setting has always queued everything; a new one used to be created `additive`,
 * on the reasoning that somebody adding what they know should not wait on an
 * approval while the case that can destroy someone else's work still should.
 *
 * That reasoning picked the wrong axis. Whether a contribution can *lose*
 * information is not the only thing worth a person's eye — whether anyone has
 * read it is the other. Under `additive`, a member's assistant could add
 * statements straight into the context every other member's assistant then reads
 * as the team's own position. That is where a poisoned document or thread lands:
 * the member never wrote those words, and under this policy nobody had to agree
 * to them.
 *
 * So new projects queue everything, which is also what the product says of
 * itself. `additive` is still there for a team that wants it, one command away,
 * and a project that recorded it keeps it — see the note on migration in
 * docs/proposals/review-everything-by-default.md.
 */
export const DEFAULT_POLICY = 'all';
export const NEW_PROJECT_POLICY = DEFAULT_POLICY;

const NEVER_ADDITIVE_RECORDS = new Set(['decision', 'rule', 'exception']);

// A task, or a record that only adds something low-stakes. Decisions, rules and
// exceptions change what the whole team must follow, so they always wait.
function opIsAdditive(op) {
  if (op?.type === 'addTask') return true;
  if (op?.type === 'addRecord') return !NEVER_ADDITIVE_RECORDS.has(op.record?.type);
  return false;
}

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
  // Not the same call as the unknown-type one below, though it looks like it.
  // An operation this file cannot describe might destroy something, so it fails
  // closed. An empty list destroys nothing by definition, so there is nothing
  // to hold for review. (`contributeCore` returns a no-op before reaching here
  // anyway; this keeps the function answerable on its own terms.)
  if (ops.length === 0) return true;
  return ops.every(opIsAdditive);
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

