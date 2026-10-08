import {
  readProject, readConfig, writeConfig, withCounters, readTree, writeTree, writeTreeMd, writeRoleFile,
  readQueueItem, deleteQueueItem, writeRejected, writeApproved, readContributions, listQueue,
} from '../../src/storage.js';
import { applyQueueItem, applyTaskSubmission, buildRejected, canApprove, isLegacyManagerRef } from '../../src/review.js';
import { isBrokenGate } from '../../src/manager-repair.js';
import { serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName } from '../../src/prefs.js';
import { sourceTrailer } from './contribute.core.js';
import { resolveTarget, isProjectLevel } from '../../src/project-level.js';
import { recompileInheritors, chainFor } from '../../src/recompile.js';
import { workstreamNumber, isTaskKey } from '../../src/numbering.js';
import { resolveContradictions, ContradictionResolutionError } from '../../src/contradictions.js';

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
export async function currentIdentity(config, teamctxDir, projectDir) {
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

/**
 * The queue id an item is known by, given either its id or its number.
 *
 * A waiting item has a number from the moment it is queued ("approve 1.6"), so a
 * manager can use what they read on the page. A number naming nothing is
 * returned untouched and fails the way an unknown id does.
 */
export function resolveQueueId(idOrNumber, teamctxDir) {
  if (!isTaskKey(idOrNumber)) return idOrNumber;
  const named = listQueue(teamctxDir).filter(q => q.number === idOrNumber);
  // Two items about the same task share that task's number. Picking one would
  // approve or reject something the manager did not mean to, so say which.
  if (named.length > 1) {
    throw new AmbiguousQueueNumberError(idOrNumber, named.map(q => q.id));
  }
  return named[0]?.id ?? idOrNumber;
}

export class AmbiguousQueueNumberError extends Error {
  constructor(number, ids) {
    super(`${number} names ${ids.length} waiting items (${ids.join(', ')}). Use the id of the one you mean.`);
    this.code = 'AMBIGUOUS_QUEUE_NUMBER';
  }
}

export async function listPendingReviews({ teamctxDir } = {}) {
  return listQueue(teamctxDir);
}

/**
 * Refuse the approval only when the resolution itself would not apply.
 *
 * Any dropped operation used to block it, which is too much: a queue item can
 * carry an unrelated `editRecord` on a record that was legitimately retired
 * while the item sat waiting, and that drops with "no record …". The conflict
 * may have been resolved perfectly, and the item could then never be approved,
 * only rejected — the manager's own answer thrown away because of something
 * else in the same contribution.
 *
 * So only the operations a conflict actually names are checked. Whatever else
 * went stale is dropped the way it always is, with the rest of the contribution
 * landing around it.
 */
function assertConflictApplied(item, dropped) {
  const conflicted = new Set((item.contradictions || []).map(c => c.operationIndex));
  const blocking = (dropped || []).filter(d => conflicted.has(d.index));
  if (blocking.length) {
    throw new ContradictionResolutionError(`The conflict resolution cannot be applied: ${blocking.map(d => d.reason).join('; ')}. The contribution remains queued.`);
  }
}

export async function approveReview({ id, replaces, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  // The gate reads the resolved identity, never the caller-supplied `actor`.
  // That argument is attribution only: it is a claim, not a credential.
  const { actor: caller, displayName } = await currentIdentity(config, teamctxDir, projectDir);
  assertManager(config, { actor: caller, displayName });
  const who = actor || displayName;

  let item;
  const queueId = resolveQueueId(id, teamctxDir);
  try { item = readQueueItem(queueId, teamctxDir); }
  catch { throw new QueueItemNotFoundError(id); }

  // `null` is the project itself. Defaulting to `main` here would have sent an
  // approved project-level contribution to a workstream that no longer exists.
  const targetId = resolveTarget(item.workstream);
  // Check before acquiring the key lock: an unresolved conflict must not even
  // backfill existing records, let alone apply or delete the queued proposal.
  const resolvedItem = resolveContradictions(item, { replaces, config, teamctxDir });
  if (item.contradictions?.length) {
    const preview = applyQueueItem(readTree(targetId, teamctxDir), resolvedItem, { nextKey: config.nextKey, workstreamNumber: workstreamNumber(config, targetId) });
    assertConflictApplied(resolvedItem, preview.dropped);
  }
  // Who approved a record travels with it, not only with the commit.
  const approvedBy = { key: caller?.key || null, name: who, at: new Date().toISOString() };
  const updated = withCounters(teamctxDir, current => {
    // Work sent back for a task completes the task and writes no record (#144).
    if (item.forTask) {
      const { tree } = applyTaskSubmission(readTree(targetId, teamctxDir), item, {
        by: { key: approvedBy.key, name: approvedBy.name }, at: approvedBy.at,
      });
      writeTree(targetId, tree, teamctxDir);
      return tree;
    }
    item = resolveContradictions(item, { replaces, config: current, teamctxDir });
    const { tree: applied, nextKey, dropped } = applyQueueItem(readTree(targetId, teamctxDir), item, { nextKey: current.nextKey, workstreamNumber: workstreamNumber(current, targetId) });
    assertConflictApplied(item, dropped);
    const tree = {
      ...applied,
      records: (applied.records || []).map(r => ((r.sourceContributionIds || []).includes(item.id) ? { ...r, approvedBy } : r)),
    };
    writeConfig({ ...current, nextKey }, teamctxDir);
    writeTree(targetId, tree, teamctxDir);
    return tree;
  });
  const contributions = readContributions(teamctxDir);

  // The inherited half, or nothing when the target *is* the project: rendering
  // the project above itself prints every node twice, under a heading that says
  // it came from somewhere else. Every sibling write path resolves it the same
  // way — see `contribute.core.js` and `reflect.core.js`.
  // A project-level write renders alone; a workstream renders under its chain.
  const project = isProjectLevel(targetId) ? null : readProject(teamctxDir);
  const chain = isProjectLevel(targetId) ? null
    : chainFor({ config, id: targetId, teamctxDir }).map(w => (w.id === targetId ? { ...updated, name: w.name, number: w.number } : w));

  writeTreeMd(
    targetId,
    serializeToMd(updated, workstreamDisplayName(targetId, updated, config), item.author, contributions, { project, chain }),
    teamctxDir,
  );
  // The parts below inherit whatever this changed.
  recompileInheritors({ project: project ?? updated, config, contributions, teamctxDir });

  const rolesOnTarget = (config.roles || []).filter(r => resolveTarget(r.workstream) === targetId);
  const rolesRegenerated = [];
  for (const role of rolesOnTarget) {
    const md = await generateRoleFile(updated, role, config.project, config, contributions, { project, chain });
    writeRoleFile(role.slug, md, teamctxDir);
    rolesRegenerated.push(role.slug);
  }

  // Who approved it, kept for the task history (#143): approving used to leave
  // nothing behind but the commit message.
  writeApproved({
    id: item.id, author: item.author || null, source: item.source || null, workstream: targetId,
    approvedBy: { key: approvedBy.key, name: approvedBy.name }, approvedAt: approvedBy.at,
  }, teamctxDir);
  deleteQueueItem(item.id, teamctxDir);

  const note = item.tagged === 'decision' ? ' [decision]' : '';
  const wsNote = isProjectLevel(targetId) ? '' : ` (${targetId})`;
  await commitContext(
    // This is the commit that actually changes shared context, so it is the one
    // someone reads when asking where a Why came from. The queue item carried
    // the source through review; without this it would be lost at the last step.
    `context: ${item.author} contribution (approved by ${approvedBy.name})${note}${wsNote}${sourceTrailer(item.source)}`,
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
    approvedBy: approvedBy.name,
    operations: item.operations || [],
    ...(item.contradictions?.length ? { contradictions: item.contradictions } : {}),
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
  const queueId = resolveQueueId(id, teamctxDir);
  try { item = readQueueItem(queueId, teamctxDir); }
  catch { throw new QueueItemNotFoundError(id); }

  writeRejected(buildRejected(item, rejectedBy, reason, caller?.key || null), teamctxDir);
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
