import { readProject, readConfig, writeConfig, withCounters, readTree, writeTree, writeTreeMd, appendContribution, writeRoleFile, writeQueueItem, writeApproved, readContributions, listWorkstreamIds } from '../../src/storage.js';
import { resolveTarget, isProjectLevel } from '../../src/project-level.js';
import { digestProject } from '../../src/tree-digest.js';
import { touchedBy, applyOps } from '../../src/ops.js';
import { projectIsEmpty } from '../../src/context-gate.js';
import { recompileInheritors, chainFor } from '../../src/recompile.js';
import { updateShared, generateRoleFile, serializeToMd } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { UnknownWorkstreamError } from './role.core.js';
import { assertManager } from './review.core.js';
import { canApprove, numberQueueItem } from '../../src/review.js';
import { workstreamNumber } from '../../src/numbering.js';
import { needsReview } from '../../src/review-policy.js';
import { recordSources } from '../../src/sources.js';
import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, resolveDisplayName } from '../../src/prefs.js';
import { comparisonRecords, comparisonFingerprint } from '../../src/contradictions.js';

function newContribution({ text, author, authorKey, tagged, source, workstream }) {
  const idPrefix = source === 'mcp' ? 'mcp' : 'c';
  return {
    id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    author,
    // Stable identity behind the display name, so the same person contributing
    // from the CLI (git name) and from the hosted server (GitHub name) is not
    // counted as two contributors. Absent on contributions written before this
    // existed — readers fall back to `author`.
    ...(authorKey ? { authorKey } : {}),
    text,
    tagged: tagged || null,
    source: source || 'cli',
    workstream: workstream ?? null,
    status: 'logged',
  };
}

/**
 * Where a contribution came from, as a commit trailer.
 *
 * `git log .teamctx/` is the audit trail — it is what `teamctx stats` will
 * walk, and what someone reads when asking "where did this come from". Only
 * `mcp` was ever named there, so an imported contribution was indistinguishable
 * from a typed one even though the record knew the answer.
 *
 * In the body rather than the subject: a Slack source is
 * `import:slack:C0BPPEJVBV4/p1786543526387459`, and truncating it to fit a
 * subject line would destroy the one property that makes it worth recording —
 * that you can follow it back to the artifact.
 *
 * `cli` is the default and says nothing, because noting it on every commit
 * would be noise.
 */
export function sourceTrailer(source) {
  return !source || source === 'cli' ? '' : `

Source: ${source}`;
}

function workstreamDisplayName(id, workstream, config) {
  if (isProjectLevel(id)) return config.project || workstream.name || 'project';
  return config.workstreams?.find(w => w.id === id)?.name || workstream.name || config.project;
}

