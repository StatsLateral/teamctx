import { LABELS, isActive, today, numberTasks } from './model.js';

/**
 * The one way a team's context is written out for a person or an AI.
 *
 * Every brief — the shared page, a role file, a task prompt, `my_brief` — reads
 * the same thing: the goal, then each part of the work from the project down to
 * the reader's own, with its reasons, rules, decisions and assumptions in plain
 * words, then its tasks. Type names never appear; the labels in `LABELS` do.
 */

const GROUPS = [
  ['why'],
  ['rule', 'decision', 'assumption'],
  ['question', 'risk'],
];

function line(r, tag) {
  const extra = r.type === 'assumption' && r.reviewBy ? ` (check by ${r.reviewBy})`
    : (r.type === 'question' || r.type === 'risk') && r.owner?.name ? ` (${r.owner.name})` : '';
  const plan = r.type === 'risk' && r.detail ? ` — plan: ${r.detail}` : '';
  return `- ${LABELS[r.type]} ${r.text}${extra}${plan}${tag(r)}`;
}

function section(records, onDay, tag) {
  const active = (records || []).filter(r => isActive(r, onDay));
  const exceptionsOf = (ruleId) => active.filter(r => r.type === 'exception' && r.links?.bends === ruleId);
  const out = [];
  for (const types of GROUPS) {
    for (const r of active.filter(x => types.includes(x.type))) {
      out.push(line(r, tag));
      if (r.type !== 'rule') continue;
      for (const e of exceptionsOf(r.id)) {
        out.push(`  - ${LABELS.exception} ${e.text} (until ${e.expiresAt}, instead of: ${r.text})${tag(e)}`);
      }
    }
  }
  // Exceptions are only ever printed under their rule (above), so one whose rule
  // isn't active in this brief is dropped on purpose: an exception read without
  // its rule is a contradiction, not context.
  return out;
}

const onTask = (r) => r.attachedTo?.kind === 'task';

export function renderBrief({
  projectName, project, chain = [], onDay = today(), includeSourceTags = false, lastUpdatedBy = '',
}) {
  const tag = includeSourceTags
    ? (x) => (x?.sourceContributionIds?.length ? `  [sources: ${x.sourceContributionIds.join(', ')}]` : '')
    : () => '';
  const by = lastUpdatedBy ? ` · Source: ${lastUpdatedBy} contribution` : '';
  const out = [`# Context — ${projectName}`, `*Last updated: ${onDay}${by}*`, ''];

  // Above a workstream, the project is inherited background: said so, so a
  // reader can tell what they may add to from what is settled above them.
  if (chain.length) out.push('## Project context *(inherited — read-only here)*', '');
  out.push(chain.length ? `**Goal:** ${project?.goal?.text || '*none yet*'}${tag(project?.goal)}` : '## Goal',
    ...(chain.length ? [] : [project?.goal?.text ? `${project.goal.text}${tag(project.goal)}` : '*No goal yet.*']), '');
  const projectLines = section((project?.records || []).filter(r => !onTask(r)), onDay, tag);
  if (projectLines.length) out.push(...projectLines, '');
  for (const t of project?.tasks || []) {
    out.push(`- Task: ${t.title}${t.owner ? ` — ${t.owner}` : ''}${t.status === 'done' ? ' (done)' : ''}${tag(t)}`);
    for (const r of section((project.records || []).filter(x => onTask(x) && x.attachedTo.id === t.id), onDay, tag)) out.push(`  ${r}`);
  }

  chain.forEach((ws, i) => {
    const inherited = i < chain.length - 1;
    out.push(`## ${ws.number ? `${ws.number} ` : ''}${ws.name || ws.id}${inherited ? ' *(inherited — read-only here)*' : ''}`, '');
    const lines = section((ws.records || []).filter(r => !onTask(r)), onDay, tag);
    if (lines.length) out.push(...lines, '');
    const nums = numberTasks(ws.tasks, ws.number);
    for (const t of ws.tasks || []) {
      out.push(`- ${nums.get(t.id)} ${t.title}${t.owner ? ` — ${t.owner}` : ''}${t.status === 'done' ? ' (done)' : ''}${tag(t)}`);
      for (const r of section((ws.records || []).filter(x => onTask(x) && x.attachedTo.id === t.id), onDay, tag)) out.push(`  ${r}`);
    }
    out.push('');
  });

  const empty = !project?.goal && !(project?.records || []).length && !(project?.tasks || []).length
    && !chain.some(w => (w.records || []).length || (w.tasks || []).length);
  if (empty) out.push('*No context yet. Tell your assistant what the project is about to add the first contribution.*');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
