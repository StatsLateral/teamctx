import { readProject, readConfig, readTree, writeTree, writeTreeMd, readContributions, writeRoleFile, listWorkstreamIds } from '../../src/storage.js';
import { resolveTarget, isProjectLevel } from '../../src/project-level.js';
import { generateReflection, serializeToMd, generateRoleFile } from '../../src/context.js';
import { preserveSourcesThroughReflect } from '../../src/provenance.js';
import { extractJson } from '../../src/ai.js';
import { commitContext, pushContext } from '../../src/git.js';
import { UnknownWorkstreamError } from './role.core.js';

import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, resolveDisplayName } from '../../src/prefs.js';
import { reflectNeedsManager } from '../../src/review-policy.js';
import { assertManager } from './review.core.js';

/** The caller's active workstream — their own preference, then the project default. */
async function activeId(config, teamctxDir, projectDir) {
  const actor = await resolveActor({ config, cwd: projectDir });
  return resolveActiveWorkstream({ actor, config, teamctxDir });
}


export async function reflectWorkstream({ workstreamId, teamctxDir, projectDir, onProposed } = {}) {
  const config = readConfig(teamctxDir);
  // Reflect replaces the whole tree with whatever the model returns — there is
  // no smaller unit of it to queue, and no diff anyone is shown. So it follows
  // the project's review policy rather than carrying a gate of its own: under
  // `none` anyone may run it, which is what it did before this existed.
  if (reflectNeedsManager(config)) {
    const actor = await resolveActor({ config, cwd: projectDir });
    assertManager(config, {
      actor,
      displayName: await resolveDisplayName({ actor, config, teamctxDir }),
    });
  }
  const targetId = resolveTarget(workstreamId ?? await activeId(config, teamctxDir, projectDir));
  if (!isProjectLevel(targetId)) {
    const knownIds = new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds(teamctxDir)]);
    if (!knownIds.has(targetId)) throw new UnknownWorkstreamError(targetId);
  }
  const workstream = readTree(targetId, teamctxDir);
  const contributions = readContributions(teamctxDir);

  const raw = await generateReflection(workstream, contributions, config);
  let updated;
  try {
    const parsed = extractJson(raw);
    const next = { ...workstream, whys: Array.isArray(parsed.whys) ? parsed.whys : workstream.whys };
    // Without this a reflection silently drops every statement's provenance —
    // the CLI has always done it and this path never did, so a rewrite over MCP
    // cost the project its "where did this come from" trail.
    updated = preserveSourcesThroughReflect(workstream, next);
  } catch (err) {
    throw new Error(`AI returned invalid JSON. Reflection aborted. ${err.message}`);
  }

  if (onProposed && (await onProposed({ workstream, updated, targetId })) === false) {
    return { workstreamId: targetId, applied: false, updatedTree: null, rolesRegenerated: [], pushed: false, pushError: null };
  }

  const wsName = isProjectLevel(targetId)
    ? (config.project || workstream.name || 'project')
    : (config.workstreams?.find(w => w.id === targetId)?.name || workstream.name || config.project);
  writeTree(targetId, updated, teamctxDir);
  const project = isProjectLevel(targetId) ? null : readProject(teamctxDir);
  writeTreeMd(targetId, serializeToMd(updated, wsName, 'reflect', contributions, { project }), teamctxDir);

  const rolesOnTarget = (config.roles || []).filter(r => resolveTarget(r.workstream) === targetId);
  const rolesRegenerated = [];
  for (const role of rolesOnTarget) {
    const md = await generateRoleFile(updated, role, config.project, config, contributions, { project });
    writeRoleFile(role.slug, md, teamctxDir);
    rolesRegenerated.push(role.slug);
  }

  await commitContext(`context: reflect ${targetId} — AI rewrote shared context`, projectDir ? { cwd: projectDir } : undefined);
  let pushed = false, pushError = null;
  if (config.autoPush) {
    try { await pushContext(projectDir ? { cwd: projectDir } : undefined); pushed = true; }
    catch (err) { pushError = err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?'; }
  }

  return { workstreamId: targetId, applied: true, updatedTree: updated, rolesRegenerated, pushed, pushError };
}
