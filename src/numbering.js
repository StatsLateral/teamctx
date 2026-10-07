/**
 * The numbers a person can say out loud: `3` for a workstream, `3.2` for the
 * second task made in it.
 *
 * Only workstreams and tasks are numbered. A record (decision, rule, assumption,
 * exception) has an internal id that tools and links use and nobody reads; at
 * thousands of them a number says nothing about whether one is current. Nesting
 * is shown by indentation, never in the number: if Launch is `2`, its children
 * are `3` and `4`, and the next top-level part is `5`.
 *
 * A number is stored, minted once and never reused or renumbered, because the
 * point of one is that "approve 1.6" still means the same thing next week. The
 * counters live in `config.json` as `nextKey`: one for workstreams and one per
 * workstream for its tasks. A counter, not a count, so a number is not reused
 * after a delete: three tasks made and one removed leaves `3.1` and `3.3`, and
 * the next is `3.4`.
 */

/** What a project with nothing numbered yet starts from. */
export const emptyCounters = () => ({ workstream: 1, tasks: {} });

const positive = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 1);

/** Counters in a known shape, whatever was stored. Never mutates its argument. */
export function normalizeCounters(counters) {
  const tasks = {};
  for (const [id, n] of Object.entries(counters?.tasks || {})) tasks[id] = positive(n);
  return { workstream: positive(counters?.workstream), tasks };
}

/** `3`, a workstream's number as stored, or null. */
export function workstreamNumber(config, id) {
  const entry = (config?.workstreams || []).find(w => w?.id === id);
  return Number.isSafeInteger(entry?.number) && entry.number > 0 ? entry.number : null;
}

/** The next workstream number, and the counters to store. */
export function mintWorkstreamNumber(counters) {
  const current = normalizeCounters(counters);
  return { number: current.workstream, counters: { ...current, workstream: current.workstream + 1 } };
}

/** `3.2`: the next task number in a workstream, and the counters to store. */
export function mintTaskKey(counters, { number, workstream }) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`workstream "${workstream}" has no number to number a task from`);
  const current = normalizeCounters(counters);
  const n = current.tasks[workstream] || 1;
  return { key: `${number}.${n}`, counters: { ...current, tasks: { ...current.tasks, [workstream]: n + 1 } } };
}

/** `3.2` and nothing else: a workstream number, a dot, a task number. */
const TASK_KEY = /^[1-9]\d*\.[1-9]\d*$/;

export function isTaskKey(value) {
  return typeof value === 'string' && TASK_KEY.test(value);
}

/**
 * The internal id a task number names, or the value unchanged.
 *
 * Links keep carrying the internal id, which never changes. But the number is
 * what a person has in front of them, so `?task=3.2` has to reach the row that
 * `?task=t-write-the-post` reaches. A value that is not a number is returned
 * untouched, and a number naming nothing is too: it then resolves to no row,
 * the same quiet fallback an unknown id gets.
 */
export function resolveKey(value, { tasks = [] } = {}) {
  if (!isTaskKey(value)) return value;
  return tasks.find(t => t?.key === value)?.id ?? value;
}

/** A task asked for outside any workstream: the project's own work is a workstream too. */

export class TaskWithoutWorkstreamError extends Error {
  constructor(known = []) {
    super('A task belongs to a workstream, not to the project. '
      + (known.length
        ? `Say which one: ${known.join(', ')}.`
        : 'This project has no workstream yet: add one first (teamctx workstream add), then put the task in it.'));
    this.code = 'TASK_NEEDS_WORKSTREAM';
  }
}
