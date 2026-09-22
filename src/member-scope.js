/**
 * Which workstreams a member may reach.
 *
 * Members have always been project-wide, and the reasoning was sound: everyone
 * held a clone, and anyone who can read the repo reads every workstream, so a
 * per-workstream label would have enforced nothing.
 *
 * That stopped being true of every member. Since #50 someone signing in with
 * Google has no repository access of their own — every read goes through the
 * server on the project's lent credential. For them the server is the only
 * path, so a scope is enforceable rather than decorative.
 *
 * It is still decorative for anybody holding a clone, and the tool descriptions
 * and `member add` output say so rather than implying a wall that isn't there.
 * A boundary that is honest about where it stops is worth more than one that
 * quietly doesn't hold.
 */

import { isProjectLevel } from './project-level.js';

export class WorkstreamOutOfScopeError extends Error {
  constructor(id, allowed) {
    super(`no workstream "${id}" on this project`);
    this.code = 'WORKSTREAM_OUT_OF_SCOPE';
    this.workstream = id;
    this.allowed = allowed;
  }
}

/**
 * The workstream list on a roster entry, normalised.
 *
 * `null` means project-wide — and so does an empty or malformed list, because
 * a member whose scope cannot be read must not silently become a member who
 * can see nothing. The failure of a scope should be the state that existed
 * before scopes, not a lockout.
 */
export function memberWorkstreams(member) {
  const raw = member?.workstreams;
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(w => String(w ?? '').trim()).filter(Boolean);
  return ids.length ? [...new Set(ids)] : null;
}

/**
 * The roster entry that is this caller, or null.
 *
 * Matched by key, by verified address, or by GitHub login — every form one person
 * arrives in. Exported so the display name can come from the entry too.
 */
export function rosterEntry(config, actor) {
  const members = config?.members || [];
  if (!members.length || !actor) return null;
  const key = String(actor.key || '').toLowerCase();
  const email = String(actor.email || '').toLowerCase();
  const login = String(actor.login || '').toLowerCase();
  return members.find(m => {
    const mk = String(m.key || '').toLowerCase();
    const me = String(m.email || '').toLowerCase();
    const ml = String(m.login || '').toLowerCase();
    return (key && (mk === key || key === `git:${me}`))
      || (email && me === email)
      || (login && ml === login);
  }) || null;
}

/**
 * The caller's scope: `null` for project-wide, otherwise the workstream ids.
 *
 * The manager is never scoped. They own the gate for the whole project, and a
 * manager who could not read half of it could not review contributions to that
 * half — which is the one thing only they can do.
 */
export function scopeFor(config, actor, { isManager = false } = {}) {
  if (isManager) return null;
  return memberWorkstreams(rosterEntry(config, actor));
}

/**
 * Project level is in everybody's scope.
 *
 * A scope narrows which workstreams a member reaches, and the project tree is
 * not one of them — it is the base every workstream inherits, so a member who
 * could not read it would be reading half of their own workstream's context.
 * Scoping starts below the project, not at it.
 */
export function inScope(scope, id) {
  if (!scope) return true;
  if (isProjectLevel(id)) return true;
  return scope.includes(String(id ?? '').trim());
}

/**
 * Refuse a workstream outside the caller's scope the way an unknown one is
 * refused.
 *
 * Deliberately the same error and the same wording. A member who is told "you
 * are not allowed workstream X" has learned that X exists and roughly what it
 * is called, which is the thing the scope was meant to keep from them; and an
 * empty result instead of an error would read as "there is nothing there",
 * which is worse than either.
 */
export function assertInScope(scope, id) {
  if (!inScope(scope, id)) throw new WorkstreamOutOfScopeError(id, scope);
  return id;
}

/** The subset of `ids` this caller may see, in the original order. */
export function visibleWorkstreams(scope, ids) {
  if (!scope) return [...(ids || [])];
  return (ids || []).filter(id => scope.includes(id));
}

/**
 * Where the caller should be working when they have not said.
 *
 * A scoped member's stored preference may name a workstream they are no longer
 * on — scopes change, preferences do not — so the fallback is the first
 * workstream they can actually reach rather than the project default, which
 * for them may not exist.
 */
export function defaultWorkstream(scope, preferred) {
  if (!scope) return preferred;
  // A scoped member may *read* the project, but it is not where they should
  // land when they have said nothing — their own workstream is, and that is
  // what `contribute` and `ask` would otherwise silently aim at.
  if (isProjectLevel(preferred)) return scope[0];
  return scope.includes(String(preferred).trim()) ? preferred : scope[0];
}
