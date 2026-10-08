/**
 * Who asked for a task, who said yes, and when it was done (#143).
 *
 * Derived, not stored: every event comes from something the project already
 * keeps — the contribution log, the approval and rejection files, the review
 * queue, and the task's own status log. A fact that was never recorded is left
 * out rather than guessed: a task from before approvals were recorded says
 * "Added", never "Approved".
 *
 * Pure on purpose. The caller decides what this reader may see: it passes the
 * queue and the rejections only to a manager, and `canSee` answers whether a
 * name may be shown; one that may not comes back as `by: null` ("someone").
 */

/** How a contribution arrived, in the words the history uses. */
const VIA = { mcp: 'assistant', cli: 'cli', web: 'web' };

/** Does this queued or rejected item propose a change to this task? */
export const touchesTask = (item, taskId) => (Array.isArray(item?.operations) ? item.operations : [])
  .some(op => ['editTask', 'removeTask'].includes(op?.type) && op.id === taskId);

/**
 * `{ status, waiting, events }` for one task.
 *
 * - `task`          the task, or `null` for something only in the queue
 * - `contributions` contribution id → `{ author, source, ts }`
 * - `approvals`     contribution id → `{ approvedBy: { name } | null, by?, approvedAt }`
 * - `rejected`      rejected items, each with `operations`, `rejectedBy`, `rejectedAt`, `reason`
 * - `queue`         waiting items, each with `operations`, `author`, `source`, `createdAt`
 * - `pending`       waiting items that are this thing itself (a task not yet approved)
 * - `canSee(name)`  may this reader see that name
 * - `isAgent(name)` is that name an agent
 *
 * `status` is `approved`, `added` (on the plan from before approvals were
 * recorded) or `not-approved` (only in the queue); `waiting` says a submission
 * about it is waiting for review.
 */
export function taskHistory({
  task = null, contributions = {}, approvals = {}, rejected = [], queue = [], pending = [],
  canSee = () => true, isAgent = () => false,
} = {}) {
  const name = (n) => (n && canSee(n) ? n : null);
  const via = (author, source) => (author && isAgent(author) ? 'agent' : VIA[source] || 'import');
  const events = [];
  const submitted = (item, at, extra = {}) => events.push({
    at: at || null, by: name(item.author), did: 'submitted', via: via(item.author, item.source), contribution: item.id, ...extra,
  });

  for (const id of task?.sourceContributionIds || []) {
    const c = contributions[id];
    if (c) submitted({ ...c, id }, c.ts);
    const a = approvals[id];
    if (a) {
      events.push({
        at: a.approvedAt || null,
        by: a.approvedBy ? name(a.approvedBy.name) : null,
        did: 'approved',
        contribution: id,
        // Went in under the project's review policy, with nobody approving it.
        ...(a.approvedBy ? {} : { byPolicy: true }),
      });
    }
  }

  for (const r of task ? rejected.filter(r => touchesTask(r, task.id)) : []) {
    submitted(r, r.createdAt || r.ts);
    events.push({ at: r.rejectedAt || null, by: name(r.rejectedBy), did: 'rejected', contribution: r.id, ...(r.reason ? { reason: r.reason } : {}) });
  }

  const waiting = [...pending, ...(task ? queue.filter(q => touchesTask(q, task.id)) : [])];
  for (const q of waiting) submitted(q, q.createdAt || q.ts, { waiting: true });

  const log = Array.isArray(task?.statusLog) ? task.statusLog : [];
  for (const s of log) {
    if (s?.did === 'completed' || s?.did === 'reopened') events.push({ at: s.at || null, by: name(s.by?.name), did: s.did });
  }
  // Completed before anyone recorded who did it: the date, and nobody named.
  if (!log.length && task?.status === 'done' && task.doneAt) events.push({ at: task.doneAt, by: null, did: 'completed', unrecorded: true });

  // On the plan, but nothing says how it got there: one line, nothing invented.
  const known = events.some(e => (e.did === 'submitted' && !e.waiting) || e.did === 'approved');
  if (task && !known) events.unshift({ at: task.createdAt || null, by: null, did: 'added' });

  // Oldest first. A date-only stamp sorts before a full time on the same day,
  // which is the order the older facts happened in anyway.
  const order = events.map((e, i) => [e, i]);
  order.sort(([a, i], [b, j]) => (a.at && b.at ? String(a.at).localeCompare(String(b.at)) : 0) || i - j);

  const status = !task ? 'not-approved' : events.some(e => e.did === 'approved') ? 'approved' : 'added';
  return { status, waiting: waiting.length > 0, events: order.map(([e]) => e) };
}

/** The status line, in words. */
export function historyStatus({ status, waiting }) {
  const base = { approved: 'Approved', added: 'Added', 'not-approved': 'Not approved yet' }[status] || 'Added';
  return waiting && status !== 'not-approved' ? `${base} · a new submission is waiting` : base;
}

/** One event, in words, without the date or the name in front. */
export function historyLine(e) {
  const how = { assistant: 'through an assistant', agent: 'as an agent', cli: 'from the command line', web: 'on the web', import: 'by import' };
  switch (e.did) {
    case 'submitted': return `submitted it ${how[e.via] || ''}`.trim();
    case 'approved': return e.byPolicy ? 'went in without review, under the project’s review policy' : 'approved it';
    case 'rejected': return `rejected it${e.reason ? `: ${e.reason}` : ''}`;
    case 'completed': return 'marked it done';
    case 'reopened': return 'reopened it';
    case 'added': return 'added to the plan';
    default: return '';
  }
}
