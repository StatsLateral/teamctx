import { createHash } from 'crypto';
import {
  readConfig, listTasks, readTask, writeTask, deleteTask,
  readWorkstream, readContributions,
  writeTaskFile, readTaskFile, taskFilePath, taskFileExists,
} from '../../src/storage.js';
import { compileTaskPrompt } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName, resolveActiveWorkstream } from '../../src/prefs.js';

/**
 * Task operations, with no terminal in them.
 *
 * Split out of cli/commands/task.js so the MCP server can call the same code
 * the CLI does. Everything below returns a plain object and throws a typed
 * error; printing, table formatting and `process.exit` stay in the command
 * layer.
 *
 * The split matters most for `compileTask`. The CLI can end by printing a file
 * path and telling the user to open it. An MCP caller frequently cannot — it is
 * often not on the same machine, and the hosted server has no working copy at
 * all — so the compiled markdown itself is part of the return value.
 */

export class TaskNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.code = 'TASK_NOT_FOUND';
  }
}

export class UnknownTaskWorkstreamError extends Error {
  constructor(id, known) {
    super(`no workstream "${id}"${known.length ? `. Known: ${known.join(', ')}.` : '.'}`);
    this.code = 'UNKNOWN_WORKSTREAM';
    this.workstream = id;
  }
}

export class UnknownRoleError extends Error {
  constructor(slug, known) {
    super(`no role "${slug}"${known.length ? `. Known: ${known.join(', ')}.` : '.'}`);
    this.code = 'UNKNOWN_ROLE';
    this.role = slug;
  }
}

/**
 * Fingerprints the Why tree a prompt was compiled from.
 *
 * `compileTask` skips the AI call when this is unchanged, which is what makes
 * re-running it cheap. Only the name and the whys go in: a task's own fields
 * change constantly and have no bearing on whether the prompt is stale.
 */
function whysHash(workstream) {
  const material = JSON.stringify({
    name: workstream?.name || '',
    whys: workstream?.whys || [],
  });
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

export function slugify(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) throw new Error('title must contain at least one alphanumeric character');
  return `t-${base}`.slice(0, 60);
}

export function uniqueTaskId(base, dir) {
  const existing = new Set(listTasks({}, dir).map(t => t.id));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('could not generate a unique task id');
}

const todayIso = () => new Date().toISOString().slice(0, 10);

async function whoAmI({ config, teamctxDir, projectDir, actor }) {
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  return resolveDisplayName({ actor: resolved, config, teamctxDir });
}

/** Commit, and push if the project is configured to. Never throws on a failed
 *  push — a task recorded locally is not lost, and the caller is told. */
async function commitAndPush(config, message, projectDir) {
  await commitContext(message, projectDir ? { cwd: projectDir } : undefined);
  if (!config.autoPush) return { committed: true, pushed: false };
  try {
    await pushContext(projectDir ? { cwd: projectDir } : undefined);
    return { committed: true, pushed: true };
  } catch (err) {
    return {
      committed: true,
      pushed: false,
      pushError: err.message?.split('\n')[0] || 'push failed',
    };
  }
}

function findTask(idOrPrefix, teamctxDir) {
  try {
    return readTask(idOrPrefix, teamctxDir);
  } catch (err) {
    throw new TaskNotFoundError(err.message);
  }
}

async function resolveTargetWorkstream(config, requested, { teamctxDir, projectDir, actor }) {
  if (requested) {
    const known = (config.workstreams || []).map(w => w.id);
    if (known.length > 0 && !known.includes(requested)) {
      throw new UnknownTaskWorkstreamError(requested, known);
    }
    return requested;
  }
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  return resolveActiveWorkstream({ actor: resolved, config, teamctxDir });
}

// ---- reads --------------------------------------------------------------

export class MineAndOwnerError extends Error {
  constructor() {
    // Two ways of asking the same question. Ranking one over the other silently
    // is how a caller ends up trusting an empty list.
    super('pass either mine or owner, not both — they are two ways to ask the same question');
    this.code = 'MINE_AND_OWNER';
  }
}

export function listTasksFiltered({
  status, owner, workstream, all = false, activeWorkstream = 'main', teamctxDir,
  mine = false, me = null, myKey = null,
} = {}) {
  if (mine && owner) throw new MineAndOwnerError();
  const scope = all ? {} : { workstream: workstream || activeWorkstream };
  let tasks = listTasks(scope, teamctxDir);
  if (status) tasks = tasks.filter(t => t.status === status);
  if (owner) tasks = tasks.filter(t => t.owner === owner);
  // The key covers a rename and a second surface; the name covers every task
  // that already exists, none of which carries a key.
  if (mine) {
    tasks = tasks.filter(t => (myKey && t.ownerKey === myKey) || (me && t.owner === me));
  }
  if (workstream) tasks = tasks.filter(t => t.workstream === workstream);
  // Matching the CLI: with no explicit status and no --all, open tasks are what
  // "my tasks" means. `all` is how a caller asks for the finished ones too.
  if (!status && !all) tasks = tasks.filter(t => t.status === 'open');
  tasks.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return { tasks, scope: all ? 'all workstreams' : `workstream ${scope.workstream}` };
}

