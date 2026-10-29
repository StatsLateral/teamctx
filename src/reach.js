import { descendantsOf } from './model.js';
import { isProjectLevel } from './project-level.js';
import { inScope } from './member-scope.js';
import { asQuotedData } from './change-labels.js';
import { isSignificant, tasksNamedBy } from './changes.js';

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

export function reachOf({ operations, treeId, config, tasks, hasWork, exclude = null, records = [] }) {
  const ops = Array.isArray(operations) ? operations : [];
  // Only what a task would actually be shown flags it (#206): a significant
  // change flags everything below it, anything else only the tasks it names.
  // `records` is the tree as it stands, so an edit can be told by its type.
  const flagsAll = isSignificant(ops, { records });
  const named = tasksNamedBy(ops);
  const workstreams = config?.workstreams || [];
  const nameOf = (id) => workstreams.find(w => w.id === id)?.name || id;
  const count = (set) => ops.filter(o => set.has(o?.type)).length;
  const below = treeId == null ? workstreams.map(w => w.id) : descendantsOf(config, treeId);
  const scope = new Set(treeId == null ? workstreams.map(w => w.id) : [treeId, ...below]);
  return {
    adds: {
      tree: treeId ?? null,
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
      .filter(t => t.status !== 'done' && t.id !== exclude && (flagsAll || named.has(t.id)) && (scope.has(t.workstream) || (treeId == null && isProjectLevel(t.workstream))) && hasWork(t))
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

const COUNTS = ['records', 'tasks', 'recordsAdded', 'recordsChanged', 'tasksAdded', 'tasksChanged'];
const SHOWN_PARTS = 3;

/**
 * Many reaches as one (#206): forty waiting items as "12 reach Registration",
 * not forty cards. Totals are summed, each part reached says how many items
 * reach it (as the change's own part or by inheriting it), and each task in
 * progress is listed once however many items would flag it. Takes any reaches,
 * so it serves candidates as well as waiting items.
 */
export function mergeReach(reaches) {
  const list = (Array.isArray(reaches) ? reaches : []).filter(r => r && r.adds);
  const adds = Object.fromEntries(COUNTS.map(k => [k, list.reduce((n, r) => n + (Number(r.adds[k]) || 0), 0)]));
  const parts = new Map();
  const tasks = new Map();
  for (const r of list) {
    const reached = new Map([[r.adds.tree ?? null, r.adds.label], ...(r.inheritedBy || []).map(p => [p.id, p.name])]);
    for (const [id, name] of reached) {
      const part = parts.get(id) || { id, name, items: 0 };
      part.items += 1;
      parts.set(id, part);
    }
    for (const t of r.inProgress || []) if (!tasks.has(t.id)) tasks.set(t.id, t);
  }
  return {
    items: list.length,
    adds,
    parts: [...parts.values()].sort((a, b) => b.items - a.items || String(a.name).localeCompare(String(b.name))),
    inProgress: [...tasks.values()],
  };
}

/** The merged reach as lines; `clashes` is how many items clash with a decision or rule. */
export function overallLines(merged, { clashes = 0 } = {}) {
  const { items, adds, parts, inProgress } = merged;
  const said = (rec, t) => [rec && plural(rec, 'record'), t && plural(t, 'task')].filter(Boolean).join(' and ');
  const added = said(adds.recordsAdded, adds.tasksAdded);
  const changed = said(adds.recordsChanged, adds.tasksChanged);
  const what = [added && `add ${added}`, changed && `change ${changed}`].filter(Boolean).join(' and ') || 'add nothing';
  const shown = parts.slice(0, SHOWN_PARTS).map(p => `${asQuotedData(p.name, 60)} (${p.items})`).join(', ');
  const restParts = parts.length - SHOWN_PARTS;
  return [
    `${plural(items, 'waiting item')} would ${what}.`,
    parts.length ? `They reach ${shown}${restParts > 0 ? ` and ${plural(restParts, 'other part')}` : ''}.` : 'They reach no part of the work.',
    clashes ? `${clashes} ${clashes === 1 ? 'clashes' : 'clash'} with a decision or rule.` : 'None clashes with a decision or rule.',
    inProgress.length ? `${plural(inProgress.length, 'task')} in progress would be flagged.` : 'No work in progress would be flagged.',
  ];
}
