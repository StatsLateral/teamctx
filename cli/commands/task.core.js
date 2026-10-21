import { chainFor } from '../../src/recompile.js';
import { flaggedInProject } from '../../src/project-records.js';
import { isActive, ancestorsOf } from '../../src/model.js';
import { changesReaching, lastActivity, changedSummary, labelFor } from '../../src/changes.js';
import { createHash } from 'crypto';
import {
  readProject, readConfig, readTree, listTasks, readTask, writeTask, deleteTask,
  readWorkstream, readContributions,
  writeTaskFile, readTaskFile, taskFilePath, taskFileExists,
  writeOutput, listOutputs, listChanges, appendContribution, writeQueueItem, readApprovals, listQueue, listRejected,
} from '../../src/storage.js';
import { compileTaskPrompt } from '../../src/context.js';
import { outputStates, latestRejection } from '../../src/outputs.js';
import { commitContext, pushContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName, resolveActiveWorkstream } from '../../src/prefs.js';
import { resolveTarget, isProjectLevel } from '../../src/project-level.js';
import { announceQueued } from '../../src/slack-notify.js';
import { TaskWithoutWorkstreamError } from '../../src/numbering.js';

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

export { TaskWithoutWorkstreamError };

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
 * Fingerprints the context a prompt was compiled from.
 *
 * `compileTask` skips the AI call when this is unchanged, which is what makes
 * re-running it cheap. The name, goal and records go in, and the other tasks'
 * titles: a task's own status changes constantly and has no bearing on whether
 * the prompt is stale.
 */
