/**
 * How fresh the approved context is (#183).
 *
 * Derived, never stored: the newest `approvedAt` among the approval files, and
 * the length of the review queue. A project approved before approvals were
 * recorded has no date, and says so rather than guessing one.
 */
import { readApprovals, listQueue } from './storage.js';

const DAY = 24 * 60 * 60 * 1000;

/** `{ lastApprovedAt: ISO string | null, waiting: number }` for a project. */
export function freshness(dir, { approvals = readApprovals(dir), queue = listQueue(dir) } = {}) {
  const times = Object.values(approvals || {})
    .map(a => (typeof a?.approvedAt === 'string' ? Date.parse(a.approvedAt) : NaN))
    .filter(Number.isFinite);
  return {
    lastApprovedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    waiting: Array.isArray(queue) ? queue.length : 0,
  };
}

const ago = (iso, now) => {
  const days = Math.max(0, Math.floor((now - Date.parse(iso)) / DAY));
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

/** One line, in words: "Context last approved 12 days ago; 3 items waiting". */
export function freshnessLine({ lastApprovedAt, waiting }, now = Date.now()) {
  const approved = lastApprovedAt ? `last approved ${ago(lastApprovedAt, now)}` : 'last approved: not recorded';
  const queued = waiting === 0 ? 'nothing waiting' : `${waiting} item${waiting === 1 ? '' : 's'} waiting`;
  return `Context ${approved}; ${queued}`;
}

/**
 * A role file with the freshness line under its title. Added when the file is
 * read, not when it is written: "12 days ago" in a file written once would be
 * wrong by tomorrow.
 */
export function withFreshness(markdown, dir, now = Date.now()) {
  const line = `*${freshnessLine(freshness(dir), now)}*`;
  const text = String(markdown ?? '');
  const m = text.match(/^(# [^\n]*\n)/);
  return m ? `${m[1]}${line}\n${text.slice(m[1].length)}` : `${line}\n\n${text}`;
}