export function getTask({ id, teamctxDir } = {}) {
  const { task, workstream } = findTask(id, teamctxDir);
  return {
    ...task,
    workstream,
    promptPath: taskFileExists(task.id, teamctxDir) ? taskFilePath(task.id, teamctxDir) : null,
  };
}

// ---- writes -------------------------------------------------------------

export async function addTask({
  title, owner, workstream, teamctxDir, projectDir, actor,
} = {}) {
  const config = readConfig(teamctxDir);
  const targetWorkstream = await resolveTargetWorkstream(config, workstream, { teamctxDir, projectDir, actor });
  const me = await whoAmI({ config, teamctxDir, projectDir, actor });

  const resolvedActor = actor || await resolveActor({ config, cwd: projectDir });
  const id = uniqueTaskId(slugify(title), teamctxDir);
  const task = {
    id,
    title: String(title),
    owner: owner || me,
    // Only when the task is the caller's own. A name does not identify a
    // person, so assigning to one records no key rather than a guessed one.
    ...(owner ? {} : { ownerKey: resolvedActor.key }),
    status: 'open',
    workstream: targetWorkstream,
    createdAt: todayIso(),
    doneAt: null,
    compiledAt: null,
  };
  writeTask(task, teamctxDir);

  const wsLabel = targetWorkstream === 'main' ? '' : ` [workstream: ${targetWorkstream}]`;
  const git = await commitAndPush(config, `task: add ${id} by ${me}${wsLabel}`, projectDir);
  return { task, ...git };
}

export async function setTaskStatus({
  id, status, teamctxDir, projectDir, actor,
} = {}) {
  const config = readConfig(teamctxDir);
  const { task } = findTask(id, teamctxDir);
  if (task.status === status) return { task, unchanged: true, committed: false, pushed: false };

  const updated = status === 'done'
    ? { ...task, status: 'done', doneAt: todayIso() }
    : { ...task, status: 'open', doneAt: null };
  writeTask(updated, teamctxDir);

  const me = await whoAmI({ config, teamctxDir, projectDir, actor });
  const verb = status === 'done' ? 'done' : 'reopen';
  const git = await commitAndPush(config, `task: ${verb} ${task.id} by ${me}`, projectDir);
  return { task: updated, unchanged: false, ...git };
}

export async function assignTask({ id, owner, teamctxDir, projectDir } = {}) {
  if (!owner) throw new Error('an owner is required');
  const config = readConfig(teamctxDir);
  const { task } = findTask(id, teamctxDir);
  const updated = { ...task, owner };
  writeTask(updated, teamctxDir);
  const git = await commitAndPush(config, `task: assign ${task.id} to ${owner}`, projectDir);
  return { task: updated, ...git };
}

export async function removeTask({ id, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  // Resolve first so a bad id fails before anything is deleted.
  const { task } = findTask(id, teamctxDir);
  const { id: removedId, workstream } = deleteTask(id, teamctxDir);
  const me = await whoAmI({ config, teamctxDir, projectDir, actor });
  const git = await commitAndPush(config, `task: rm ${removedId} by ${me}`, projectDir);
  return { id: removedId, title: task.title, workstream, ...git };
}

/**
 * Build the prompt for one task.
 *
 * The only task operation that spends an AI call, and the only one that can be
 * skipped: if the workstream's Whys have not moved since the last compile, the
 * existing prompt is still correct and is returned as-is. `force` overrides
 * that, which is what a caller wants after editing a role.
 *
 * `markdown` is always returned, compiled or cached, because an MCP caller
 * cannot open `promptPath`.
 */
export async function compileTask({
  id, role: roleSlug, force = false, teamctxDir, projectDir, actor,
} = {}) {
  const config = readConfig(teamctxDir);
  const { task } = findTask(id, teamctxDir);
  const wsId = task.workstream || 'main';
  const workstream = readWorkstream(wsId, teamctxDir);
  const currentHash = whysHash(workstream);

  if (!force && taskFileExists(task.id, teamctxDir) && task.compiledFromHash === currentHash) {
    return {
      task,
      role: roleSlug || null,
      markdown: readTaskFile(task.id, teamctxDir),
      promptPath: taskFilePath(task.id, teamctxDir),
      alreadyCompiled: true,
      committed: false,
      pushed: false,
    };
  }

  let role = null;
  if (roleSlug) {
    role = (config.roles || []).find(r => r.slug === roleSlug);
    if (!role) throw new UnknownRoleError(roleSlug, (config.roles || []).map(r => r.slug));
  }

  const contributions = readContributions(teamctxDir);
  const markdown = await compileTaskPrompt({ task, workstream, role, contributions, config });
  writeTaskFile(task.id, markdown, teamctxDir);

  const updated = { ...task, compiledAt: new Date().toISOString(), compiledFromHash: currentHash };
  writeTask(updated, teamctxDir);

  const me = await whoAmI({ config, teamctxDir, projectDir, actor });
  const roleTag = roleSlug ? ` (role: ${roleSlug})` : '';
  const git = await commitAndPush(config, `task: compile ${task.id} by ${me}${roleTag}`, projectDir);

  return {
    task: updated,
    role: roleSlug || null,
    markdown,
    promptPath: taskFilePath(task.id, teamctxDir),
    alreadyCompiled: false,
    ...git,
  };
}