async function commitAndOptionallyPush(config, msg, projectDir) {
  await commitContext(msg, projectDir ? { cwd: projectDir } : undefined);
  if (!config.autoPush) return { pushed: false, pushError: null };
  try { await pushContext(projectDir ? { cwd: projectDir } : undefined); return { pushed: true, pushError: null }; }
  catch (err) { return { pushed: false, pushError: err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?' }; }
}

export async function contributeCore({
  text, author, workstreamId, decision = false, apply = false,
  source = 'cli', teamctxDir, projectDir,
  // Review whatever the project's policy says. An unattended agent has earned
  // none of the trust `additive` extends to a person adding context.
  reviewRequired = false,
  // Forwarded to the distiller. `import` sets intent:'document' so prose is
  // read for durable context rather than treated as a deliberate update.
  intent, avoid,
  // Called with what the distiller proposed, before any of it is written.
  // Returning false abandons the write; the contribution stays logged either
  // way, exactly as it did when the terminal asked this question itself.
  // It exists so the CLI can show a diff and still share this code path —
  // duplicating the path is what let the terminal drift out of step with the
  // review policy and the project layer without anybody noticing.
  onProposed,
  // What this was drawn from (#168): `[{ connector, title, link, summary }]`,
  // kept as references, never as contents. `sourcesVia` says how they came:
  // through the person's assistant, or through `teamctx import`.
  sources, sourcesVia = 'assistant',
} = {}) {
  if (!text) throw new Error('contribution text is required');
  const config = readConfig(teamctxDir);
  // An explicit `author` still wins — scripts and imports rely on it. Otherwise
  // the contribution is attributed to whoever is actually calling, not to the
  // `config.me` baked into the repo when someone ran `init`.
  const resolved = await resolveActor({ config, cwd: projectDir });
  const resolvedName = await resolveDisplayName({ actor: resolved, config, teamctxDir });
  const actor = author || resolvedName;
  const authorKey = author ? null : resolved.key;
  // apply=true writes straight to shared context, so it is the manager's alone.
  // Both arguments must come from the resolution, never from `author`: on a
  // project still using the legacy name gate, passing the caller's claimed name
  // here would let `contribute({ apply: true, author: "<manager>" })` walk
  // straight through.
  //
  // Asking for it without being the manager used to throw, and the throw happened
  // before the contribution was logged — so a member whose assistant guessed
  // wrong lost their text and had to write it again. It is dropped instead: the
  // contribution takes the ordinary path, and `applyRefused` on the result says
  // the flag was not honoured, so the assistant can say where it went rather than
  // ask for it a second time. Nothing is granted by asking; `apply` is simply not
  // a thing a member can do.
  // The project holds nothing at all yet — its own tree and every workstream's.
  // The manager's opening message then has nobody else to review it, so it
  // lands without asking: otherwise the project sits empty, refusing members,
  // until the manager approves their own first words. An agent's never does.
  const founding = projectIsEmpty(teamctxDir);
  const mayApply = canApprove(config, { actor: resolved, displayName: resolvedName })
    && (apply || (founding && !reviewRequired));
  const applyRefused = apply && !mayApply;
  // Where the warning about a legacy display-name gate lives — which is worth
  // saying to the one caller who just relied on that gate holding.
  if (mayApply && apply) assertManager(config, { actor: resolved, displayName: resolvedName });
  // `null` is the project itself, which is where a contribution goes when
  // nobody named a workstream — the base everything else inherits from.
  const targetId = resolveTarget(
    workstreamId ?? await resolveActiveWorkstream({ actor: resolved, config, teamctxDir }),
  );
  if (!isProjectLevel(targetId)) {
    const known = new Set([
      ...(config.workstreams || []).map(w => w.id),
      ...listWorkstreamIds(teamctxDir),
    ]);
    if (known.size > 0 && !known.has(targetId)) throw new UnknownWorkstreamError(targetId);
  }

  const workstream = readTree(targetId, teamctxDir);
  const tagged = decision ? 'decision' : null;
  const contribution = newContribution({ text, author: actor, authorKey, tagged, source, workstream: targetId });
  appendContribution(contribution, teamctxDir);

  let comparisons = comparisonRecords({ config, target: targetId, teamctxDir });
  let proposal = await updateShared(workstream, contribution, config, { intent, avoid, comparisonRecords: comparisons });
  // An AI call can outlive another contribution. Recheck once against the
  // current comparison set rather than applying a verdict on obsolete context.
  const latestConfig = readConfig(teamctxDir);
  const latestComparisons = comparisonRecords({ config: latestConfig, target: targetId, teamctxDir });
  if (comparisonFingerprint(comparisons) !== comparisonFingerprint(latestComparisons)) {
    comparisons = latestComparisons;
    const checked = await updateShared(readTree(targetId, teamctxDir), contribution, latestConfig, { intent, avoid, comparisonRecords: comparisons, operationsToCheck: proposal.operations });
    proposal = { ...checked, summary: proposal.summary, dropped: [...(proposal.dropped || []), ...(checked.dropped || [])] };
    if (comparisonFingerprint(comparisons) !== comparisonFingerprint(comparisonRecords({ config: readConfig(teamctxDir), target: targetId, teamctxDir }))) {
      throw new Error('Context changed again during the contradiction check. The contribution was logged; try it again before applying.');
    }
  }
  const { summary, operations, dropped = [], contradictions = [] } = proposal;
  // It reached the project, so what it was drawn from leaves a trace, written
  // with the rest of this contribution. A reference with no summary of its own
  // takes the contribution's.
  if (Array.isArray(sources) && sources.length) {
    recordSources(sources.map(s => (s && typeof s === 'object' && !s.summary ? { ...s, summary } : s)), {
      by: { name: actor, key: authorKey || resolved.key || null },
      at: contribution.ts,
      feed: { workstream: targetId, contribution: contribution.id },
      via: sourcesVia,
      dir: teamctxDir,
    });
  }
  // Reasons only: what the AI proposed that did not validate, so the caller can
  // say what was left out without the raw operation travelling any further.
  const droppedReasons = dropped.map(d => ({ reason: d.reason }));

  if (!operations || operations.length === 0) {
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'no-op', summary: 'No changes to context tree (contribution logged).',
      operations: [], pushed: false, pushError: null,
      ...(applyRefused ? { applyRefused: true } : {}),
      dropped: droppedReasons,
    };
  }

  // The caller is told what will actually happen, not what usually happens.
  // Under the `additive` policy an add-only contribution is written straight to
  // shared context, and the terminal was asking "submit for manager approval?"
  // before it knew that — so somebody answering yes was told their work had
  // gone to a queue it never entered.
  // Evidence queues the way a contradiction does, whoever sent it and whatever
  // they asked for. What needs checking is the distiller's inference that this
  // note argues against that assumption — and a manager's own `apply` is a
  // request to skip a queue, not a review of that inference.
  const carriesEvidence = operations.some(o => o?.type === 'addEvidence');
  const willQueue = contradictions.length > 0 || carriesEvidence
    || (!mayApply && (reviewRequired || needsReview(config, operations)));
  if (onProposed && (await onProposed({ summary, operations, willQueue, contradictions })) === false) {
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'discarded', summary, operations, pushed: false, pushError: null,
      ...(applyRefused ? { applyRefused: true } : {}),
      dropped: droppedReasons,
    };
  }

  // Two different questions, deliberately kept apart. `mayApply` is a manager
  // asking to bypass review and being allowed to. This asks whether the project
  // requires review of these operations at all — a member whose contribution only
  // adds is not acting as the manager by skipping a queue the project does not
  // want.
  if (willQueue) {
    // Numbered now, under the lock, so two submissions made at once do not take
    // the same number and a number is spoken for from the moment it is queued.
    let queuedNumber = null;
    withCounters(teamctxDir, current => {
      const queued = numberQueueItem({
        operations, tree: readTree(targetId, teamctxDir), nextKey: current.nextKey,
        workstream: targetId, number: workstreamNumber(current, targetId),
      });
      queuedNumber = queued.number;
      if (JSON.stringify(queued.nextKey) !== JSON.stringify(current.nextKey)) writeConfig({ ...current, nextKey: queued.nextKey }, teamctxDir);
      writeQueueItem({
        id: contribution.id, status: 'pending', createdAt: contribution.ts,
        ...(queued.number ? { number: queued.number } : {}),
        author: contribution.author, source, workstream: targetId,
        text: contribution.text, tagged: contribution.tagged, summary, operations,
        ...(contradictions.length ? { contradictions } : {}),
        ...(droppedReasons.length ? { dropped: droppedReasons } : {}),
      }, teamctxDir);
    });
    const { pushed, pushError } = await commitAndOptionallyPush(
      config,
      `queue: ${actor} submission pending approval (${contribution.id})${sourceTrailer(source)}`,
      projectDir,
    );
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'queued', summary, operations, pushed, pushError,
      ...(queuedNumber ? { number: queuedNumber } : {}),
      ...(contradictions.length ? { contradictions, ...(apply ? { applyRefused: true } : {}) } : {}),
      // Asked to apply, and evidence kept it in the queue: said the same way as
      // for a contradiction, so the assistant reports "sent for review".
      ...(applyRefused || (carriesEvidence && apply) ? { applyRefused: true } : {}),
      dropped: droppedReasons,
    };
  }

  const updated = withCounters(teamctxDir, current => {
    if (comparisonFingerprint(comparisons) !== comparisonFingerprint(comparisonRecords({ config: current, target: targetId, teamctxDir }))) {
      throw new Error('Context changed after the contradiction check. The contribution was logged; try it again before applying.');
    }
    const applied = applyOps(readTree(targetId, teamctxDir), operations, contribution.id, {
      nextKey: current.nextKey, workstreamNumber: workstreamNumber(current, targetId),
    });
    droppedReasons.push(...applied.dropped.map(d => ({ reason: d.reason })));
    writeConfig({ ...current, nextKey: applied.nextKey }, teamctxDir);
    writeTree(targetId, applied.tree, teamctxDir);
    return applied.tree;
  });
  const contributions = readContributions(teamctxDir);
  // A contribution to the project renders alone; a workstream renders under the
  // project and every part above it. Either way, the parts below inherit the
  // change, and a compiled page does not re-read anything on its own.
  const project = isProjectLevel(targetId) ? null : readProject(teamctxDir);
  const chain = isProjectLevel(targetId) ? [] : chainFor({ config, id: targetId, teamctxDir }).map(w => (w.id === targetId ? { ...updated, name: w.name, number: w.number } : w));
  writeTreeMd(
    targetId,
    serializeToMd(updated, workstreamDisplayName(targetId, updated, config), actor, contributions, { project, chain: isProjectLevel(targetId) ? null : chain }),
    teamctxDir,
  );
  recompileInheritors({ project: project ?? updated, config, contributions, teamctxDir });

  const rolesOnTarget = (config.roles || []).filter(r => resolveTarget(r.workstream) === targetId);
  const rolesRegenerated = [];
  for (const role of rolesOnTarget) {
    const md = await generateRoleFile(updated, role, config.project, config, contributions, { project, chain });
    writeRoleFile(role.slug, md, teamctxDir);
    rolesRegenerated.push(role.slug);
  }

  // Applied without a queue: by the manager, who is the approver, or under the
  // project's review policy, which approved it with nobody deciding (#143).
  writeApproved({
    id: contribution.id, author: actor, source, workstream: targetId,
    approvedBy: mayApply ? { key: resolved.key || null, name: resolvedName } : null,
    ...(mayApply ? {} : { by: 'policy' }),
    approvedAt: new Date().toISOString(),
  }, teamctxDir);

  const note = tagged === 'decision' ? ' [decision]' : '';
  const wsNote = isProjectLevel(targetId) ? '' : ` (${targetId})`;
  const { pushed, pushError } = await commitAndOptionallyPush(
    config,
    `context: ${actor} contribution${note}${wsNote}${sourceTrailer(source)}`,
    projectDir,
  );

  return {
    id: contribution.id, workstream: targetId, author: actor, source,
    mode: 'applied', summary, operations, rolesRegenerated, pushed, pushError,
    dropped: droppedReasons,
    // Only a task has a number a person can say. A record is found by its
    // wording and by asking, never by a number.
    tasks: updated.tasks
      .filter(x => (x.sourceContributionIds || []).includes(contribution.id))
      .map(x => ({ id: x.id, key: x.key })),
    // Reachable: a project on `none` requires review of nothing, so a member who
    // asked to bypass a queue that does not exist still gets their wish — just
    // not because they asked.
    ...(applyRefused ? { applyRefused: true } : {}),
    // What this contribution actually put in the tree, read back off the tree
    // it was written to. The operations cannot answer it: an add carries no id
    // until it is applied, and a contribution that also deletes carries only
    // the id of the statement that is now gone.
    touched: touchedBy(updated, contribution.id).filter(id => id !== 'goal'),
    // Only on the founding one. Every contribution after it lands beside
    // context the team already knows, and a digest each time would be noise.
    ...(founding ? { founding: true, digest: digestProject({ project: project ?? updated, workstreams: isProjectLevel(targetId) ? [] : [updated] }) } : {}),
  };
}
