import { proposeDiff, callClaude } from './ai.js';
import { targetLabel } from './project-level.js';
import { applyOps } from './ops.js';
import { renderBrief } from './brief.js';
import {
  collectContributorCounts, collectSourceRefs,
  formatContributorsSection, formatContributorLine, formatAuditBlock,
} from './provenance.js';

/**
 * Render a tree as Markdown. A project tree (no `id`) renders alone; a
 * workstream renders under the project and its ancestors, passed as `chain`
 * (ancestors first, the workstream last). Without a `chain`, the workstream is
 * the whole chain.
 */
export function serializeToMd(tree, projectName, lastUpdatedBy = '', contributions = [], {
  includeSourceTags = false, includeContributors = true, project = null, chain = null, flagged = null,
} = {}) {
  const isProject = !tree?.id;
  const md = renderBrief({
    projectName,
    project: isProject ? tree : project,
    chain: chain ?? (isProject ? [] : [tree]),
    includeSourceTags,
    lastUpdatedBy,
    flagged,
  });
  if (includeSourceTags || !includeContributors) return md;
  const c = formatContributorsSection(collectContributorCounts(tree, contributions));
  return c ? `${md}\n${c}` : md;
}

/**
 * `intent` and `avoid` are forwarded to the distiller — see proposeDiff. They
 * default to the plain contribution behaviour, so existing callers are
 * unaffected.
 */
export async function updateShared(tree, contribution, config, { intent, avoid, comparisonRecords, operationsToCheck } = {}) {
  const proposal = await proposeDiff({
    workstream: tree,
    contribution: contribution.text,
    source: contribution.author,
    model: config.model,
    config,
    intent,
    avoid,
    comparisonRecords,
    operationsToCheck,
  });
  const { summary, contradictions = [] } = proposal;
  const operations = operationsToCheck ?? proposal.operations;
  const { tree: updated, dropped, nextKey } = applyOps(tree, operations, contribution.id, {
    nextKey: config?.nextKey,
  });
  // What was dropped never reaches the queue or the tree: a reviewer approving
  // a proposal should see exactly what will be written.
  // By position, not by identity: `applyOps` copies an operation whose record
  // attaches to a task added alongside it, so comparing the objects let a
  // dropped operation through as a kept one.
  const kept = operations.filter((o, i) => !dropped.some(d => d.index === i));
  // Handed back rather than written here. The caller knows whether this tree is
  // about to be written or put in a queue, and the counters have to go the same
  // way the tree does — see `mintKey`.
  const conflicts = contradictions.filter(c => kept.includes(operations[c.operationIndex]))
    .map(c => ({ ...c, operationIndex: kept.indexOf(operations[c.operationIndex]) }));
  return { workstream: updated, summary, operations: kept, dropped, nextKey, contradictions: conflicts };
}

export async function generateRoleFile(workstream, role, projectName, config, contributions = [], { project = null, chain = null } = {}) {
  const tree = serializeToMd(workstream, projectName, '', contributions, { includeContributors: false, project, chain });
  const now = new Date().toISOString().split('T')[0];

  const prompt = [
    `Generate a role-specific context file for a team member.`,
    `Project: ${projectName}  Date: ${now}`,
    ``,
    `Full shared context:`,
    tree,
    `Keep the stored record and task keys beside every line you retain.`,
    ``,
    `Role: ${role.name}`,
    `Responsibilities: ${role.responsibilities}`,
    role.excludes ? `Does NOT need to know about: ${role.excludes}` : '',
    ``,
    `Generate a markdown file with EXACTLY these four sections:`,
    ``,
    `# ${role.name} Context — ${projectName}`,
    `*Last updated: ${now}*`,
    ``,
    `## Your Role`,
    `[who you are, what you own, what to ignore]`,
    ``,
    `## Your context`,
    `[filter the shared context for this role — same facts, different perspective. Keep each line's plain label ("Why it matters:", "We decided:", "Rule:", "Allowed:", "We're assuming:") exactly as written, and keep every "Allowed:" line directly under the rule it bends.]`,
    ``,
    `## Assumptions you own`,
    `[assumptions owned by this role, with the date to check each by — write "None currently." if none]`,
    ``,
    `## How to Use This File`,
    `Paste into your CLAUDE.md, or use as system context in ChatGPT / Gemini.`,
    `Starter prompt: "Based on my context, help me [describe what you're working on]."`,
    ``,
    `Return ONLY the markdown content.`,
  ].filter(Boolean).join('\n');

  return callClaude({ prompt, model: config.model, config });
}

