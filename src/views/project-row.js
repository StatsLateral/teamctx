import { isExpired, today } from '../model.js';
import { esc } from './theme.js';

const TYPES = { decision: 'Decision', assumption: 'Assumption', rule: 'Rule', exception: 'Exception', task: 'Task', goal: 'Goal', review: 'Review' };
const SOURCE_LABELS = { cli: 'CLI', mcp: 'MCP', web: 'Web', imported: 'Imported', none: 'No source recorded' };

export const ROW_CSS = `
/* One grid for the rows and the header above them, so the headings line up with
   what they name. The source column is wide enough to carry its heading. */
.item,.row-head{display:grid;grid-template-columns:58px 112px minmax(0,1fr) 110px 170px 44px;gap:10px}
.item{
  align-items:start;padding:10px 8px;border:1px solid transparent;border-radius:6px;
  background:none;text-align:left;width:100%;font:inherit;color:inherit;cursor:pointer}
.item:hover{background:var(--paper);border-color:var(--line)}
.item.marked{border-color:var(--accent);background:var(--accent-soft)}
.item .num,.type-label,.row-owner{font-family:var(--font-mono);font-size:11px;color:var(--soft);padding-top:3px;overflow-wrap:anywhere}
.item .text{min-width:0;font-size:14px;line-height:1.45;overflow-wrap:anywhere}
.row-where,.row-link{display:block;color:var(--faint);font-size:11px;margin-top:3px}
.row-state{display:flex;flex-wrap:wrap;gap:4px;align-items:baseline}
.status-chip,.governance-chip{font-size:11px;line-height:1.5;padding:2px 6px;border-radius:6px;
  color:var(--soft);background:var(--grey-soft);overflow-wrap:anywhere}
.warning-chip{color:var(--amber);background:var(--amber-soft)}
.dot{flex-shrink:0;width:10px;height:10px;border-radius:99px;margin-top:6px;background:var(--faint)}
.item .dot{justify-self:center}
.row-head{padding:0 9px 6px;margin-bottom:4px;border-bottom:1px solid var(--line);font-family:var(--font-mono);
  font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
.row-head span:last-child{text-align:center}
.dot.none{background:none}
.dot.cli{background:var(--ink)}
.dot.mcp{background:var(--accent)}
.dot.web{background:var(--grey)}
.dot.imported{background:var(--indigo)}
@media(max-width:1200px){
  /* The row reflows into two lines here, so a one-line header would point at
     the wrong things. */
  .row-head{display:none}
  .item{grid-template-columns:58px 100px minmax(0,1fr) 12px}
  .item .dot{grid-column:4;grid-row:1}
  .row-owner{grid-column:2;grid-row:2}
  .row-state{grid-column:3;grid-row:2}
}
@media(max-width:600px){
  .item{grid-template-columns:50px minmax(0,1fr) 12px;gap:6px}
  .type-label{grid-column:2;grid-row:1}
  .item .text{grid-column:2;grid-row:2}
  .item .dot{grid-column:3;grid-row:1}
  .row-owner{grid-column:2;grid-row:3}
  .row-state{grid-column:2;grid-row:4}
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
 * The row is fixed — key, type, text, owner, status, source — and without
 * headings nobody could tell what each part was. `text` names the third column
 * for the list it sits on: a statement in the context, a task in the tasks.
 */
export function rowHeader({ text = 'Statement' } = {}) {
  return `<div class="row-head" aria-hidden="true"><span>Key</span><span>Type</span><span>${esc(text)}</span>`
    + '<span>Owner</span><span>Status</span>'
    + '<span title="How it arrived: dark CLI, green MCP, grey web, indigo imported">Source</span></div>';
}

/** One row anatomy in every part of the page, including unapproved proposals. */
export function projectRow({ node, type = node.type, contributions = {}, where = '',
  fallbackKey = '—', pending = false, marked = false, id = `i-${node.id}`,
  attributes = '', relation = '', onDay = today(), statusLabel,
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
  <span class="type-label">${esc(TYPES[type])}</span>
  <span class="text">${esc(text || '(no text)')}${relation ? `<span class="row-link">${esc(relation)}</span>` : ''}${where ? `<span class="row-where">${esc(where)}</span>` : ''}</span>
  <span class="row-owner">${esc(owner || '—')}</span>
  <span class="row-state"><span class="status-chip">${esc(status)}</span>${governance(node, type, onDay, pending)}</span>
  <span class="dot ${source}" title="${SOURCE_LABELS[source]}"></span>
</button>`;
}
