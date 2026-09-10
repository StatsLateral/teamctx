import {
  readConfig, writeConfig, readWorkstream, writeWorkstream, writeWorkstreamMd,
  readTree, writeTree, writeTreeMd, readProject,
  listWorkstreamIds, writeRoleFile, readContributions,
} from '../../src/storage.js';
import { proposeSubworkstreams, serializeToMd, generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { slugify } from '../../src/roles.js';
import { UnknownWorkstreamError } from './role.core.js';
import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, writePrefs } from '../../src/prefs.js';
import { resolveTarget, isProjectLevel, targetLabel } from '../../src/project-level.js';
import { recompileInheritors } from '../../src/recompile.js';
import { describeMembership, membershipModel } from '../../src/membership-model.js';

/** The caller's active workstream — their own preference, then the project default. */
async function activeId(config, teamctxDir, projectDir) {
  const actor = await resolveActor({ config, cwd: projectDir });
  return resolveActiveWorkstream({ actor, config, teamctxDir });
}

export class WorkstreamSplitError extends Error {
  constructor(msg) { super(msg); this.code = 'WORKSTREAM_SPLIT'; }
}

function knownWorkstreams(config, teamctxDir) {
  return new Set([...(config.workstreams || []).map(w => w.id), ...listWorkstreamIds(teamctxDir)]);
}

async function commitAndOptionallyPush(config, msg, projectDir) {
  await commitContext(msg, projectDir ? { cwd: projectDir } : undefined);
  if (!config.autoPush) return { pushed: false, pushError: null };
  try { await pushContext(projectDir ? { cwd: projectDir } : undefined); return { pushed: true, pushError: null }; }
  catch (err) { return { pushed: false, pushError: err.message?.split('\n')[0] || err.stderr?.trim() || 'no remote?' }; }
}