export async function compileTaskPrompt({
  task, workstream, role, contributions, config, project = null, chain = null, flagged = null,
}) {
  const projectName = config?.project || workstream?.name || 'project';
  // A compiled prompt is the thing a person actually acts on, and it is written
  // once and read for weeks. A decision in it resting on an assumption that has
  // since broken is the most expensive place for the flag to be missing.
  const tree = serializeToMd(workstream, projectName, '', contributions, { includeContributors: false, project, chain, flagged });
  const now = new Date().toISOString().split('T')[0];
  const roleLine = role ? `Framed for role: ${role.name} — ${role.responsibilities || ''}` : 'No role filter — write for a general team member.';
  // The decisions and rules on this task's own chain, each exception under its
  // rule — never a loose list of everything anyone ever tagged.
  const settled = (w) => ({ ...w, tasks: [], records: (w?.records || []).filter(r => ['decision', 'rule', 'exception'].includes(r.type)) });
  const decisionsList = renderBrief({ projectName, project: null, chain: (chain || [workstream]).map(settled), flagged })
    .split('\n').filter(l => l.trimStart().startsWith('- ')).join('\n') || '(none yet)';

  const prompt = [
    `Generate a focused, AI-ready prompt file for ONE specific task.`,
    `Project: ${projectName}   Date: ${now}`,
    ``,
    `Task title: ${task.title}`,
    task.key ? `Task key: ${task.key}. Keep this key in the heading and keep record keys beside their context lines.` : '',
    `Task id: ${task.id}   Owner: ${task.owner || '(unassigned)'}   Belongs to: ${targetLabel(task.workstream, projectName)}`,
    roleLine,
    ``,
    `Full context for this part of the work (pick only what's relevant to THIS task):`,
    tree,
    ``,
    `Decisions and rules on this part of the work (may or may not be relevant to the task):`,
    decisionsList,
    ``,
    `Generate a markdown file with EXACTLY these sections:`,
    ``,
    `# Task: ${task.key ? `${task.key} — ` : ''}${task.title}`,
    ``,
    `**Owner:** ${task.owner || '(unassigned)'} · **Belongs to:** ${targetLabel(task.workstream, projectName)} · **Status:** ${task.status}`,
    `**Created:** ${task.createdAt || '-'} · **Compiled:** ${now}`,
    ``,
    `## Relevant context`,
    `[Pull ONLY the lines that bear on this task, keeping their plain labels. Skip everything else.]`,
    ``,
    `## Related decisions`,
    `[List any decisions above that materially constrain this task. If none, write "None currently."]`,
    ``,
    `## Suggested framing for your AI`,
    `[One short paragraph telling the reader how to use this file with an AI — e.g. "Paste this as system context and ask: how should I approach <task>?"]`,
    ``,
    `Return ONLY the markdown content — no code fences, no preamble.`,
  ].join('\n');

  return callClaude({ prompt, model: config.model, config });
}

const CITATIONS_HEADING = /\n{1,2}##\s*Citations\s*:?\s*/gi;
const CITATION_INSTRUCTION = 'The tree in the context is annotated with inline "[sources: c-x, c-y]" tags on each node. Do NOT include those "[sources: ...]" tags in your answer text — they are metadata for you, not the reader. Instead, at the very end of your answer, on its own line, output exactly "## Citations: id1, id2, id3" listing the contribution ids whose text materially informed your answer, most-important first. If none apply, output "## Citations: none".';

function parseCitations(answer) {
  if (!answer) return { body: answer, citedIds: [] };
  // The block we want is the one the AI appends last. Anchoring on the first
  // match would let a contribution that quotes "## Citations:" truncate the
  // answer and supply a bogus id list.
  const matches = [...answer.matchAll(CITATIONS_HEADING)];
  if (matches.length === 0) return { body: answer, citedIds: [] };
  const match = matches[matches.length - 1];
  const idx = match.index;
  const body = answer.slice(0, idx).trimEnd();
  const tail = answer.slice(idx + match[0].length).trim();
  if (!tail || /^none$/i.test(tail)) return { body, citedIds: [] };
  const citedIds = tail.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return { body, citedIds };
}

export async function answerQuestion({ sharedMd, roleMd, question, config, openTasks, workstream, contributions, audit, project = null }) {
  const contribs = contributions || [];
  const useCitedTags = !!workstream;
  const shared = useCitedTags
    ? serializeToMd(workstream, workstream.name || config?.project || 'project', '', contribs, { includeSourceTags: true, project })
    : sharedMd;
  const tasksMd = (openTasks && openTasks.length)
    ? `## Open Tasks\n\n${openTasks.map(t => `- ${t.key || t.id} — ${t.title} (owner: ${t.owner || '?'})`).join('\n')}`
    : '';

  const context = [
    roleMd ? `## Your Role Context\n\n${roleMd}` : '',
    shared ? `## Shared Project Context\n\n${shared}` : '',
    tasksMd,
  ].filter(Boolean).join('\n\n---\n\n');

  const system = [
    'You are a helpful assistant with access to the team\'s project context.',
    'Answer questions based on the context provided. Be concise and specific.',
    'Lines labelled "We decided:" and "Rule:" are settled by the team. An "Allowed:" line under a rule is an approved exception to that rule, for what it names, until its date. Prefer settled lines over anything that contradicts them, and say so when you rely on one.',
    useCitedTags ? CITATION_INSTRUCTION : '',
  ].filter(Boolean).join(' ');
  const prompt = `Context:\n\n${context}\n\n---\n\nQuestion: ${question}`;

  const raw = await callClaude({ prompt, model: config.model, system, config });
  const { body, citedIds } = useCitedTags ? parseCitations(raw) : { body: raw, citedIds: [] };
  const footer = buildAnswerFooter({ workstream, contributions: contribs, audit, citedIds });
  return footer ? `${body}\n\n---\n\n${footer}` : body;
}

const DEFAULT_CONTRIBUTOR_CAP = 5;

function buildAnswerFooter({ workstream, contributions, audit, citedIds }) {
  if (!workstream) return '';
  const cited = new Set(citedIds || []);
  if (audit) {
    const refs = collectSourceRefs(workstream, contributions);
    const filtered = { sources: refs.sources.filter(s => cited.has(s.contributionId)), unknown: [] };
    if (filtered.sources.length === 0) return '';
    return formatAuditBlock(filtered);
  }
  if (cited.size === 0) return '';
  const counts = collectContributorCounts(workstream, contributions, { citedIds: cited });
  if (counts.length === 0) return '';
  return formatContributorLine(counts.slice(0, DEFAULT_CONTRIBUTOR_CAP));
}

export { parseCitations };
