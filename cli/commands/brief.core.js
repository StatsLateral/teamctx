import {
  readConfig, readTreeMd, readRoleFile, listTasks, listWorkstreamIds,
} from '../../src/storage.js';
import { resolveTarget, isProjectLevel, targetLabel } from '../../src/project-level.js';
import { inScope } from '../../src/member-scope.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName } from '../../src/prefs.js';

/**
 * The one thing a member reads before they do anything.
 *
 * Somebody joins, asks their assistant what to do, and the best answer
 * available was a bare list of task titles — no sense of what the project is
 * for, no sense of which part of it they are on, nothing saying "read this
 * first". So the assistant starts working: contributing, marking things done,
 * proposing changes to a tree it has never read.
 *
 * This is the second of the two governance rules in the design spec, the pair
 * to the gate in src/context-gate.js. That one guarantees there is something to
 * read; this is the reading. Either alone is worth little — a context nobody
 * opens is the same as no context.
 *
 * It spends no AI call, and that is a property rather than an implementation
 * detail. A member's assistant is told to open this first, every time, so the
 * cheapest and most frequent call in the product must not be the expensive one.
 * Everything here was compiled when it was written.
 */

/** Their tasks, under the thing they belong to. */
function groupByTarget(tasks, config) {
  const groups = new Map();
  for (const task of tasks) {
    const id = resolveTarget(task.workstream);
    if (!groups.has(id)) {
      groups.set(id, {
        workstream: id,
        // Named the way a person would say it. Project-level tasks are a group
        // like any other rather than an unlabelled remainder.
        name: targetLabel(id, config.project),
        tasks: [],
      });
    }
    groups.get(id).tasks.push(task);
  }
  return [...groups.values()];
}

function compiled(target, teamctxDir) {
  try { return readTreeMd(target, teamctxDir) || ''; } catch { return ''; }
}

/**
 * Where this caller stands, which decides what they read.
 *
 * A scoped member reads their own workstreams; anybody else reads the project,
 * which is the base every workstream inherits anyway.
 */
function placesFor({ scope, activeWorkstream }) {
  if (scope && scope.length) return scope;
  return [resolveTarget(activeWorkstream)];
}

export async function buildBrief({
  scope = null, activeWorkstream = null, teamctxDir, projectDir, actor,
} = {}) {
  const config = readConfig(teamctxDir);
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  const me = await resolveDisplayName({ actor: resolved, config, teamctxDir });

  const places = placesFor({ scope, activeWorkstream });
  const known = new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds(teamctxDir)]);

  // Their own, by key first and by name second: the key covers a rename, the
  // name covers every task that existed before keys did.
  const mine = listTasks({}, teamctxDir)
    .filter(t => (resolved.key && t.ownerKey === resolved.key) || (me && t.owner === me))
    // `inScope`, not `scope.includes`: a task at project level resolves to
    // `null`, which is in no scope array and in everybody's scope. Testing the
    // array directly dropped a scoped member's own project-level tasks out of
    // the one view meant to tell them what they are doing.
    .filter(t => inScope(scope && scope.length ? scope : null, t.workstream));

  const open = mine.filter(t => t.status === 'open');
  const done = mine.filter(t => t.status !== 'open');

  // The compiled context for each place they stand. `readTreeMd` already holds
  // the project tree above the workstream's own, so this is the merged view
  // rather than two halves for a caller to staple together.
  const context = places
    .filter(id => isProjectLevel(id) || known.has(id))
    .map(id => ({
      workstream: id,
      name: targetLabel(id, config.project),
      markdown: compiled(id, teamctxDir),
    }));

  // A role they hold on one of those places, if any. #81 proposes membership
  // models but stores none, so the honest answer is the role that exists.
  const role = (config.roles || [])
    .find(r => places.some(id => resolveTarget(r.workstream) === id)) || null;
  let roleMarkdown = '';
  if (role) {
    try { roleMarkdown = readRoleFile(role.slug, teamctxDir); } catch { roleMarkdown = ''; }
  }

  const where = places.length === 1
    ? targetLabel(places[0], config.project)
    : places.map(id => targetLabel(id, config.project)).join(' and ');

  const frame = open.length
    ? `You are on ${where}. Read this, then pick up one of your ${open.length} open task${open.length === 1 ? '' : 's'}.`
    : `You are on ${where}. Read this first. You have no tasks assigned yet — ask whoever runs the project what to pick up.`;

  return {
    me,
    project: config.project,
    where: places,
    frame,
    role: role ? { slug: role.slug, name: role.name, markdown: roleMarkdown } : null,
    context,
    tasks: {
      open: groupByTarget(open, config),
      done: groupByTarget(done, config),
      openCount: open.length,
    },
  };
}
