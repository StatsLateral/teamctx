/**
 * What rests on what.
 *
 * `links.restsOn` has been stored since the governed-records model landed, and
 * read by nothing — so the one question it exists to answer had never been
 * asked: when an assumption turns out to be wrong, which decisions and rules
 * were standing on it, and which tasks are being done because of those?
 *
 * Both answers here take a flat list of records rather than a tree, and that is
 * the point. A decision in one part of the work may rest on an assumption
 * recorded in another, or on the project's own. A walk given one tree would
 * answer "nothing rests on this" and be believed, which is worse than refusing
 * to answer. Callers pass every record in the project.
 */
import { isActive, today } from './model.js';

const restsOn = (record) => (record?.links?.restsOn || []).map(String);

/**
 * Index from an id to the active records that name it in `restsOn`.
 *
 * Built once per walk rather than scanned per step. The walk visits every
 * dependent and a project's records are one flat list, so without this,
 * following two levels costs the whole project twice over for an answer about
 * one assumption.
 */
function dependentIndex(records, onDay) {
  const index = new Map();
  for (const r of records) {
    if (!isActive(r, onDay)) continue;
    for (const id of restsOn(r)) {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(r);
    }
  }
  return index;
}

/**
 * Breadth-first from one record, with a visited set.
 *
 * The visited set does two jobs: each dependent is listed once however many
 * paths reach it, and two records that rest on each other stop rather than loop.
 * Order is the order the walk found them — what rests directly on it, then what
 * rests on those — which is the order a person would read them out in.
 *
 * `skip` is not a filter over the result. A skipped record is not traversed
 * either, so whatever rested on it is left alone: see `needsReviewFlags`, where
 * re-confirming a decision is supposed to settle the question for the rule
 * standing on that decision too.
 */
function walk(records, id, onDay, skip) {
  const index = dependentIndex(records, onDay);
  const seen = new Set([String(id)]);
  const found = [];
  let frontier = [String(id)];

  while (frontier.length) {
    const next = [];
    for (const current of frontier) {
      for (const r of index.get(current) || []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        if (skip && skip(r)) continue;
        found.push(r);
        next.push(r.id);
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Everything resting on a record, followed all the way down.
 *
 * No pruning: this is the list a manager is shown when they are about to break
 * an assumption, and the whole point is that it is complete.
 *
 * `tasks` are the tasks those records are attached to, each once. A task is not
 * a dependent in its own right — nothing rests *on* a task — but it is why the
 * answer matters: work is being done on the strength of a record that may no
 * longer hold.
 */
export function restingOn(records, id, { onDay = today(), tasks = [] } = {}) {
  const found = walk(records || [], id, onDay, null);

  const taskIds = [];
  for (const r of found) {
    const a = r.attachedTo;
    if (a?.kind === 'task' && a.id && !taskIds.includes(a.id)) taskIds.push(a.id);
  }
  const byId = new Map((tasks || []).map(t => [t.id, t]));
  return { records: found, tasks: taskIds.map(tid => byId.get(tid)).filter(Boolean) };
}

/**
 * Has this record been looked at since the thing under it broke?
 *
 * A replaced record leaves every brief on its own, because `isActive` says so.
 * One the manager re-confirms stays active while the assumption under it is
 * still broken, so the flag has to be cleared by something written down rather
 * than by the absence of a reason to show it.
 *
 * Full timestamps, not the date-only `updatedAt` a record already carries:
 * breaking an assumption and re-confirming what rested on it in the same sitting
 * is the ordinary case, and a date cannot tell those two apart in the right
 * order. Both halves fail closed — a record with no `reviewedAt` has never been
 * re-confirmed, and an assumption broken before this was recorded has no
 * `brokenAt` to measure against, which is worth a second look rather than a
 * silent pass.
 */
function reviewedSince(record, assumption) {
  if (!record?.reviewedAt || !assumption?.brokenAt) return false;
  return String(record.reviewedAt) >= String(assumption.brokenAt);
}

/**
 * Which active records are standing on something that broke.
 *
 * A map from a record's id to the ids of the broken assumptions under it, so a
 * caller can both flag the record and say what it is waiting on. Derived on read
 * rather than stamped onto dependents when the assumption breaks: a decision
 * written *after* the break rests on a broken assumption just the same, and
 * nobody should have to remember to flag it.
 *
 * Followed transitively, because standing on something itself unsound is the
 * same problem one step removed. A record the manager has re-confirmed stops the
 * walk there: they have said it still holds, so the rule resting on it is not
 * waiting on anybody — unless it also rests on something broken by its own path,
 * which is why each assumption is walked separately.
 */
export function needsReviewFlags(records, { onDay = today() } = {}) {
  const all = records || [];
  const flags = new Map();

  for (const broken of all) {
    if (broken.type !== 'assumption' || broken.status !== 'broken') continue;
    for (const r of walk(all, broken.id, onDay, (x) => reviewedSince(x, broken))) {
      if (!flags.has(r.id)) flags.set(r.id, []);
      const waiting = flags.get(r.id);
      if (!waiting.includes(broken.id)) waiting.push(broken.id);
    }
  }
  return flags;
}

/** The one sentence every brief says about a flagged record. */
export const NEEDS_REVIEW = 'needs review — rests on a broken assumption';

/**
 * Every record in the project, from the project's own tree and all the others.
 *
 * Here rather than at each read path on purpose. A brief is rendered from the
 * project plus the reader's own chain, which is less than the whole project — so
 * a caller computing flags from what it happened to have would miss a decision
 * resting on an assumption recorded somewhere else, and show it as sound. That
 * is a wrong answer delivered confidently, which is the failure this whole file
 * exists to prevent.
 *
 * It is a wider read than a brief needs, and that is the price of the flag being
 * right. The records are used to answer one question and are never rendered, so
 * nothing out of the reader's scope reaches the page — only the flag does, which
 * says that something they cannot see needs a second look, not what it is.
 */
export function allProjectRecords({ readTree, workstreamIds }) {
  const out = [];
  for (const id of [null, ...(workstreamIds || [])]) {
    const tree = readTree(id);
    for (const r of tree?.records || []) out.push(r);
  }
  return out;
}

/**
 * The flags for a whole project, as a set of record ids.
 *
 * A set rather than the map, for the renderers: a brief says one sentence about
 * a flagged record and does not name the assumption — which it may not be
 * allowed to show anyway. Callers wanting to say *what* it is waiting on use
 * `needsReviewFlags` directly.
 */
export function flaggedIds(records, { onDay = today() } = {}) {
  return new Set(needsReviewFlags(records, { onDay }).keys());
}
