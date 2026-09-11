import { readConfig, writeConfig, readWorkstream, readTree, readProject, listWorkstreamIds, writeRoleFile, readContributions } from '../../src/storage.js';
import { resolveTarget, isProjectLevel, targetLabel } from '../../src/project-level.js';
import { addRole as addRoleData, suggestRoles as aiSuggestRoles, slugify } from '../../src/roles.js';
import { generateRoleFile } from '../../src/context.js';
import { commitContext, pushContext } from '../../src/git.js';
import { callClaude, extractJson, getFastModelFor } from '../../src/ai.js';

import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream } from '../../src/prefs.js';

/** The caller's active workstream — their own preference, then the project default. */
async function activeId(config, teamctxDir, projectDir) {
  const actor = await resolveActor({ config, cwd: projectDir });
  return resolveActiveWorkstream({ actor, config, teamctxDir });
}


export class UnknownRoleError extends Error {
  constructor(slug) { super(`no role "${slug}". Run \`teamctx role list\` to see options.`); this.code = 'UNKNOWN_ROLE'; }
}
export class UnknownWorkstreamError extends Error {
  constructor(id) { super(`no workstream "${id}". Run \`teamctx workstream list\`.`); this.code = 'UNKNOWN_WORKSTREAM'; }
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

export function listRoles({ teamctxDir } = {}) {
  const config = readConfig(teamctxDir);
  return config.roles || [];
}

export async function suggestRoleDetails({ name, workstream, config }) {
  const tree = workstream.whys.map(w => `- ${w.text}`).join('\n') || '(no context yet)';
  const prompt = [
    `Given the role "${name}" at a company with this context:`,
    tree,
    ``,
    `Suggest brief, specific responsibilities and exclusions for this role.`,
    `Return JSON: {"responsibilities": "...", "excludes": "..."}`,
    `Keep each under 15 words. JSON only.`,
  ].join('\n');
  const raw = await callClaude({ prompt, model: getFastModelFor(config.provider), config });
  const parsed = extractJson(raw);
  return { responsibilities: parsed.responsibilities || '', excludes: parsed.excludes || '' };
}

export async function suggestRoles({ workstreamId, teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const wsId = resolveTarget(workstreamId || await activeId(config, teamctxDir, projectDir));
  // A project with no workstreams is the ordinary shape now, and its tree is
  // where the context is — reading it as a workstream suggested roles for an
  // empty project.
  const workstream = readTree(wsId, teamctxDir);
  const suggestions = await aiSuggestRoles(workstream, config);
  return { workstreamId: wsId, suggestions };
}

export async function addRoleFull({
  name, responsibilities, excludes, email,
  workstreamId, teamctxDir, projectDir,
} = {}) {
  if (!name) throw new Error('role name is required');
  if (!responsibilities) throw new Error('responsibilities are required');
  const config = readConfig(teamctxDir);
  const wsId = resolveTarget(workstreamId || await activeId(config, teamctxDir, projectDir));
  // The project is not in the workstream list and never will be, so checking a
  // project-level role against that list refused every role on a project that
  // has not split — which is every project, on the day it is created.
  if (!isProjectLevel(wsId) && !knownWorkstreams(config, teamctxDir).has(wsId)) {
    throw new UnknownWorkstreamError(wsId);
  }

  const { slug, config: updatedConfig } = addRoleData({
    name, responsibilities, excludes: excludes || '', email: email || undefined, workstream: wsId,
  }, config);
  writeConfig(updatedConfig, teamctxDir);

  const workstream = readTree(wsId, teamctxDir);
  const contributions = readContributions(teamctxDir);
  const roleData = updatedConfig.roles.find(r => r.slug === slug);
  // A role on a workstream is compiled with the project above it, the same as
  // every other view of that workstream. A role on the project reads it once.
  const md = await generateRoleFile(workstream, roleData, updatedConfig.project, updatedConfig, contributions,
    isProjectLevel(wsId) ? {} : { project: readProject(teamctxDir) });
  writeRoleFile(slug, md, teamctxDir);

  const { pushed, pushError } = await commitAndOptionallyPush(
    updatedConfig, `feat: add role "${slug}" to teamctx`, projectDir,
  );

  return { slug, role: roleData, workstreamId: wsId, pushed, pushError };
}

export async function assignRole({ slug, workstreamId, teamctxDir, projectDir } = {}) {
  const config = readConfig(teamctxDir);
  const role = (config.roles || []).find(r => r.slug === slug);
  if (!role) throw new UnknownRoleError(slug);
  if (workstreamId === undefined) throw new Error('workstreamId is required');
  // Moving a role back to the project is a real move now, so project level is
  // a destination rather than a missing argument.
  const target = resolveTarget(workstreamId);
  if (!isProjectLevel(target) && !knownWorkstreams(config, teamctxDir).has(target)) {
    throw new UnknownWorkstreamError(target);
  }
  if (resolveTarget(role.workstream) === target) {
    return { slug, workstreamId: target, changed: false, pushed: false, pushError: null };
  }

  const updatedConfig = {
    ...config,
    roles: config.roles.map(r => r.slug === slug ? { ...r, workstream: target } : r),
  };
  writeConfig(updatedConfig, teamctxDir);

  const workstream = readTree(target, teamctxDir);
  const contributions = readContributions(teamctxDir);
  const md = await generateRoleFile(
    workstream, updatedConfig.roles.find(r => r.slug === slug),
    updatedConfig.project, updatedConfig, contributions,
    isProjectLevel(target) ? {} : { project: readProject(teamctxDir) },
  );
  writeRoleFile(slug, md, teamctxDir);

  const { pushed, pushError } = await commitAndOptionallyPush(
    updatedConfig, `role: assign "${slug}" to ${targetLabel(target, updatedConfig.project)}`, projectDir,
  );

  return { slug, workstreamId: target, changed: true, pushed, pushError };
}

export { slugify };