function contextHash(tree) {
  const material = JSON.stringify({
    name: tree?.name || '',
    goal: tree?.goal?.text || null,
    records: tree?.records || [],
    tasks: (tree?.tasks || []).map(t => [t.key || null, t.title]),
    // Which records hold today: an exception that has since expired makes the
    // prompt stale even though no file changed.
    active: (tree?.records || []).filter(r => isActive(r)).map(r => r.id),
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
  // Every task lives in a workstream: the project's own work is a workstream
  // too, so a project that has not split anything out yet adds one first.
  // `undefined` is "nobody said", which means wherever the caller is working; if
  // that is the project, and there is only one part of the work, it is that part.
  // `null` is somebody saying "the project", which is not a place for a task.
  const known = (config.workstreams || []).map(w => w.id);
  let target = requested;
  if (requested === undefined) {
    const resolved = actor || await resolveActor({ config, cwd: projectDir });
    target = await resolveActiveWorkstream({ actor: resolved, config, teamctxDir });
    if (isProjectLevel(target) && known.length === 1) target = known[0];
  }
  if (isProjectLevel(target)) throw new TaskWithoutWorkstreamError(known);
  if (!known.includes(target)) throw new UnknownTaskWorkstreamError(target, known);
  return target;
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
  status, owner, workstream, all = false, activeWorkstream = null, teamctxDir,
  mine = false, me = null, myKey = null,
} = {}) {
  if (mine && owner) throw new MineAndOwnerError();
  const target = resolveTarget(workstream ?? activeWorkstream);
  // Tasks live in workstreams, never on the project, so "at the project" means
  // every workstream the caller can reach, not an empty list.
  const everywhere = all || isProjectLevel(target);
  const scope = everywhere ? {} : { workstream: target };
  let tasks = listTasks(scope, teamctxDir);
  if (status) tasks = tasks.filter(t => t.status === status);
  if (owner) tasks = tasks.filter(t => t.owner === owner);
  // The key covers a rename and a second surface; the name covers every task
  // that already exists, none of which carries a key.
  if (mine) {
    tasks = tasks.filter(t => (myKey && t.ownerKey === myKey) || (me && t.owner === me));
  }
  if (workstream) tasks = tasks.filter(t => resolveTarget(t.workstream) === resolveTarget(workstream));
  // Matching the CLI: with no explicit status and no --all, open tasks are what
  // "my tasks" means. `all` is how a caller asks for the finished ones too.
  if (!status && !all) tasks = tasks.filter(t => t.status === 'open');
  tasks.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return {
    tasks,
    scope: everywhere ? 'all workstreams' : `workstream ${target}`,
  };
}

/**
 * A task whose submitted work a manager accepted is closed for good in this
 * version: nobody works on it any more, the manager included. Anything further
 * is a follow-on task. (Letting a manager remove an accepted task from the
 * context is for a later version.)
 *
 * Read off the approvals, not stored on the task, so a task somebody merely
 * marked done by hand is not locked and can still be reopened.
 */
function assertNotAccepted(task, teamctxDir) {
  const accepted = Object.values(readApprovals(teamctxDir) || {}).find(a => a?.forTask === task.id);
  if (!accepted) return;
  const by = accepted.approvedBy?.name ? ` by ${accepted.approvedBy.name}` : '';
  throw new Error(`Task ${task.key || task.id} was accepted${by} and is closed. Add a follow-on task for anything further.`);
}

/**
 * The most that one output may hold. Refused above it, never cut short: a
 * silently shortened draft is worse than one that was not saved.
 */
export const MAX_OUTPUT_CHARS = 50_000;

/**
 * What changed in the context since somebody last worked on this task (or
 * `null`). A task nobody has touched has nothing to go stale. The trees that
 * count are the project, every ancestor and the task's own part.
 */
function changedSinceFor(task, saved, teamctxDir, read = {}) {
  // In progress means not done; a closed task's accepted work is not news.
  if (task.status === 'done') return null;
  const since = lastActivity({ outputs: saved, task });
  if (!since) return null;
  // A caller asking twice (compile does) passes `read` so config and the log are
  // read once; changesReaching applies `since` itself.
  const config = (read.config ??= readConfig(teamctxDir) || {});
  const ws = resolveTarget(task.workstream);
  const trees = [null, ...(ws ? [...ancestorsOf(config, ws), ws] : [])];
  const entries = read.entries ?? (read.entries = listChanges({}, teamctxDir));
  const found = changesReaching({ entries, trees, since });
  if (!found.changes.length) return null;
  return changedSummary(found, labelFor(config));
}

/**
 * One task, with what has been produced on it (#197).
 *
 * `outputs` is the latest in full and the earlier ones as a list without their
 * text, so a long history does not grow what an assistant is handed; ask for
 * one by id with `output` to open it. `null` when nothing was saved.
 */
export function getTask({ id, output, teamctxDir, reader } = {}) {
  const { task, workstream } = findTask(id, teamctxDir);
  const saved = withFeedback(withStates(listOutputs(task.id, teamctxDir), teamctxDir), task, reader, teamctxDir);
  const base = {
    ...task,
    workstream,
    promptPath: taskFileExists(task.id, teamctxDir) ? taskFilePath(task.id, teamctxDir) : null,
    changedSince: changedSinceFor(task, saved, teamctxDir),
  };
  if (output) {
    const found = saved.find(o => o.id === output);
    if (!found) throw new Error(`no output "${output}" on task ${task.key || task.id}`);
    return { ...base, outputs: summarise(saved), output: found };
  }
  return { ...base, outputs: summarise(saved) };
}

/**
 * Put the manager's feedback on an output that was sent back, for the people it
 * is for: a manager, whoever wrote the output, and whoever the task is assigned
 * to, whatever the source of the work. `reader` is who is asking ({ keys,
 * isManager }); without one nothing is added, so a caller that cannot say who it
 * is never gets somebody's feedback. An assistant carrying on from an output
 * that was sent back has to see why, or it works from the draft that was turned
 * down.
 */
export function withFeedback(saved, task, reader, teamctxDir) {
  if (!reader || !saved.some(o => o.state === 'working')) return saved;
  const keys = new Set((reader.keys || []).filter(Boolean));
  // By key, or by the roster entry the task's owner name belongs to: a name the
  // caller chose for themselves proves nothing, the roster's keys do.
  const members = (readConfig(teamctxDir)?.members || []);
  const assigned = (!!task.ownerKey && keys.has(task.ownerKey))
    || members.some(m => m?.key && keys.has(m.key) && !!task.owner && m.name === task.owner);
  let rejected = [];
  try { rejected = listRejected(teamctxDir).filter(r => r?.forTask === task.id); } catch { rejected = []; }
  return saved.map(o => {
    if (o.state !== 'working') return o;
    if (!(reader.isManager || assigned || (o.author?.key && keys.has(o.author.key)))) return o;
    const r = latestRejection(rejected, o.id);
    return r ? { ...o, feedback: { reason: r.reason || null, at: r.rejectedAt || null } } : o;
  });
}

function withStates(saved, teamctxDir) {
  if (!saved.length) return saved;
  return outputStates(saved, {
    approvals: readApprovals(teamctxDir),
    waiting: new Set(listQueue(teamctxDir).flatMap(q => (Array.isArray(q.outputs) ? q.outputs : []))),
  });
}

function summarise(saved) {
  if (!saved.length) return null;
  const latest = saved[saved.length - 1];
  return {
    latest,
    earlier: saved.slice(0, -1).map(o => ({ id: o.id, title: o.title, author: o.author, at: o.at, state: o.state })),
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
    // Who put it on the plan, for its history (#143): a task added directly has
    // no contribution behind it to say so.
    addedBy: { key: resolvedActor.key || null, name: me },
    addedAt: new Date().toISOString(),
    doneAt: null,
    compiledAt: null,
  };
  writeTask(task, teamctxDir);

  const wsLabel = ` [workstream: ${targetWorkstream}]`;
  const git = await commitAndPush(config, `task: add ${id} by ${me}${wsLabel}`, projectDir);
  return { task, ...git };
}

// Outputs are ordered by when they were saved, so two saved in the same
// millisecond must not tie: the later one would be "latest" only by luck.
let lastStamp = 0;
function nextStamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/**
 * Save something somebody produced on a task, word for word.
 *
 * Not a change to the project: nothing here is queued or needs approving, the
 * task is not touched, and no one is asked a question. Submitting the work for
 * approval is a separate step. An output is never edited; working on one
 * further saves a new output with `basedOn` pointing back at it.
 */
export async function saveOutput({
  id, body, title, prompt, notes, basedOn, source, teamctxDir, projectDir, actor,
} = {}) {
  const config = readConfig(teamctxDir);
  const { task } = findTask(id, teamctxDir);
  assertNotAccepted(task, teamctxDir);
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) throw new Error('the output is empty: there is nothing to save');
  if (text.length > MAX_OUTPUT_CHARS) {
    throw new Error(`the output is too long to save (${text.length} characters; the most is ${MAX_OUTPUT_CHARS}). Save it in parts.`);
  }
  const saved = listOutputs(task.id, teamctxDir);
  if (basedOn && !saved.some(o => o.id === basedOn)) {
    throw new Error(`no output "${basedOn}" on task ${task.key || task.id} to build on`);
  }
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  const me = await resolveDisplayName({ actor: resolved, config, teamctxDir });
  const firstLine = text.trim().split('\n')[0].trim();
  const stamp = nextStamp();
  const output = {
    id: `o-${stamp.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    task: task.id,
    title: (typeof title === 'string' && title.trim() ? title.trim() : firstLine).slice(0, 120),
    body: text,
    author: { key: resolved?.key || null, name: me },
    source: source || null,
    at: new Date(stamp).toISOString(),
    prompt: typeof prompt === 'string' && prompt.trim() ? prompt : null,
    notes: typeof notes === 'string' && notes.trim() ? notes : null,
    basedOn: basedOn || null,
    state: 'working',
  };
  writeOutput(output, teamctxDir);
  const git = await commitAndPush(config, `output: ${me} saved ${output.id} on ${task.id}`, projectDir);
  return { output, task, ...git };
}

/**
 * Put outputs in front of the manager for approval.
 *
 * Deliberately not `contribute`: nothing here is read by an AI and turned into
 * records. What the manager is asked about is the outputs themselves, and what
 * the line on the queue says is built from their titles, so it cannot claim
 * anything the person did not. The item is for the task, so it waits under the
 * task's own number. Approving it is a separate act (`approveReview`).
 *
 * `outputs` is a list of output ids, `'all'`, or absent for the latest.
 */
export async function submitTask({
  id, outputs, message, source, teamctxDir, projectDir, actor, baseUrl = null,
} = {}) {
  const config = readConfig(teamctxDir);
  const { task } = findTask(id, teamctxDir);
  assertNotAccepted(task, teamctxDir);
  const saved = listOutputs(task.id, teamctxDir);
  if (!saved.length) throw new Error(`nothing saved on task ${task.key || task.id} to submit: save the work as an output first`);
  let chosen;
  if (outputs === 'all') chosen = saved;
  else if (Array.isArray(outputs) && outputs.length) {
    chosen = outputs.map(oid => {
      const found = saved.find(o => o.id === oid);
      if (!found) throw new Error(`no output "${oid}" on task ${task.key || task.id}`);
      return found;
    });
  } else chosen = [saved[saved.length - 1]];

  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  const me = await resolveDisplayName({ actor: resolved, config, teamctxDir });
  const summary = `Submitted: ${chosen.map(o => o.title).join('; ')}`;
  const said = typeof message === 'string' && message.trim() ? message.trim() : null;
  const src = source || 'cli';
  const contribution = {
    id: `${src === 'mcp' ? 'mcp' : 'c'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    author: me,
    ...(resolved?.key ? { authorKey: resolved.key } : {}),
    text: said || summary,
    tagged: null,
    source: src,
    workstream: task.workstream,
    status: 'logged',
    forTask: task.id,
  };
  appendContribution(contribution, teamctxDir);
  writeQueueItem({
    id: contribution.id, status: 'pending', createdAt: contribution.ts,
    ...(task.key ? { number: task.key } : {}),
    author: me, source: src, workstream: task.workstream,
    text: contribution.text, tagged: null, summary, operations: [],
    forTask: task.id, outputs: chosen.map(o => o.id),
  }, teamctxDir);
  const trailer = src === 'cli' ? '' : `\n\nSource: ${src}`;
  const git = await commitAndPush(config, `queue: ${me} submission for ${task.id} pending approval (${contribution.id})${trailer}`, projectDir);
  // After the commit, like a queued contribution (#182).
  await announceQueued({ id: contribution.id, number: task.key || null, author: me, summary }, { baseUrl, config, projectDir, pushed: git.pushed });
  return { id: contribution.id, mode: 'queued', number: task.key || null, outputs: chosen.map(o => o.id), summary, task, ...git };
}

/**
 * The task as it is once marked done or reopened. Pure, and shared with
 * accepting a submission, which closes the task in the same write as the
 * context change so a failure part-way cannot leave one without the other.
 */
export function withStatus(task, status, by, at = new Date().toISOString()) {
  const entry = { did: status === 'done' ? 'completed' : 'reopened', by, at };
  const statusLog = [...(Array.isArray(task.statusLog) ? task.statusLog : []), entry];
  return status === 'done'
    ? { ...task, status: 'done', doneAt: todayIso(), doneBy: by, statusLog }
    : { ...task, status: 'open', doneAt: null, doneBy: null, statusLog };
}

export async function setTaskStatus({
  id, status, teamctxDir, projectDir, actor,
} = {}) {
  const config = readConfig(teamctxDir);
  const { task } = findTask(id, teamctxDir);
  if (task.status === status) return { task, unchanged: true, committed: false, pushed: false };
  if (status === 'open') assertNotAccepted(task, teamctxDir);

  // Who did it and when, appended, so a task completed, reopened and completed
  // again keeps all three for its history (#143). `doneAt` stays a date for
  // everything that already reads it.
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  const me = await resolveDisplayName({ actor: resolved, config, teamctxDir });
  const by = { key: resolved?.key || null, name: me };
  const updated = withStatus(task, status, by);
  writeTask(updated, teamctxDir);

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
  assertNotAccepted(task, teamctxDir);
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
  id, role: roleSlug, force = false, teamctxDir, projectDir, actor, reader,
} = {}) {
  const config = readConfig(teamctxDir);
  const { task } = findTask(id, teamctxDir);
  // A task is always in a workstream, so the project is always the half above it.
  const wsId = task.workstream;
  const workstream = readTree(wsId, teamctxDir);
  const currentHash = contextHash(workstream);
  // The fingerprint covers only the task's own part, so a change in the project
  // or an ancestor would leave a stale prompt looking current. Staleness is
  // judged from the compile time alone: saving an output afterwards must not
  // hide that the prompt predates a change.
  const read = {};
  const staleFlag = changedSinceFor(task, [], teamctxDir, read);
  // An odd task id must not stop a compile, hence the guard on this read only.
  let saved = [];
  try { saved = listOutputs(task.id, teamctxDir); } catch { saved = []; }
  const flag = changedSinceFor(task, saved, teamctxDir, read) || staleFlag;

  // What people have already produced on this task, so whoever carries on starts
  // from it and not from the bare title.
  const outputs = summarise(withFeedback(withStates(saved, teamctxDir), task, reader, teamctxDir));

  if (!force && !staleFlag && taskFileExists(task.id, teamctxDir) && task.compiledFromHash === currentHash) {
    return {
      task,
      outputs,
      role: roleSlug || null,
      markdown: readTaskFile(task.id, teamctxDir),
      promptPath: taskFilePath(task.id, teamctxDir),
      alreadyCompiled: true,
      changedSince: null,
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
  // Every part above the task's own, so its prompt carries their rules too.
  const markdown = await compileTaskPrompt({
    task, workstream, role, contributions, config,
    project: readProject(teamctxDir),
    chain: chainFor({ config, id: wsId, teamctxDir }),
    flagged: flaggedInProject(teamctxDir),
  });
  writeTaskFile(task.id, markdown, teamctxDir);

  const updated = { ...task, compiledAt: new Date().toISOString(), compiledFromHash: currentHash };
  writeTask(updated, teamctxDir);

  const me = await whoAmI({ config, teamctxDir, projectDir, actor });
  const roleTag = roleSlug ? ` (role: ${roleSlug})` : '';
  const git = await commitAndPush(config, `task: compile ${task.id} by ${me}${roleTag}`, projectDir);

  return {
    task: updated,
    outputs,
    role: roleSlug || null,
    markdown,
    promptPath: taskFilePath(task.id, teamctxDir),
    alreadyCompiled: false,
    changedSince: flag,
    ...git,
  };
}
