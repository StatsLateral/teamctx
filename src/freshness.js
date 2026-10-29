/**
 * How fresh the shared context is (#183): when something was last approved
 * into it, and how much is waiting for review. A stale context misleads an
 * assistant silently, so these are said wherever the context is read.
 *
 * Both are worked out from what the project already keeps, never stored: the
 * approval files (#143) and the review queue.
 */
import { readApprovals, listQueue } from './storage.js';
import { inScope } from './member-scope.js';
import { isProjectLevel, resolveTarget } from './project-level.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * `{ lastApprovedAt, waiting }`, or null when it cannot be worked out (a queue
 * file that is not valid JSON, say): this is a line beside the context, and it
 * must never take down what it sits beside.
 *
 * `lastApprovedAt` is null on a project approved before approvals were
 * recorded: it has no date, and none is guessed.
 *
 * Both count only what the reader may see (`scope`), and for a role file only
 * its own part of the work and the project around it (`role`): an approval in
 * a sibling part neither changes that file nor is that reader's to know about.
 */
export function contextFreshness(teamctxDir, { scope = null, role = null } = {}) {
  const roleWs = role && !isProjectLevel(resolveTarget(role.workstream)) ? resolveTarget(role.workstream) : null;
  const keep = (entry) => {
    const ws = resolveTarget(entry?.workstream);
    if (!inScope(scope && scope.length ? scope : null, ws)) return false;
    return !roleWs || isProjectLevel(ws) || ws === roleWs;
  };
  try {
    const dates = Object.values(readApprovals(teamctxDir) || {})
      .filter(keep)
      .map(a => a?.approvedAt)
      .filter(at => typeof at === 'string' && !Number.isNaN(Date.parse(at)));
    const lastApprovedAt = dates.length
      ? dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
      : null;
    return { lastApprovedAt, waiting: listQueue(teamctxDir).filter(keep).length };
  } catch {
    return null;
  }
}

const startOfDay = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

function ago(at, now) {
  // Calendar days where it is read, so last night's approval reads "yesterday".
  // Rounded: a day with a clock change is not 24 hours long.
  const days = Math.max(0, Math.round((startOfDay(now) - startOfDay(Date.parse(at))) / DAY));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** "Context last approved 12 days ago; 3 items waiting for review." Null when there is nothing to say. */
export function freshnessLine(fresh, now = Date.now()) {
  if (!fresh) return null;
  const { lastApprovedAt, waiting } = fresh;
  const approved = lastApprovedAt ? `Context last approved ${ago(lastApprovedAt, now)}` : 'Context last approved: not recorded';
  const queue = waiting === 0 ? 'nothing waiting for review'
    : `${waiting} item${waiting === 1 ? '' : 's'} waiting for review`;
  return `${approved}; ${queue}.`;
}

/**
 * A role file with the line under its title, as its own paragraph. Added as the
 * file is read, not written into it: a role file is regenerated at each
 * approval, so a line written then would always say "today" and go stale with
 * the file.
 */
export function withFreshness(md, line) {
  const text = String(md ?? '');
  if (!line) return text;
  const lines = text.split('\n');
  const title = lines.findIndex(l => /^#\s/.test(l));
  if (title === -1) return `*${line}*\n\n${text}`;
  const next = lines[title + 1];
  lines.splice(title + 1, 0, '', `*${line}*`, ...(next && next.trim() ? [''] : []));
  return lines.join('\n');
}
