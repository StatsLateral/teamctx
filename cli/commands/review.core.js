import {
  readProject, readConfig, readTree, writeTree, writeTreeMd, writeRoleFile,
  readQueueItem, deleteQueueItem, writeRejected, readContributions, listQueue,
} from '../../src/storage.js';
import { applyQueueItem, buildRejected, canApprove, isLegacyManagerRef } from '../../src/review.js';
import { isBrokenGate } from '../../src/manager-repair.js';
import { serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName } from '../../src/prefs.js';
import { sourceTrailer } from './contribute.core.js';
import { resolveTarget, isProjectLevel } from '../../src/project-level.js';
import { recompileInheritors } from '../../src/recompile.js';

function workstreamDisplayName(id, workstream, config) {
  if (isProjectLevel(id)) return config.project || workstream.name || 'project';
  return config.workstreams?.find(w => w.id === id)?.name || workstream.name || config.project;
}

/**
 * Who is really calling, and what they are called.
 *
 * The gate uses `actor` — a stable identity that the caller cannot choose. The
 * display name is only for messages and for the deprecated name-matching path.
 */
async function currentIdentity(config, teamctxDir, projectDir) {
  const actor = await resolveActor({ config, cwd: projectDir });
  const displayName = await resolveDisplayName({ actor, config, teamctxDir });
  return { actor, displayName };
}

export class ManagerGateError extends Error {
  constructor(config, { actor, displayName } = {}) {
    const manager = config.managerKey || config.manager;
    const you = displayName || actor?.name || 'unidentified';
    const key = actor?.key ? ` (${actor.key})` : '';
    // A display-name gate names the caller and refuses them in the same
    // sentence, which reads as a contradiction rather than a problem. Projects
    // created on the web before #71 all carry one, and nobody can match it.
    super(isBrokenGate(config)
      ? `this project's manager gate is "${manager}", a display name rather than an identity — `
        + 'nobody can match one, including you. Projects created on the web before this was fixed '
        // Not "from a clone": repair is reachable from a chat client too, and
        // a chat client is where somebody most often meets this — a project
        // broken by the web flow is one its manager may never have cloned.
        + 'all carry one. If you set this project up, repair it: ask your assistant to repair the '
        + 'manager gate, or run `teamctx config manager --repair` in a clone. Either re-pins it to '
        + `your own identity${actor?.key ? ` (${actor.key})` : ''}.`
      : `only the configured manager (${manager}) may approve or reject. You are ${you}${key}.`);
    this.code = 'MANAGER_GATE';
    this.manager = manager;
    this.actor = you;
    this.brokenGate = isBrokenGate(config);
  }
}

export class QueueItemNotFoundError extends Error {
  constructor(id) {
    super(`no pending contribution with id "${id}". Run \`teamctx review list\` to see the queue.`);
    this.code = 'QUEUE_ITEM_NOT_FOUND';
    this.id = id;
  }
}

export function assertManager(config, { actor, displayName } = {}) {
  if (!canApprove(config, { actor, displayName })) {
    throw new ManagerGateError(config, { actor, displayName });
  }
  if (isLegacyManagerRef(config)) {
    // Names are settable by their owner, so a name-based gate is advisory only.
    console.warn(`Warning: config.manager is a display name ("${config.manager}"), which anyone can set as their own. Run \`teamctx config manager --repair\` as the manager to pin it to an identity.`);
  }
}

export async function listPendingReviews({ teamctxDir } = {}) {
  return listQueue(teamctxDir);
}

export async function approveReview({ id, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  // The gate reads the resolved identity, never the caller-supplied `actor`.
  // That argument is attribution only: it is a claim, not a credential.
  const { actor: caller, displayName } = await currentIdentity(config, teamctxDir, projectDir);
  assertManager(config, { actor: caller, displayName });
  const who = actor || displayName;

  let item;
  try { item = readQueueItem(id, teamctxDir); }
  catch { throw new QueueItemNotFoundError(id); }

  // `null` is the project itself. Defaulting to `main` here would have sent an
  // approved project-level contribution to a workstream that no longer exists.
  const targetId = resolveTarget(item.workstream);
  const workstream = readTree(targetId, teamctxDir);
  const updated = applyQueueItem(workstream, item);
  const contributions = readContributions(teamctxDir);

  // The inherited half, or nothing when the target *is* the project: rendering
  // the project above itself prints every node twice, under a heading that says
  // it came from somewhere else. Every sibling write path resolves it the same
  // way — see `contribute.core.js` and `reflect.core.js`.
  const project = isProjectLevel(targetId) ? null : readProject(teamctxDir);

  writeTree(targetId, updated, teamctxDir);
  writeTreeMd(
    targetId,
    serializeToMd(updated, workstreamDisplayName(targetId, updated, config), item.author, contributions, { project }),
    teamctxDir,
  );

  // A change to the project changes what every workstream inherits, and a
  // compiled page does not re-read the project on its own.
  if (isProjectLevel(targetId)) {
    recompileInheritors({ project: updated, config, contributions, teamctxDir });
  }

  const rolesOnTarget = (config.roles || []).filter(r => resolveTarget(r.workstream) === targetId);
  const rolesRegenerated = [];
  for (const role of rolesOnTarget) {
    const md = await generateRoleFile(updated, role, config.project, config, contributions, { project });
    writeRoleFile(role.slug, md, teamctxDir);
    rolesRegenerated.push(role.slug);
  }

  deleteQueueItem(item.id, teamctxDir);

  const note = item.tagged === 'decision' ? ' [decision]' : '';
  const wsNote = isProjectLevel(targetId) ? '' : ` (${targetId})`;
  const approvedBy = who;
  await commitContext(
    // This is the commit that actually changes shared context, so it is the one
    // someone reads when asking where a Why came from. The queue item carried
    // the source through review; without this it would be lost at the last step.
    `context: ${item.author} contribution (approved by ${approvedBy})${note}${wsNote}${sourceTrailer(item.source)}`,
    projectDir ? { cwd: projectDir } : undefined,
  );

  let pushed = false, pushError = null;
  if (config.autoPush) {
    try { await pushContext(projectDir ? { cwd: projectDir } : undefined); pushed = true; }
    catch (err) { pushError = err.message?.split('\n')[0] || 'no remote?'; }
  }

  return {
    id: item.id,
    workstream: targetId,
    author: item.author,
    approvedBy,
    operations: item.operations || [],
    rolesRegenerated,
    pushed,
    pushError,
  };
}

export async function rejectReview({ id, reason, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  const { actor: caller, displayName } = await currentIdentity(config, teamctxDir, projectDir);
  assertManager(config, { actor: caller, displayName });
  const rejectedBy = actor || displayName;

  let item;
  try { item = readQueueItem(id, teamctxDir); }
  catch { throw new QueueItemNotFoundError(id); }

  writeRejected(buildRejected(item, rejectedBy, reason), teamctxDir);
  deleteQueueItem(item.id, teamctxDir);

  await commitContext(
    `review: rejected ${item.id} by ${rejectedBy}${reason ? ` (${reason})` : ''}`,
    projectDir ? { cwd: projectDir } : undefined,
  );

  let pushed = false, pushError = null;
  if (config.autoPush) {
    try { await pushContext(projectDir ? { cwd: projectDir } : undefined); pushed = true; }
    catch (err) { pushError = err.message?.split('\n')[0] || 'no remote?'; }
  }

  return { id: item.id, rejectedBy, reason: reason || null, pushed, pushError };
}
