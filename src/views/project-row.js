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
/* One grid for the rows and the header above them, so the headings line up with
   what they name: key, type, text, owner, status, notes, source. */
.item,.row-head{display:grid;grid-template-columns:58px 104px minmax(0,1fr) 104px 92px 170px 72px;gap:10px}
.item{
  align-items:start;padding:10px 8px;border:1px solid transparent;border-radius:6px;
  background:none;text-align:left;width:100%;font:inherit;color:inherit;cursor:pointer}
.item:hover{background:var(--paper);border-color:var(--line)}
.item.marked{border-color:var(--accent);background:var(--accent-soft)}
.item .num,.type-label,.row-owner,.row-source{font-family:var(--font-mono);font-size:11px;color:var(--soft);padding-top:3px;overflow-wrap:anywhere}
.item .text{min-width:0;font-size:14px;line-height:1.45;overflow-wrap:anywhere}
.row-where,.row-link{display:block;color:var(--faint);font-size:11px;margin-top:3px}
.row-state,.row-notes{display:flex;flex-wrap:wrap;gap:4px;align-items:baseline}
.status-chip,.governance-chip{font-size:11px;line-height:1.5;padding:2px 6px;border-radius:6px;
  color:var(--soft);background:var(--grey-soft);overflow-wrap:anywhere}
.warning-chip{color:var(--amber);background:var(--amber-soft)}
.row-source.src-mcp{color:var(--accent)}
.row-source.src-none{color:var(--faint)}
.row-head{padding:0 9px 6px;margin-bottom:4px;border-bottom:1px solid var(--line);font-family:var(--font-mono);
  font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
@media(max-width:1200px){
  /* The row wraps onto more lines here, so a one-line header would point at the
     wrong things. Each part that moves says what it is instead. */
  .row-head{display:none}
  .item{grid-template-columns:58px 100px minmax(0,1fr) 72px}
  .row-source{grid-column:4;grid-row:1}
  .row-owner{grid-column:2;grid-row:2}
  .row-state{grid-column:3;grid-row:2}
  .row-notes{grid-column:3;grid-row:3}
  .row-owner::before{content:'Owner: '}
  .row-state::before,.row-notes::before{font-family:var(--font-mono);font-size:11px;color:var(--faint)}
  .row-state::before{content:'Status: '}
  .row-notes::before{content:'Notes: '}
  .row-notes:empty{display:none}
}
@media(max-width:600px){
  .item{grid-template-columns:50px minmax(0,1fr) 72px;gap:6px}
  .type-label{grid-column:2;grid-row:1}
  .item .text{grid-column:2;grid-row:2}
  .row-source{grid-column:3;grid-row:1}
  .row-owner{grid-column:2;grid-row:3}
  .row-state{grid-column:2;grid-row:4}
  .row-notes{grid-column:2;grid-row:5}
}`;

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

/**
 * The headings for the row anatomy below, in the same grid.
 *
 * The row is fixed — number, type, text, owner, status, source — and without
 * headings nobody could tell what each part was. `text` names the third column
 * for the list it sits on: a statement in the context, a task in the tasks.
 */
export function rowHeader({ text = 'Statement' } = {}) {
  return `<div class="row-head" aria-hidden="true"><span>No.</span><span>Type</span><span>${esc(text)}</span>`
    + '<span>Owner</span><span>Status</span>'
    + '<span title="Review dates, end dates, and anything that needs a second look">Notes</span>'
    + '<span title="How it was added: by an assistant, the command line, the web, or an import">Source</span></div>';
}

/** One row anatomy in every part of the page, including unapproved proposals. */
export function projectRow({ node, type = node.type, contributions = {}, where = '',
  fallbackKey = '—', pending = false, marked = false, id = `i-${node.id}`,
  attributes = '', relation = '', onDay = today(), statusLabel,
  warnings = [],
}) {
  if (!Object.hasOwn(TYPES, type)) return '';
  const owner = typeof node.owner === 'string' ? node.owner : node.owner?.name;
  // Only a task, or a waiting item as a whole, has a number a person can say. A
  // record has none, and a `key` that turns up on one — in a queued proposal,
  // which is somebody else's file — is not shown as if it were one.
  const number = type === 'task' || type === 'review' ? node.key : null;
  const source = sourceKind(node, contributions);
  const text = type === 'task' ? node.title : node.text;
  const status = statusLabel || (pending ? `Awaiting review${node.status ? ` · ${node.status}` : ''}` : node.status || (type === 'goal' ? 'Current' : 'Active'));
  // Retired records only appear while reading history; dimmed so they read as
  // history. A proposal previews a status, so it is never dimmed.
  const retired = !pending && node.status && node.status !== 'active' && type !== 'task';
  return `<button type="button" class="item tier-${esc(type)}${marked ? ' marked' : ''}${retired ? ' retired' : ''}" id="${esc(id)}"${attributes}>
  <span class="num">${esc(number || (pending ? '—' : fallbackKey))}</span>
  <span class="type-label">${esc(TYPES[type])}</span>
  <span class="text">${esc(text || '(no text)')}${relation ? `<span class="row-link">${esc(relation)}</span>` : ''}${where ? `<span class="row-where">${esc(where)}</span>` : ''}</span>
  <span class="row-owner">${esc(owner || '—')}</span>
  <span class="row-state"><span class="status-chip">${esc(status)}</span></span>
  <span class="row-notes">${governance(node, type, onDay, pending)}${warnings.map(label => `<span class="governance-chip warning-chip">${esc(label)}</span>`).join('')}</span>
  <span class="row-source src-${source}" title="${SOURCE_TITLES[source]}">${SOURCE_LABELS[source]}</span>
</button>`;
}
