import { descendantsOf } from './model.js';
import { isProjectLevel } from './project-level.js';
import { inScope } from './member-scope.js';
import { asQuotedData } from './change-labels.js';

/**
 * What a change reaches, in brief (accepted-work spec, section 3).
 *
 * Pure and AI-free. The facts a manager needs before saying yes: what is added
 * and where, which parts inherit it, and which work in progress will be flagged
 * the next time somebody picks it up. Kept as data so many of these can be
 * merged later, and rendered to lines for the page and the assistant.
 */
// Adding is told apart from changing: "Adds 1 record" for an edit of an existing
// one would tell a manager something that is not so.
const RECORD_ADDS = new Set(['setGoal', 'addRecord']);
const RECORD_CHANGES = new Set(['editRecord', 'setRecordStatus', 'addEvidence']);
const TASK_ADDS = new Set(['addTask']);
const TASK_CHANGES = new Set(['editTask', 'removeTask']);
const SHOWN_TASKS = 3;

export function reachOf({ operations, treeId, config, tasks, hasWork, exclude = null }) {
  const ops = Array.isArray(operations) ? operations : [];
  const workstreams = config?.workstreams || [];
  const nameOf = (id) => workstreams.find(w => w.id === id)?.name || id;
  const count = (set) => ops.filter(o => set.has(o?.type)).length;
  const below = treeId == null ? workstreams.map(w => w.id) : descendantsOf(config, treeId);
  const scope = new Set(treeId == null ? workstreams.map(w => w.id) : [treeId, ...below]);
  return {
    adds: {
      label: treeId == null ? (config?.project || 'the project') : nameOf(treeId),
      // `records` and `tasks` are the totals, as before.
      records: count(RECORD_ADDS) + count(RECORD_CHANGES),
      tasks: count(TASK_ADDS) + count(TASK_CHANGES),
      recordsAdded: count(RECORD_ADDS),
      recordsChanged: count(RECORD_CHANGES),
      tasksAdded: count(TASK_ADDS),
      tasksChanged: count(TASK_CHANGES),
    },
    inheritedBy: below.map(id => ({ id, name: nameOf(id) })),
    // Project-level tasks carry no workstream, so a change to the project has to
    // ask for them explicitly.
    inProgress: (tasks || [])
      .filter(t => t.status !== 'done' && t.id !== exclude && (scope.has(t.workstream) || (treeId == null && isProjectLevel(t.workstream))) && hasWork(t))
      .map(t => ({ id: t.id, key: t.key || null, title: t.title, workstream: t.workstream ?? null })),
  };
}

/**
 * The part of a reach a scoped caller may see. A project-level change reaches
 * every part, and the lines name tasks and parts; a caller scoped to some
 * workstreams must not learn the titles of the others. A manager is never
 * scoped, so no scope means no limit.
 */
export function limitReach(reach, allowed) {
  if (!allowed) return reach;
  return {
    ...reach,
    inheritedBy: reach.inheritedBy.filter(p => allowed.includes(p.id)),
    inProgress: reach.inProgress.filter(t => inScope(allowed, t.workstream)),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function reachLines(reach) {
  const { adds, inheritedBy, inProgress } = reach;
  // Part and project names live in editable config, so they are quoted too.
  const label = asQuotedData(adds.label, 60);
  const said = (rec, tasks) => [rec && plural(rec, 'record'), tasks && plural(tasks, 'task')].filter(Boolean).join(' and ');
  const added = said(adds.recordsAdded, adds.tasksAdded);
  const changed = said(adds.recordsChanged, adds.tasksChanged);
  // Titles are contributor-written, so they are quoted as data.
  const shown = inProgress.slice(0, SHOWN_TASKS)
    .map(t => `${t.key ? `${t.key} ` : ''}${asQuotedData(t.title, 60)}`).join(', ');
  const rest = inProgress.length - SHOWN_TASKS;
  return [
    added && changed ? `Adds ${added} and changes ${changed} to ${label}.`
      : added ? `Adds ${added} to ${label}.`
      : changed ? `Changes ${changed} in ${label}.`
      : `Adds nothing to ${label}.`,
    inheritedBy.length ? `Inherited by ${inheritedBy.map(p => asQuotedData(p.name, 60)).join(', ')}.` : 'No other part inherits from this.',
    inProgress.length
      ? `Work in progress that will be flagged: ${shown}${rest > 0 ? ` and ${rest} more` : ''}.`
      : 'No work in progress is affected.',
  ];
}
