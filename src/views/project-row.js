import { isExpired, today } from '../model.js';
import { esc } from './theme.js';

const TYPES = { decision: 'Decision', assumption: 'Assumption', rule: 'Rule', exception: 'Exception', task: 'Task', goal: 'Goal', review: 'Review' };
// How a record arrived, in a word. It was a coloured dot, which only meant
// something to whoever knew the colours — and since nearly everything arrives
// through an assistant, it was a column of identical green dots.
const SOURCE_LABELS = { cli: 'CLI', mcp: 'Assistant', web: 'Web', imported: 'Import', none: '—' };
const SOURCE_TITLES = {
  cli: 'Added from the command line', mcp: 'Added through an AI assistant (MCP)', web: 'Added on the web',
  imported: 'Imported from a document or another tool', none: 'No source recorded',
};

export const ROW_CSS = `
/* A row is its statement. The key sits in a narrow column so the eye can run
   down it; the statement takes the rest of the width; everything else about it —
   type, status, owner, notes, source, where — is a pill underneath. Columns for
   each of those left the statement a sliver in the middle of a wide row, and
   every row grew tall to fit it. */
.item{display:grid;grid-template-columns:52px minmax(0,1fr);gap:4px 10px;align-items:start;
  padding:8px 8px;border:1px solid transparent;border-radius:6px;
  background:none;text-align:left;width:100%;font:inherit;color:inherit;cursor:pointer}
.item:hover{background:var(--paper);border-color:var(--line)}
.item.marked{border-color:var(--accent);background:var(--accent-soft)}
.item .num{grid-row:1 / span 2;font-family:var(--font-mono);font-size:11px;color:var(--soft);padding-top:3px;overflow-wrap:anywhere}
/* Capped at two lines: the whole statement is one click away, in the details. */
.item .text{min-width:0;font-size:14px;line-height:1.45;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.pills{display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0}
.pills > span,.row-state > span,.row-notes > span{font-size:11px;line-height:1.5;padding:1px 7px;border-radius:99px;
  color:var(--soft);background:var(--grey-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.pills > .row-state,.pills > .row-notes{display:contents}
.pills .type-label{font-family:var(--font-mono);color:var(--ink);background:none;border:1px solid var(--line)}
.row-owner::before{content:'Owner · ';color:var(--faint)}
.row-source::before{content:'via ';color:var(--faint)}
.pills .row-source.src-mcp{color:var(--accent)}
.pills .row-source.src-none{display:none}
.pills .row-where,.pills .row-link{background:none;color:var(--faint);padding-left:2px;padding-right:2px}
.pills .warning-chip,.row-notes .warning-chip{color:var(--amber);background:var(--amber-soft)}
/* In the details panel the same pills, uncapped. */
/* A long note wraps here, and a fully rounded pill of several lines is an oval
   its text spills out of; this radius is still round on one line. */
.pills.full > span,.pills.full .row-state > span,.pills.full .row-notes > span{white-space:normal;max-width:none;overflow:visible;
  border-radius:10px;padding:2px 8px}
.pills.full .row-source.src-none{display:inline}
`;

/** The source is the surface the contribution arrived through. */
export function sourceKind(node, contributions = {}) {
  const ids = node.sourceContributionIds || [];
  const source = node.source || contributions[ids[ids.length - 1]]?.source;
  return ['cli', 'mcp', 'web'].includes(source) ? source : source ? 'imported' : 'none';
}

function governance(node, type, onDay, pending) {
  const chips = [];
  const current = node.status ? node.status === 'active' : pending;
  if (type === 'assumption' && node.reviewBy) {
    const overdue = current && node.reviewBy < onDay;
    chips.push([`${overdue ? 'Review overdue' : 'Review by'} ${node.reviewBy}`, overdue]);
  }
  if (type === 'exception' && node.expiresAt) {
    const expired = current && isExpired(node, onDay);
    chips.push([`${expired ? 'Expired' : 'Expires'} ${node.expiresAt}`, expired]);
  }
  if (node.needsReview) chips.push(['Needs review — rests on a broken assumption', true]);
  return chips.map(([label, warning]) => `<span class="governance-chip${warning ? ' warning-chip' : ''}">${esc(label)}</span>`).join('');
}

/** One row anatomy in every part of the page, including unapproved proposals. */
export function projectRow({ node, type = node.type, contributions = {}, where = '',
  fallbackKey = '—', pending = false, marked = false, id = `i-${node.id}`,
  attributes = '', relation = '', onDay = today(), statusLabel,
  warnings = [],
}) {
  if (!Object.hasOwn(TYPES, type)) return '';
  const owner = typeof node.owner === 'string' ? node.owner : node.owner?.name;
  const source = sourceKind(node, contributions);
  const text = type === 'task' ? node.title : node.text;
  const status = statusLabel || (pending ? `Awaiting review${node.status ? ` · ${node.status}` : ''}` : node.status || (type === 'goal' ? 'Current' : 'Active'));
  // Retired records only appear while reading history; dimmed so they read as
  // history. A proposal previews a status, so it is never dimmed.
  const retired = !pending && node.status && node.status !== 'active' && type !== 'task';
  return `<button type="button" class="item tier-${esc(type)}${marked ? ' marked' : ''}${retired ? ' retired' : ''}" id="${esc(id)}"${attributes}>
  <span class="num">${esc(node.key || (pending ? 'Pending' : fallbackKey))}</span>
  <span class="text">${esc(text || '(no text)')}</span>
  <span class="pills">
    <span class="type-label">${esc(TYPES[type])}</span>
    <span class="row-state"><span class="status-chip">${esc(status)}</span></span>
    ${owner ? `<span class="row-owner">${esc(owner)}</span>` : ''}
    <span class="row-notes">${governance(node, type, onDay, pending)}${warnings.map(label => `<span class="governance-chip warning-chip" title="${esc(label)}">${esc(label)}</span>`).join('')}</span>
    ${relation ? `<span class="row-link">${esc(relation)}</span>` : ''}
    ${where ? `<span class="row-where">${esc(where)}</span>` : ''}
    <span class="row-source src-${source}" title="${SOURCE_TITLES[source]}">${SOURCE_LABELS[source]}</span>
  </span>
</button>`;
}
