import { readProject, readConfig, readTree, writeTree, writeTreeMd, appendContribution, writeRoleFile, writeQueueItem, readContributions, listWorkstreamIds } from '../../src/storage.js';
import { resolveTarget, isProjectLevel } from '../../src/project-level.js';
import { digestTree } from '../../src/tree-digest.js';
import { projectIsEmpty } from '../../src/context-gate.js';
import { recompileInheritors } from '../../src/recompile.js';
import { updateShared, generateRoleFile, serializeToMd } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { UnknownWorkstreamError } from './role.core.js';
import { assertManager } from './review.core.js';
import { needsReview } from '../../src/review-policy.js';
import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, resolveDisplayName } from '../../src/prefs.js';

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
  // apply=true writes straight to shared context, so it is gated. Both arguments
  // must come from the resolution, never from `author`: on a project still using
  // the legacy name gate, passing the caller's claimed name here would let
  // `contribute({ apply: true, author: "<manager>" })` walk straight through.
  if (apply) assertManager(config, { actor: resolved, displayName: resolvedName });
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
  // The project holds nothing at all yet — its own tree and every workstream's,
  // the sum `get_status` reports as `totalWhys`. Asking only whether *this* tree
  // is empty called a new workstream on a running project "the project's first
  // context", which is an ordinary thing to do and not that. See
  // src/tree-digest.js.
  const founding = projectIsEmpty(teamctxDir);
  const tagged = decision ? 'decision' : null;
  const contribution = newContribution({ text, author: actor, authorKey, tagged, source, workstream: targetId });
  appendContribution(contribution, teamctxDir);

  const { workstream: updated, summary, operations } = await updateShared(workstream, contribution, config, { intent, avoid });

  if (!operations || operations.length === 0) {
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'no-op', summary: 'No changes to context tree (contribution logged).',
      operations: [], pushed: false, pushError: null,
    };
  }

  // The caller is told what will actually happen, not what usually happens.
  // Under the `additive` policy an add-only contribution is written straight to
  // shared context, and the terminal was asking "submit for manager approval?"
  // before it knew that — so somebody answering yes was told their work had
  // gone to a queue it never entered.
  const willQueue = !apply && (reviewRequired || needsReview(config, operations));
  if (onProposed && (await onProposed({ summary, operations, willQueue })) === false) {
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'discarded', summary, operations, pushed: false, pushError: null,
    };
  }

  // Two different questions, deliberately kept apart. `apply` is a caller
  // asking to bypass review, and stays manager-gated above. This asks whether
  // the project requires review of these operations at all — a member whose
  // contribution only adds is not acting as the manager by skipping a queue the
  // project does not want.
  if (willQueue) {
    writeQueueItem({
      id: contribution.id, status: 'pending', createdAt: contribution.ts,
      author: contribution.author, source, workstream: targetId,
      text: contribution.text, tagged: contribution.tagged, summary, operations,
    }, teamctxDir);
    const { pushed, pushError } = await commitAndOptionallyPush(
      config,
      `queue: ${actor} submission pending approval (${contribution.id})${sourceTrailer(source)}`,
      projectDir,
    );
    return {
      id: contribution.id, workstream: targetId, author: actor, source,
      mode: 'queued', summary, operations, pushed, pushError,
    };
  }

  writeTree(targetId, updated, teamctxDir);
  const contributions = readContributions(teamctxDir);
  // A contribution to the project itself is not inheriting from anything, so it
  // renders alone; a workstream renders under the project tree it inherits.
  const project = isProjectLevel(targetId) ? null : readProject(teamctxDir);
  writeTreeMd(
    targetId,
    serializeToMd(updated, workstreamDisplayName(targetId, updated, config), actor, contributions, { project }),
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
    // Only on the founding one. Every contribution after it lands beside
    // context the team already knows, and a digest each time would be noise.
    ...(founding ? { founding: true, digest: digestTree(updated) } : {}),
  };
}
