import { descendantsOf } from './model.js';
import { asQuotedData } from './change-labels.js';

/**
 * What a change reaches, in brief (accepted-work spec, section 3).
 *
 * Pure and AI-free. The facts a manager needs before saying yes: what is added
 * and where, which parts inherit it, and which work in progress will be flagged
 * the next time somebody picks it up. Kept as data so many of these can be
 * merged later, and rendered to lines for the page and the assistant.
 */
const RECORD_OPS = new Set(['setGoal', 'addRecord', 'editRecord', 'setRecordStatus', 'addEvidence']);
const TASK_OPS = new Set(['addTask', 'editTask', 'removeTask']);
const SHOWN_TASKS = 3;

export function reachOf({ operations, treeId, config, tasks, hasWork, exclude = null }) {
  const ops = Array.isArray(operations) ? operations : [];
  const workstreams = config?.workstreams || [];
  const nameOf = (id) => workstreams.find(w => w.id === id)?.name || id;
  const below = treeId == null ? workstreams.map(w => w.id) : descendantsOf(config, treeId);
  const scope = new Set(treeId == null ? workstreams.map(w => w.id) : [treeId, ...below]);
  return {
    adds: {
      label: treeId == null ? (config?.project || 'the project') : nameOf(treeId),
      records: ops.filter(o => RECORD_OPS.has(o?.type)).length,
      tasks: ops.filter(o => TASK_OPS.has(o?.type)).length,
    },
    inheritedBy: below.map(id => ({ id, name: nameOf(id) })),
    inProgress: (tasks || [])
      .filter(t => t.status !== 'done' && t.id !== exclude && scope.has(t.workstream) && hasWork(t))
      .map(t => ({ id: t.id, key: t.key || null, title: t.title })),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function reachLines(reach) {
  const { adds, inheritedBy, inProgress } = reach;
  const parts = [adds.records && plural(adds.records, 'record'), adds.tasks && plural(adds.tasks, 'task change')].filter(Boolean);
  // Titles are contributor-written, so they are quoted as data.
  const shown = inProgress.slice(0, SHOWN_TASKS)
    .map(t => `${t.key ? `${t.key} ` : ''}${asQuotedData(t.title, 60)}`).join(', ');
  const rest = inProgress.length - SHOWN_TASKS;
  return [
    parts.length ? `Adds ${parts.join(' and ')} to ${adds.label}.` : `Adds nothing to ${adds.label}.`,
    inheritedBy.length ? `Inherited by ${inheritedBy.map(p => p.name).join(', ')}.` : 'No other part inherits from this.',
    inProgress.length
      ? `Work in progress that will be flagged: ${shown}${rest > 0 ? ` and ${rest} more` : ''}.`
      : 'No work in progress is affected.',
  ];
}
