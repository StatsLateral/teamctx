import { proposeDiff, callClaude, extractJson } from './ai.js';
import { applyOps } from './ops.js';
import {
  collectContributorCounts, collectSourceRefs,
  formatContributorsSection, formatContributorLine, formatAuditBlock,
} from './provenance.js';

function decisionMarker(node, contributionsById) {
  const ids = node.sourceContributionIds || [];
  let latest = null;
  for (const id of ids) {
    const c = contributionsById.get(id);
    if (c && c.tagged === 'decision') {
      if (!latest || (c.ts || '') > (latest.ts || '')) latest = c;
    }
  }
  if (!latest) return '';
  const date = (latest.ts || '').split('T')[0] || 'unknown';
  const author = latest.author || 'unknown';
  const source = latest.source || 'cli';
  return `  *[decision — ${author}, ${date}, via ${source}]*`;
}

function sourceTag(node) {
  const ids = node.sourceContributionIds || [];
  return ids.length ? `  [sources: ${ids.join(', ')}]` : '';
}

// `includeSourceTags` annotates each node with `[sources: c-x]` for the ask
// prompt; `includeContributors` appends the `## Contributors` roll-up. The
// roll-up belongs in the markdown we write to disk, not in prompts we send to
// the AI, so prompt builders pass `includeContributors: false`.
export function serializeToMd(workstream, projectName, lastUpdatedBy = '', contributions = [], { includeSourceTags = false, includeContributors = true } = {}) {
  const now = new Date().toISOString().split('T')[0];
  const byLine = lastUpdatedBy ? ` · Source: ${lastUpdatedBy} contribution` : '';
  const header = `# Project Context — ${projectName}\n*Last updated: ${now}${byLine}*\n\n## Why / What / How\n\n`;

  if (!workstream.whys || workstream.whys.length === 0) {
    return header + '*No context yet. Run `teamctx contribute` to add the first contribution.*\n';
  }

  const contributionsById = new Map(contributions.map(c => [c.id, c]));
  const tagFor = includeSourceTags ? sourceTag : () => '';

  const tree = workstream.whys.map(why => {
    let out = `- **Why:** ${why.text}${decisionMarker(why, contributionsById)}${tagFor(why)}\n`;
    (why.whats || []).forEach(what => {
      out += `  - **What:** ${what.text}${decisionMarker(what, contributionsById)}${tagFor(what)}\n`;
      (what.hows || []).forEach(how => {
        out += `    - **How:** ${how.text}${decisionMarker(how, contributionsById)}${tagFor(how)}\n`;
      });
    });
    return out;
  }).join('');

  if (includeSourceTags || !includeContributors) return header + tree;
  const contributorsSection = formatContributorsSection(collectContributorCounts(workstream, contributions));
  return header + tree + (contributorsSection ? `\n${contributorsSection}` : '');
}

/**
 * `intent` and `avoid` are forwarded to the distiller — see proposeDiff. They
 * default to the plain contribution behaviour, so existing callers are
 * unaffected.
 */
export async function updateShared(workstream, contribution, config, { intent, avoid } = {}) {
  const { summary, operations } = await proposeDiff({
    workstream,
    contribution: contribution.text,
    source: contribution.author,
    model: config.model,
    config,
    intent,
    avoid,
  });
  const updated = applyOps(workstream, operations, contribution.id);
  return { workstream: updated, summary, operations };
}

