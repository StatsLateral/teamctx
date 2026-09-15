import { managerKeys, matchesActor } from './review.js';
import { isBrokenGate } from './manager-repair.js';

/**
 * Who manages a project, and the rules for changing that.
 *
 * Kept free of storage and git so the rules can be read, and tested, on their
 * own. `cli/commands/manager.core.js` does the reading, writing and committing.
 *
 * A project has one **primary** manager — `managerKey`, whose project key the
 * project runs on — and any number of **co-managers** in `managerKeys`, who
 * approve exactly as the primary does. Existing projects already have this
 * shape: their single `managerKey` is the primary, with no co-managers.
 */

export class ManagerChangeError extends Error {
  constructor(message, code = 'MANAGER_CHANGE') {
    super(message);
    this.code = code;
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * A manager, written the one way every surface can match.
 *
 * `git:<email>` is recognised from a clone, from a GitHub sign-in and from a
 * Google sign-in — `matchesActor` compares it against the caller's verified
 * address as well as their key. A GitHub id or a username each work on some
 * surfaces and not others, and a manager who can approve from one place and not
 * another is a gate that fails at the moment it is needed.
 */
export function managerKeyFor(ref) {
  const s = String(ref ?? '').trim().replace(/^git:/i, '');
  if (!EMAIL.test(s)) {
    throw new ManagerChangeError(
      `"${ref}" is not an email address. A manager is identified by email, so they are `
      + 'recognised whether they arrive from a clone, GitHub or Google.',
      'MANAGER_NOT_EMAIL',
    );
  }
  return `git:${s.toLowerCase()}`;
}

/** The address behind a `git:` key, or null for a key that has none. */
export function emailOfKey(key) {
  const m = /^git:(.+)$/i.exec(String(key || '').trim());
  return m ? m[1].toLowerCase() : null;
}

/** The primary manager and the co-managers, as stored. */
export function managersOf(config) {
  const all = managerKeys(config);
  const primary = String(config?.managerKey || '').trim() || all[0] || null;
  return {
    primary,
    coManagers: all.filter(k => k !== primary),
  };
}

/**
 * Write the gate back, in the one shape both this and repair leave it in.
 *
 * `managerKey` is the primary and `managerKeys` holds only the others — never
 * the primary twice — so a reader that still looks at `managerKey` alone finds
 * the person whose key the project runs on.
 */
export function withManagers(config, { primary, coManagers = [] }) {
  const others = [...new Set(coManagers.map(k => String(k).trim()).filter(Boolean))]
    .filter(k => k !== primary);
  return { ...config, managerKey: primary, managerKeys: others };
}

function sameKey(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/**
 * Refuse to change a gate that is not really a gate.
 *
 * A display-name gate matches nobody, so the caller passed `assertManager` only
 * because the legacy path lets a name through. Adding a co-manager beside it
 * would dress an unmatchable gate up as a working one; repair is the way out.
 */
function assertRealGate(config) {
  if (isBrokenGate(config)) {
    throw new ManagerChangeError(
      'This project\'s manager gate is a display name, which nobody can match. Repair it first — '
      + '`teamctx config manager --repair`, or ask your assistant to repair the manager gate.',
      'MANAGER_GATE_BROKEN',
    );
  }
}

/** Add a co-manager. */
export function planAdd(config, ref) {
  assertRealGate(config);
  const key = managerKeyFor(ref);
  const { primary, coManagers } = managersOf(config);
  if (sameKey(key, primary) || coManagers.some(k => sameKey(k, key))) {
    throw new ManagerChangeError(`${emailOfKey(key)} is already a manager.`, 'MANAGER_EXISTS');
  }
  // No `promotes`: a co-manager approves, but the project never runs on their
  // key, so there is nothing about them for a key check to test.
  return {
    key,
    next: withManagers(config, { primary, coManagers: [...coManagers, key] }),
  };
}

/**
 * Take a co-manager off.
 *
 * The primary cannot be removed this way. It is the manager the project runs
 * on, so removing them would leave either no manager — which `canApprove` reads
 * as no gate at all, letting anyone approve — or a project running on nobody's
 * key. Transferring first is the way out.
 */
export function planRemove(config, ref) {
  assertRealGate(config);
  const key = managerKeyFor(ref);
  const { primary, coManagers } = managersOf(config);
  if (sameKey(key, primary)) {
    throw new ManagerChangeError(
      `${emailOfKey(key)} is the primary manager and cannot simply be removed. `
      + 'Transfer the primary role to someone else first, then step down.',
      'MANAGER_IS_PRIMARY',
    );
  }
  if (!coManagers.some(k => sameKey(k, key))) {
    throw new ManagerChangeError(`${emailOfKey(key)} is not a manager of this project.`, 'MANAGER_NOT_FOUND');
  }
  return {
    key,
    next: withManagers(config, { primary, coManagers: coManagers.filter(k => !sameKey(k, key)) }),
    leaves: key,
  };
}

/**
 * Make someone else the primary manager.
 *
 * Only the primary may do this. A co-manager able to make themselves primary
 * would move the project onto their own key over the primary's head — a
 * takeover, not a handoff.
 *
 * The outgoing primary stays on as a co-manager unless `stepDown` is set.
 */
export function planTransfer(config, ref, { actor, stepDown = false } = {}) {
  assertRealGate(config);
  const key = managerKeyFor(ref);
  const { primary, coManagers } = managersOf(config);
  if (!primary || !matchesActor(primary, actor)) {
    throw new ManagerChangeError(
      'Only the primary manager can hand the primary role over. Co-managers approve exactly as '
      + 'the primary does, but the project runs on the primary\'s key, so moving that is theirs to do.',
      'MANAGER_NOT_PRIMARY',
    );
  }
  if (sameKey(key, primary)) {
    throw new ManagerChangeError(`${emailOfKey(key)} is already the primary manager.`, 'MANAGER_EXISTS');
  }
  const others = coManagers.filter(k => !sameKey(k, key));
  return {
    key,
    next: withManagers(config, {
      primary: key,
      coManagers: stepDown ? others : [...others, primary],
    }),
    promotes: key,
    ...(stepDown ? { leaves: primary } : {}),
  };
}
