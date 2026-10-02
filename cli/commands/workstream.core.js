import {
  readConfig, writeConfig, readWorkstream, writeWorkstream, writeWorkstreamMd,
  readTree, writeTree, writeTreeMd, readProject,
  listWorkstreamIds, writeRoleFile, readContributions,
} from '../../src/storage.js';
import { serializeToMd, generateRoleFile } from '../../src/context.js';
import { callClaude, extractJson } from '../../src/ai.js';
import { commitContext, pushContext } from '../../src/git.js';
import { slugify } from '../../src/roles.js';
import { UnknownWorkstreamError } from './role.core.js';
import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, writePrefs } from '../../src/prefs.js';
import { resolveTarget, isProjectLevel, targetLabel } from '../../src/project-level.js';
import { recompileInheritors } from '../../src/recompile.js';
import { describeMembership, membershipModel, MEMBERSHIP_MODELS } from '../../src/membership-model.js';
import { emptyWorkstream, numberWorkstreams, RECORD_TYPES } from '../../src/model.js';
import { assertManager, currentIdentity } from './review.core.js';

/** The caller's active workstream — their own preference, then the project default. */
async function activeId(config, teamctxDir, projectDir) {
  const actor = await resolveActor({ config, cwd: projectDir });
  return resolveActiveWorkstream({ actor, config, teamctxDir });
}

export class WorkstreamParentError extends Error {
  constructor(parent) { super(`no workstream "${parent}" to put this under`); this.code = 'WORKSTREAM_PARENT'; }
}

/**
 * Add a part of the work, at the top or under another part.
 *
 * Structure is the manager's: it decides who reaches what, since being on a
 * workstream means being on everything below it. The registry in
 * `config.workstreams` holds the shape (parent, order); the workstream's own
 * file holds its records and tasks.
 */
export async function addWorkstream({ name, parent = null, teamctxDir, projectDir } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('a workstream needs a name');
  const config = readConfig(teamctxDir);
  const { actor, displayName } = await currentIdentity(config, teamctxDir, projectDir);
  assertManager(config, { actor, displayName });
  const list = config.workstreams || [];
  if (parent && !list.some(w => w.id === parent)) throw new WorkstreamParentError(parent);
  const base = slugify(clean) || 'workstream';
  let id = base;
  for (let i = 2; list.some(w => w.id === id) || listWorkstreamIds(teamctxDir).includes(id); i++) id = `${base}-${i}`;
  const siblings = list.filter(w => (w.parent || null) === (parent || null));
  const order = Math.max(0, ...siblings.map(w => w.order || 0)) + 1;
  const entry = { id, name: clean, parent: parent || null, order, createdAt: new Date().toISOString() };
  const next = { ...config, workstreams: [...list, entry] };
  writeConfig(next, teamctxDir);
  writeWorkstream(id, emptyWorkstream(id, clean), teamctxDir);
  const git = await commitAndOptionallyPush(next, `workstream: add ${id}${parent ? ` under ${parent}` : ''}`, projectDir);
  return { workstream: { ...entry, number: numberWorkstreams(next).get(id) }, ...git };
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
  const numbers = numberWorkstreams(config);
  const ids = Array.from(new Set([...declared.map(w => w.id), ...listWorkstreamIds(teamctxDir)]));
  return ids.map(id => {
    const meta = declared.find(w => w.id === id);
    const ws = readWorkstream(id, teamctxDir);
    const roles = (config.roles || []).filter(r => resolveTarget(r.workstream) === resolveTarget(id)).map(r => r.slug);
    return {
      id,
      name: meta?.name || ws.name || id,
      parent: meta?.parent || null,
      number: numbers.get(id) || null,
      isActive: id === active,
      recordCount: (ws.records || []).filter(r => r.status === 'active').length,
      taskCount: (ws.tasks || []).length,
      roles,
    };
  }).sort((x, y) => String(x.number ?? '~').localeCompare(String(y.number ?? '~'), undefined, { numeric: true }));
}

/**
 * How this project could be organised, as a draft in the governed model.
 *
 * Read-only: it writes nothing. A draft implies who works where, and applying a
 * wrong guess quietly is worse than making the manager say yes (#124 applies one).
 */
export async function proposeStructure({ teamctxDir } = {}) {
  const config = readConfig(teamctxDir);
  const project = readProject(teamctxDir);
  const contributions = readContributions(teamctxDir);
  const name = config.project || project.name || 'project';
  const hasAnything = project.goal || (project.records || []).length || (project.tasks || []).length || contributions.length;
  if (!hasAnything) {
    return {
      project: name, goal: null, why: null, workstreams: [], questions: [],
      why: 'This project has no context yet, so there is nothing to organise. Tell me what it is about first.',
    };
  }

  const prompt = [
    `Draft how the project "${name}" could be organised. Nothing is applied; a manager will edit your draft.`,
    '',
    'What the project holds now:',
    JSON.stringify({
      goal: project.goal?.text || null,
      records: (project.records || []).filter(r => r.status === 'active').map(r => ({ type: r.type, text: r.text })),
      tasks: (project.tasks || []).map(t => t.title),
      roles: (config.roles || []).map(r => r.name),
    }, null, 2),
    '',
    'Recent contributions:',
    ...contributions.slice(-20).map(c => `- ${String(c.text || '').slice(0, 400)}`),
    '',
    'Output STRICT JSON:',
    `{
  "goal": "one line",
  "why": "why the goal matters, in plain words",
  "workstreams": [
    { "name": "a part of the work", "parent": "name of another proposed part, or null", "rationale": "why these belong together",
      "tasks": ["concrete work"], "records": [{ "type": "${RECORD_TYPES.join('|')}", "text": "..." }],
      "membership": { "model": "${MEMBERSHIP_MODELS.join('|')}", "rationale": "how a person fits" } }
  ],
  "questions": ["anything the material contradicts itself on, as an open question"]
}`,
    'Use as few parts as the work needs; one is a fine answer. JSON only.',
  ].join('\n');

  const parsed = extractJson(await callClaude({ prompt, model: config.model, config }));
  const text = (v) => String(v ?? '').trim();
  const workstreams = (Array.isArray(parsed.workstreams) ? parsed.workstreams : [])
    .filter(w => text(w?.name))
    .map(w => ({
      name: text(w.name),
      parent: text(w.parent) || null,
      rationale: text(w.rationale),
      tasks: (w.tasks || []).map(text).filter(Boolean),
      records: (w.records || []).filter(r => RECORD_TYPES.includes(r?.type) && text(r.text)).map(r => ({ type: r.type, text: text(r.text) })),
      membership: {
        model: membershipModel(w.membership?.model),
        means: describeMembership(w.membership?.model),
        rationale: text(w.membership?.rationale),
      },
    }));
  return {
    project: name,
    goal: text(parsed.goal) || project.goal?.text || null,
    why: text(parsed.why) || project.goal?.why || null,
    workstreams,
    questions: (parsed.questions || []).map(text).filter(Boolean),
  };
}

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