export async function generateRoleFile(workstream, role, projectName, config, contributions = []) {
  const tree = serializeToMd(workstream, projectName, '', contributions, { includeContributors: false });
  const now = new Date().toISOString().split('T')[0];

  const prompt = [
    `Generate a role-specific context file for a team member.`,
    `Project: ${projectName}  Date: ${now}`,
    ``,
    `Full project context (Why/What/How tree):`,
    tree,
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
    `## Your Why / What / How`,
    `[filter and reframe the project tree for this role — same facts, different perspective]`,
    `[IMPORTANT: preserve any inline "*[decision — author, date, via source]*" markers verbatim on the same line as the statement they annotate. They mark human decisions and must survive the rewrite.]`,
    ``,
    `## Open Decisions (Yours to Make)`,
    `[items where this role is the decision owner — write "None currently." if none]`,
    ``,
    `## How to Use This File`,
    `Paste into your CLAUDE.md, or use as system context in ChatGPT / Gemini.`,
    `Starter prompt: "Based on my context, help me [describe what you're working on]."`,
    ``,
    `Return ONLY the markdown content.`,
  ].filter(Boolean).join('\n');

  return callClaude({ prompt, model: config.model, config });
}

export async function compileTaskPrompt({ task, workstream, role, contributions, config }) {
  const projectName = config?.project || workstream?.name || 'project';
  const tree = serializeToMd(workstream, projectName, '', contributions, { includeContributors: false });
  const now = new Date().toISOString().split('T')[0];
  const roleLine = role ? `Framed for role: ${role.name} — ${role.responsibilities || ''}` : 'No role filter — write for a general team member.';
  const decisionsList = (contributions || [])
    .filter(c => c.tagged === 'decision' && (c.workstream || 'main') === (task.workstream || 'main'))
    .slice(-8)
    .map(c => `- ${c.text} — ${c.author}, ${(c.ts || '').slice(0, 10)}, via ${c.source || 'cli'}`)
    .join('\n') || '(none yet)';

  const prompt = [
    `Generate a focused, AI-ready prompt file for ONE specific task.`,
    `Project: ${projectName}   Date: ${now}`,
    ``,
    `Task title: ${task.title}`,
    `Task id: ${task.id}   Owner: ${task.owner || '(unassigned)'}   Workstream: ${task.workstream || 'main'}`,
    roleLine,
    ``,
    `Full workstream context (Why/What/How tree — pick only what's relevant to THIS task):`,
    tree,
    ``,
    `Recent decisions on this workstream (may or may not be relevant to the task):`,
    decisionsList,
    ``,
    `Generate a markdown file with EXACTLY these sections:`,
    ``,
    `# Task: ${task.title}`,
    ``,
    `**Owner:** ${task.owner || '(unassigned)'} · **Workstream:** ${task.workstream || 'main'} · **Status:** ${task.status}`,
    `**Created:** ${task.createdAt || '-'} · **Compiled:** ${now}`,
    ``,
    `## Relevant context`,
    `[Pull ONLY the Whys / Whats / Hows that bear on this task. Skip everything else.]`,
    `[IMPORTANT: preserve any inline "*[decision — author, date, via source]*" markers verbatim.]`,
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

export async function generateReflection(workstream, contributions, config) {
  const tree = serializeToMd(workstream, workstream.name, '', contributions, { includeContributors: false });
  const recent = contributions.slice(-20).map(c => `- ${c.author}: "${c.text}"`).join('\n') || '(none yet)';
  const system = 'You are improving a team context record. Output STRICT JSON only — no markdown fences.';

  const prompt = [
    `Review this project Why/What/How context and recent contributions. Return an improved version.`,
    ``,
    `Current context:`,
    tree,
    ``,
    `Recent contributions (${Math.min(20, contributions.length)} most recent):`,
    recent,
    ``,
    `Return updated workstream JSON with this exact shape:`,
    JSON.stringify({ name: workstream.name, whys: workstream.whys }, null, 2),
    ``,
    `Improvements: remove stale items, sharpen vague Whys (3-8 words), consolidate near-duplicates.`,
    `Preserve ALL existing ids on nodes you keep. JSON only.`,
  ].join('\n');

  return callClaude({ prompt, model: config.model, system, max_tokens: 8192, config });
}

export async function proposeSubworkstreams(workstream, config, roles = []) {
  const whys = workstream.whys || [];
  if (whys.length < 2) {
    return { splits: [], leftover: whys.map(w => w.id), rationale: 'Not enough Why nodes to cluster.' };
  }

  const tree = whys.map(w => {
    const whats = (w.whats || []).map(t => `    - What: ${t.text}`).join('\n');
    return `- id=${w.id} — Why: ${w.text}${whats ? '\n' + whats : ''}`;
  }).join('\n');

  const roleHints = roles.length
    ? roles.map(r => `- ${r.name}: ${r.responsibilities}`).join('\n')
    : '(no roles defined)';

  const system =
    'You cluster distinct threads in a shared team Why/What/How context tree. ' +
    'Two threads are "distinct" when the roles that care about them barely overlap ' +
    '(e.g. product-strategy vs. engineering-implementation). Output STRICT JSON only.';

  const prompt = [
    `Project: ${config.project || workstream.name || 'project'}`,
    '',
    'Current workstream Why nodes (id + text, optional Whats for context):',
    tree,
    '',
    'Roles on this team (their responsibilities are hints for what natural clusters look like):',
    roleHints,
    '',
    'Return STRICT JSON with this exact shape:',
    `{
  "splits": [
    { "name": "Short 2-4 word name", "rationale": "one-sentence why these belong together", "whyIds": ["<id>", "<id>"] }
  ],
  "leftover": ["<why id that fits neither cluster>"]
}`,
    '',
    'Rules:',
    '- Propose 0-4 splits. 0 is valid — output empty splits if no clean split exists.',
    '- whyIds MUST be disjoint across splits AND leftover; every Why id appears at most once.',
    '- Only use ids that exist in the tree above.',
    '- A single cluster with all whys is NOT a useful split — omit it.',
    '- Names are 2-4 words, capitalized (e.g. "Product Strategy", "Tech Migration").',
    'JSON only, no markdown fences.',
  ].join('\n');

  const raw = await callClaude({ prompt, model: config.model, system });
  const parsed = extractJson(raw);
  return normalizeSubworkstreamProposal(parsed, whys);
}

export function normalizeSubworkstreamProposal(parsed, whys) {
  const knownIds = new Set(whys.map(w => w.id));
  const seen = new Set();
  const splits = [];
  for (const raw of Array.isArray(parsed.splits) ? parsed.splits : []) {
    const name = String(raw.name || '').trim();
    const rationale = String(raw.rationale || '').trim();
    const whyIds = (Array.isArray(raw.whyIds) ? raw.whyIds : [])
      .filter(id => knownIds.has(id) && !seen.has(id));
    whyIds.forEach(id => seen.add(id));
    if (name && whyIds.length > 0) splits.push({ name, rationale, whyIds });
  }

  const claimed = new Set(splits.flatMap(s => s.whyIds));
  const leftover = whys.map(w => w.id).filter(id => !claimed.has(id));
  return { splits, leftover };
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

export async function answerQuestion({ sharedMd, roleMd, question, config, openTasks, workstream, contributions, audit }) {
  const contribs = contributions || [];
  const useCitedTags = !!workstream;
  const shared = useCitedTags
    ? serializeToMd(workstream, workstream.name || config?.project || 'project', '', contribs, { includeSourceTags: true })
    : sharedMd;
  const tasksMd = (openTasks && openTasks.length)
    ? `## Open Tasks\n\n${openTasks.map(t => `- ${t.id} — ${t.title} (owner: ${t.owner || '?'})`).join('\n')}`
    : '';

  const context = [
    roleMd ? `## Your Role Context\n\n${roleMd}` : '',
    shared ? `## Shared Project Context\n\n${shared}` : '',
    tasksMd,
  ].filter(Boolean).join('\n\n---\n\n');

  const system = [
    'You are a helpful assistant with access to the team\'s project context.',
    'Answer questions based on the context provided. Be concise and specific.',
    'When the context shows an inline "*[decision — author, date, via source]*" marker on a statement, treat that statement as a canonical human decision. If your answer relies on it, cite it inline like "(decision — author, date)". If the context contains conflicting statements and one is a decision, prefer the decision.',
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