export async function listAllWorkstreams({ teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const active = await activeId(config, teamctxDir, projectDir);
  const declared = config.workstreams || [];
  const onDisk = new Set(listWorkstreamIds(teamctxDir));
  const ids = Array.from(new Set([...declared.map(w => w.id), ...onDisk])).sort();
  return ids.map(id => {
    const meta = declared.find(w => w.id === id);
    const ws = readWorkstream(id, teamctxDir);
    const roles = (config.roles || []).filter(r => resolveTarget(r.workstream) === resolveTarget(id)).map(r => r.slug);
    return {
      id,
      name: meta?.name || ws.name || id,
      isActive: id === active,
      whyCount: ws.whys?.length || 0,
      roles,
    };
  });
}

export async function suggestWorkstreamSplits({ workstreamId, teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  // A caller may hand in the target it has already resolved. The MCP server
  // does, because a stored preference can name a workstream the member has
  // since been scoped off, and reading it raw would hand back that tree.
  const active = workstreamId !== undefined
    ? resolveTarget(workstreamId)
    : await activeId(config, teamctxDir, projectDir);
  // `readTree`, not `readWorkstream`: after the project layer the caller is at
  // project level unless they chose otherwise, and that is the tree with
  // everything in it — the one most worth splitting.
  const source = readTree(active, teamctxDir);
  const { splits, leftover } = await proposeSubworkstreams(source, config, config.roles || []);
  const enriched = splits.map(s => ({
    name: s.name,
    rationale: s.rationale || '',
    whyIds: s.whyIds,
    whys: s.whyIds.map(id => source.whys.find(w => w.id === id)).filter(Boolean),
    // How a person's part in this thread is best expressed. A proposal, not a
    // setting: it is returned for the manager to accept or ignore, and nothing
    // stores it until they do.
    membership: s.membership,
  }));
  const leftoverWhys = leftover.map(id => source.whys.find(w => w.id === id)).filter(Boolean);
  return { activeId: active, workstream: source, splits: enriched, leftover: leftoverWhys };
}

/**
 * How this project is structured, proposed in one pass.
 *
 * Which Whys become workstreams and how people are placed in each are one
 * decision, and asking them separately handed the manager two disconnected
 * lists to reconcile in their head. Reading from the project tree rather than
 * the active workstream is the other half: after the project layer, "a project
 * tree and no workstreams" is the ordinary state and the one where a proposal
 * is most useful.
 *
 * Writes nothing. `workstream_split` remains what writes.
 */
export async function proposeStructure({ teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const project = readProject(teamctxDir);
  const whys = project.whys || [];

  if (whys.length === 0) {
    return {
      project: config.project || project.name || 'project',
      workstreams: [],
      leftover: [],
      why: 'This project has no context yet, so there is nothing to organise. '
        + 'Tell me what it is about first.',
    };
  }

  const { splits, leftover } = await proposeSubworkstreams(project, config, config.roles || []);
  return {
    project: config.project || project.name || 'project',
    workstreams: splits.map(s => ({
      name: s.name,
      rationale: s.rationale || '',
      whyIds: s.whyIds,
      whys: s.whyIds.map(id => whys.find(w => w.id === id)).filter(Boolean),
      membership: {
        ...s.membership,
        // Normalised here as well as upstream, so `model` and `means` cannot
        // disagree: describing one model while naming another would be worse
        // than either on its own.
        model: membershipModel(s.membership?.model),
        means: describeMembership(s.membership?.model),
      },
    })),
    leftover: leftover.map(id => whys.find(w => w.id === id)).filter(Boolean),
  };
}

async function applySplit({ source, sourceId, split, moveRoleSlugs, config, teamctxDir }) {
  const existingIds = knownWorkstreams(config, teamctxDir);
  const newId = slugify(split.name);
  if (!newId) throw new WorkstreamSplitError(`split name "${split.name}" produced an empty id.`);
  if (existingIds.has(newId)) throw new WorkstreamSplitError(`workstream id "${newId}" already exists.`);

  const movingWhys = source.whys.filter(w => split.whyIds.includes(w.id));
  if (movingWhys.length === 0) throw new WorkstreamSplitError(`no matching Why nodes for "${split.name}" (source may have changed).`);
  const remainingWhys = source.whys.filter(w => !split.whyIds.includes(w.id));
  const newWs = { id: newId, name: split.name, whys: movingWhys };
  const updatedSource = { ...source, whys: remainingWhys };

  // Splitting the project is the ordinary case now, and the project is not a
  // workstream: it has its own file and its own compiled page. Writing the
  // source back through `writeTree` is what keeps a split from creating a
  // workstream named after nothing.
  const fromProject = isProjectLevel(sourceId);
  // What the new workstream inherits: the project as it stands once these Whys
  // have moved out of it, so a Why is not both inherited and owned.
  const project = fromProject ? updatedSource : readProject(teamctxDir);

  writeWorkstream(newId, newWs, teamctxDir);
  writeWorkstreamMd(newId, serializeToMd(newWs, split.name, '', [], { project }), teamctxDir);
  writeTree(sourceId, updatedSource, teamctxDir);
  const sourceName = fromProject
    ? (config.project || source.name || 'project')
    : (config.workstreams?.find(w => w.id === sourceId)?.name || source.name || sourceId);
  // With `project` when the source is a workstream: without it the source's
  // page was rewritten minus its inherited section, and stayed that way until
  // the next contribute, reflect or approval touched it.
  writeTreeMd(
    sourceId,
    serializeToMd(updatedSource, sourceName, '', [], fromProject ? {} : { project }),
    teamctxDir,
  );

  // Whys that just left the project stop being inherited, and a compiled page
  // does not re-read anything — so every sibling went on showing them as
  // inherited until something unrelated happened to touch it.
  if (fromProject) {
    recompileInheritors({ project: updatedSource, config, teamctxDir });
  }

  const rolesOnSource = (config.roles || []).filter(r => resolveTarget(r.workstream) === resolveTarget(sourceId));
  const validMoveSlugs = (moveRoleSlugs || []).filter(s => rolesOnSource.some(r => r.slug === s));
  const unknownRequested = (moveRoleSlugs || []).filter(s => !rolesOnSource.some(r => r.slug === s));

  const updatedConfig = {
    ...config,
    workstreams: [...(config.workstreams || []), { id: newId, name: split.name, createdAt: new Date().toISOString() }],
    roles: (config.roles || []).map(r => validMoveSlugs.includes(r.slug) ? { ...r, workstream: newId } : r),
  };
  writeConfig(updatedConfig, teamctxDir);

  const contributions = readContributions(teamctxDir);
  for (const slug of validMoveSlugs) {
    const role = updatedConfig.roles.find(r => r.slug === slug);
    const md = await generateRoleFile(newWs, role, updatedConfig.project, updatedConfig, contributions, { project });
    writeRoleFile(slug, md, teamctxDir);
  }
  const stillOnSource = (updatedConfig.roles || []).filter(r => resolveTarget(r.workstream) === resolveTarget(sourceId));
  for (const role of stillOnSource) {
    // A role left on the project reads the project tree itself — passing it
    // again as the inherited half would print every Why twice.
    const md = await generateRoleFile(updatedSource, role, updatedConfig.project, updatedConfig, contributions,
      fromProject ? {} : { project });
    writeRoleFile(role.slug, md, teamctxDir);
  }

  return { newId, movedWhyCount: movingWhys.length, movedRoles: validMoveSlugs, unknownRoles: unknownRequested };
}

export async function splitWorkstreams({ accepted, workstreamId, teamctxDir, projectDir } = {}) {
  if (!Array.isArray(accepted) || accepted.length === 0) {
    throw new WorkstreamSplitError('accepted must be a non-empty array of splits.');
  }
  const config = readConfig(teamctxDir);
  const active = workstreamId !== undefined
    ? resolveTarget(workstreamId)
    : await activeId(config, teamctxDir, projectDir);
  const source = readTree(active, teamctxDir);
  if ((source.whys || []).length < 2) {
    throw new WorkstreamSplitError(`${targetLabel(active, config.project)} has fewer than 2 Why nodes — nothing to split.`);
  }

  const results = [];
  for (const split of accepted) {
    const fresh = readConfig(teamctxDir);
    const src = readTree(active, teamctxDir);
    const r = await applySplit({
      source: src, sourceId: active, split,
      moveRoleSlugs: split.moveRoles || [],
      config: fresh, teamctxDir,
    });
    const finalConfig = readConfig(teamctxDir);
    const { pushed, pushError } = await commitAndOptionallyPush(
      finalConfig, `workstream: split "${split.name}" from ${targetLabel(active, finalConfig.project)}`, projectDir,
    );
    results.push({ ...r, splitName: split.name, pushed, pushError });
  }
  return { sourceId: active, results };
}

/**
 * Switching workstream is a personal act, so it writes to the caller's
 * preferences rather than the shared config — no repo write, no commit, and no
 * effect on anyone else. `config.activeWorkstream` stays as the project default
 * for people who have never switched.
 */
/**
 * Move this caller to a workstream, or back to the project.
 *
 * Project level has to be reachable on purpose, not only by never having chosen
 * anything: once somebody switches into a workstream there would otherwise be no
 * way back to the whole picture. `null` — and `main`, from habit — mean the
 * project, and clearing the preference is what returns them there.
 */
export async function useWorkstream({ id, teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const target = resolveTarget(id);
  if (target !== null && !knownWorkstreams(config, teamctxDir).has(target)) {
    throw new UnknownWorkstreamError(target);
  }
  const actor = await resolveActor({ config, cwd: projectDir });
  await writePrefs(actor, { activeWorkstream: target }, teamctxDir);
  return { activeWorkstream: target, actor: actor.name };
}
