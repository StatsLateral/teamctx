/**
 * How fresh the shared context is (#183): when something was last approved
 * into it, and how much is waiting for review. A stale context misleads an
 * assistant silently, so these are said wherever the context is read.
 *
 * Both are worked out from what the project already keeps, never stored: the
 * approval files (#143) and the review queue.
 */
import { readApprovals, listQueue } from './storage.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * `{ lastApprovedAt, waiting }`. `lastApprovedAt` is null on a project approved
 * before approvals were recorded: it has no date, and none is guessed. `keep`
 * narrows the queue, for a caller who may only see part of it.
 */
export function contextFreshness(teamctxDir, { keep = () => true } = {}) {
  const dates = Object.values(readApprovals(teamctxDir) || {})
    .map(a => a?.approvedAt)
    .filter(at => typeof at === 'string' && !Number.isNaN(Date.parse(at)));
  const lastApprovedAt = dates.length
    ? dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
    : null;
  return { lastApprovedAt, waiting: listQueue(teamctxDir).filter(keep).length };
}

function ago(at, now) {
  // Calendar days (UTC), so last night's approval reads "yesterday".
  const days = Math.max(0, Math.floor(now / DAY) - Math.floor(Date.parse(at) / DAY));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** "Context last approved 12 days ago; 3 items waiting for review." */
export function freshnessLine({ lastApprovedAt, waiting }, now = Date.now()) {
  const approved = lastApprovedAt ? `Context last approved ${ago(lastApprovedAt, now)}` : 'Context last approved: not recorded';
  const queue = waiting === 0 ? 'nothing waiting for review'
    : `${waiting} item${waiting === 1 ? '' : 's'} waiting for review`;
  return `${approved}; ${queue}.`;
}

/**
 * A role file with the line under its title. Added as the file is read, not
 * written into it: a role file is regenerated at each approval, so a line
 * written then would always say "today" and go stale with the file.
 */
export function withFreshness(md, line) {
  const text = String(md ?? '');
  const lines = text.split('\n');
  const title = lines.findIndex(l => /^#\s/.test(l));
  if (title === -1) return `*${line}*\n\n${text}`;
  lines.splice(title + 1, 0, '', `*${line}*`);
  return lines.join('\n');
}
