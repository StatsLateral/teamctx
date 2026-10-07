import { esc } from './theme.js';
import { LABELS, RECORD_TYPES, today } from '../model.js';
import { contradictionLabel, evidenceLabel } from '../contradictions.js';
import { promptFor, escAttr, whoTouched } from './prompt-for.js';
import { workstreamLocation } from './workstream-location.js';

/**
 * What the project page is about: the work, and what is waiting on the manager.
 *
 * One page, no tabs and no filters. The tree on the left says which part of the
 * work to look at (the whole project, or one part and everything inside it); the
 * main column then shows what is waiting, and every part's open tasks under its
 * own heading. Each part is a plain list: a number, what it is, who has it, how
 * many sources sit behind it.
 */

// ---- the tree ---------------------------------------------------------------

/** Every workstream id inside `id`, at any depth, among the parts the reader can see. */
export function insideOf(workstreams, id) {
  const out = [];
  const walk = (parent) => workstreams.filter(w => w.parent === parent).forEach(w => { out.push(w.id); walk(w.id); });
  walk(id);
  return out;
}

/** The ids a selection covers. `null` is the whole project. */
export const covered = (workstreams, selected) => (selected === null
  ? workstreams.map(w => w.id)
  : [selected, ...insideOf(workstreams, selected)]);

const overdue = (r, onDay) => r.status === 'active' && (
  (r.type === 'assumption' && r.reviewBy && r.reviewBy < onDay)
  || (r.type === 'exception' && r.expiresAt && r.expiresAt < onDay));

/**
 * Whether anything at or under a part needs a look: something waiting for the
 * manager, an assumption past its review date, an exception past its end date.
 */
function needsLook({ view, ids, whole, onDay }) {
  const inScope = (ws) => (ws === null ? whole : ids.includes(ws));
  if ((view.pending || []).some(q => inScope(q.workstream ?? null))) return true;
  const trees = [...(whole ? [view.projectTree] : []), ...ids.map(id => view.trees?.[id])];
  return trees.some(t => (t?.records || []).some(r => RECORD_TYPES.includes(r.type) && overdue(r, onDay)));
}

export function treeHtml({ view, selected, base, onDay = today() }) {
  const parts = view.workstreams || [];
  const visible = new Set(parts.map(w => w.id));
  const openIn = (ids) => view.tasks.open.filter(t => ids.includes(t.workstream)).length;
  const href = (id) => (id === null ? base : `${base}?ws=${encodeURIComponent(id)}`);
  const dot = (ids, whole) => (needsLook({ view, ids, whole, onDay }) ? '<span class="dot" title="Something here needs a look"></span>' : '');
  const node = (w) => {
    const ids = covered(parts, w.id);
    const kids = parts.filter(c => c.parent === w.id);
    return `<li><a class="node${w.id === selected ? ' on' : ''}" href="${esc(href(w.id))}"${w.id === selected ? ' aria-current="page"' : ''}>`
      + `<span class="num">${esc(w.number ?? '')}</span><span class="nm">${esc(w.name)}</span>${dot(ids, false)}<span class="cnt">${openIn(ids)}</span></a>`
      + `${kids.length ? `<ul>${kids.map(node).join('')}</ul>` : ''}</li>`;
  };
  // A part whose parent the reader cannot see is a top-level part to them.
  const roots = parts.filter(w => !w.parent || !visible.has(w.parent));
  const all = parts.map(w => w.id);
  return `<ul class="tree"><li><a class="node root${selected === null ? ' on' : ''}" href="${esc(href(null))}"${selected === null ? ' aria-current="page"' : ''}>`
    + `<span class="nm">Overall Project</span>${dot(all, true)}<span class="cnt">${openIn(all)}</span></a>`
    + `${roots.length ? `<ul>${roots.map(node).join('')}</ul>` : ''}</li></ul>`;
}

// ---- the context icon -------------------------------------------------------

/** A small side-panel glyph: the icon that opens a drawer on a level of the project. */
export const PANEL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>';
export const ctxButton = (panel, label) => `<button type="button" class="ctx-open" data-panel="${esc(panel)}" aria-label="${esc(label)}" title="${esc(label)}">${PANEL_ICON}</button>`;

// ---- people -----------------------------------------------------------------

/** A person or an agent, so an agent is visibly one wherever it appears. */
export const whoChip = (name, agents) => {
  if (!name) return '<span class="chip none">Unassigned</span>';
  const agent = (agents || []).some(a => a.name === name);
  return `<span class="chip${agent ? ' agent' : ''}">${agent ? '🤖' : '👤'} ${esc(name)}</span>`;
};

// ---- tasks ------------------------------------------------------------------

const clip = (node) => {
  const n = (node.sourceContributionIds || []).length;
  return n ? `<span class="clip" title="${n} linked source${n === 1 ? '' : 's'}">📎 ${n}</span>` : '<span class="clip"></span>';
};

function taskRow({ t, view, origin, marked }) {
  const where = workstreamLocation(view.workstreams, t.workstream, view.project);
  const prompt = promptFor({
    node: { ...t, text: t.title }, tier: 'task', where, isProject: false, owner: view.owner, repo: view.repo, parent: null, pending: false,
    link: origin ? `${origin}/project/${view.owner}/${view.repo}?${new URLSearchParams({ ws: t.workstream, item: t.id })}` : null,
  });
  const who = whoTouched(t, view.contributions || {});
  return `<button type="button" class="item trow${marked ? ' marked' : ''}${t.status === 'done' ? ' done' : ''}" id="t-${esc(t.id)}"
  data-text="${esc(t.title)}" data-kind="${esc(`Task${t.key ? ` ${t.key}` : ''}`)}" data-summary="" data-who="${esc(who.join(', '))}"
  data-review="" data-ws="${esc(t.workstream || '')}" data-ask="${escAttr(prompt.split('\n\n')[0])}" data-prompt="${escAttr(prompt)}">
  <span class="num">${esc(t.key || '—')}</span><span class="ttl">${esc(t.title)}</span>
  <span class="own">${whoChip(t.owner, view.agents)}</span>${clip(t)}</button>`;
}

// ---- what is waiting --------------------------------------------------------

/** One operation of a proposal, in the words a manager would use. */
export function describeChange(op, tree) {
  const text = (id) => (tree?.records || []).find(r => r.id === id)?.text;
  const task = (id) => (tree?.tasks || []).find(t => t.id === id)?.title;
  switch (op?.type) {
    case 'setGoal': return `Set the goal: ${op.text}`;
    case 'addRecord': return `Add: ${LABELS[op.record?.type] || 'Note:'} ${op.record?.text}`;
    case 'editRecord': return `Reword ${text(op.id) ? `"${text(op.id)}"` : 'a record'}${op.changes?.text ? ` to: ${op.changes.text}` : ''}`;
    case 'setRecordStatus': return `Mark ${text(op.id) ? `"${text(op.id)}"` : 'a record'} as ${op.status}`;
    case 'addEvidence': return evidenceLabel(op);
    case 'addTask': return `Add a task: ${op.title}`;
    case 'editTask': return `Retitle ${task(op.id) ? `"${task(op.id)}"` : 'a task'} to: ${op.title}`;
    case 'removeTask': return `Remove the task ${task(op.id) ? `"${task(op.id)}"` : ''}`.trim();
    default: return null;
  }
}

/** What an approver should look at against what is already approved. */
function checksOf(q) {
  // Somebody else's file: a field that is not a list is treated as empty, never a crash.
  const list = (x) => (Array.isArray(x) ? x : []);
  return [
    ...list(q.contradictions).map(contradictionLabel),
    ...list(q.operations).filter(o => o?.type === 'addEvidence').map(evidenceLabel),
    ...list(q.impact).map(({ text, records } = {}) => (list(records).length
      ? `${records.length} thing${records.length === 1 ? '' : 's'} rest${records.length === 1 ? 's' : ''} on '${text}': ${records.map(r => r.text).join('; ')}`
      : `Nothing on record rests on '${text}'`)),
  ];
}

const EYE = '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const REVIEW = '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="2.5" width="10" height="11.5" rx="1.6"/><path d="M6 2.5V2h4v.5M5.8 8.4l1.6 1.6 3-3.2"/></svg>';

/** How a proposal arrived, as a person would say it. */
const VIA = { mcp: 'through an assistant', cli: 'from the command line', web: 'on the web' };

function waitingItem({ q, view, origin, marked }) {
  const tree = q.workstream ? view.trees?.[q.workstream] : view.projectTree;
  const where = q.workstream ? workstreamLocation(view.workstreams, q.workstream, view.project) : (view.project || 'Overall project');
  const ref = q.number || null;
  const checks = checksOf(q);
  const changes = (Array.isArray(q.operations) ? q.operations : []).map(op => describeChange(op, tree)).filter(Boolean);
  const title = q.summary || changes[0] || '(no summary)';
  const prompt = promptFor({
    node: { id: q.id, text: title }, tier: 'review', where, isProject: !q.workstream, owner: view.owner, repo: view.repo, parent: null, pending: true,
    link: origin ? `${origin}/project/${view.owner}/${view.repo}?${new URLSearchParams({ ...(q.workstream ? { ws: q.workstream } : {}), item: q.id })}` : null,
  });
  const decide = [
    `Tell your assistant: "Approve ${ref || 'this'}"${ref ? '' : ' (name it by what it says)'}, or "Reject ${ref || 'this'}" with a reason.`,
    `From the command line: teamctx review approve ${q.id}   or   teamctx review reject ${q.id}`,
  ];
  const label = ref || title.slice(0, 40);
  const date = q.createdAt ? String(q.createdAt).slice(5, 10) : '';
  return `<div class="q${marked ? ' marked' : ''}" id="r-${esc(q.id)}" data-text="${esc(title)}" data-kind="${esc(`Waiting on you${ref ? ` · ${ref}` : ''}`)}"
  data-summary="${esc(`Proposed by ${q.author || 'someone'}${VIA[q.source] ? ` ${VIA[q.source]}` : ''}${date ? ` on ${date}` : ''}.`)}"
  data-who="${esc(q.author || '')}" data-review="" data-ws="${esc(q.workstream || '')}" data-queue="1"
  data-changes="${esc(JSON.stringify(changes))}" data-checks="${esc(JSON.stringify(checks))}" data-decide="${esc(JSON.stringify(decide))}"
  data-ask="${escAttr(prompt.split('\n\n')[0])}" data-prompt="${escAttr(prompt)}">
  <span class="num">${esc(ref || '—')}</span>
  <span class="what"><button type="button" class="qmain">${esc(title)}</button></span>
  <span class="qicons">
    <button type="button" class="qicon" data-open="view" aria-label="View ${esc(label)}" title="View details">${EYE}</button>
    <button type="button" class="qicon rv" data-open="review" aria-label="Review ${esc(label)}: approve or reject" title="Review: approve or reject">${REVIEW}</button>
  </span>
  <span class="sub">${whoChip(q.author, view.agents)}<span class="where">· ${esc(where)}${date ? ` · ${esc(date)}` : ''}</span>${checks.length ? `<span class="chip warn">⚠ ${checks.length} to check against the record</span>` : ''}</span>
</div>`;
}

// ---- the main column --------------------------------------------------------

/**
 * `{ main, selected }`: the waiting card and one section per part with something
 * to show, for the part selected and everything inside it. A link to a task or a
 * waiting item that is outside the selection widens it to the whole project, so
 * what was pointed at is always on the page.
 */
export function workHtml({ view, selected, item, history, origin, base }) {
  const parts = view.workstreams || [];
  const allTasks = [...view.tasks.open, ...view.tasks.done];
  const pending = Array.isArray(view.pending) ? view.pending : null;
  const target = allTasks.find(t => t.id === item) || (pending || []).find(q => q.id === item);
  if (target && selected !== null && !covered(parts, selected).includes(target.workstream ?? null)) selected = null;

  const ids = covered(parts, selected);
  const whole = selected === null;
  const inScope = (ws) => (ws === null ? whole : ids.includes(ws));
  const waiting = (pending || []).filter(q => inScope(q.workstream ?? null));
  const inbox = waiting.length
    ? `<section class="inbox" aria-labelledby="inbox-h"><h2 id="inbox-h">Waiting on you · ${waiting.length}</h2>${waiting.map(q => waitingItem({ q, view, origin, marked: q.id === item })).join('')}</section>`
    : '';

  const done = allTasks.filter(t => t.status === 'done' && ids.includes(t.workstream));
  const sections = ids.map(id => {
    const w = parts.find(p => p.id === id);
    if (!w) return '';
    const tasks = allTasks.filter(t => t.workstream === id && (t.status === 'open' || history || t.id === item));
    if (!tasks.length) return '';
    // Inside a selected part, its own name; for the parts inside it, where they sit.
    const name = id === selected ? w.name : workstreamLocation(parts, id, view.project);
    return `<section class="wsec" id="ws-${esc(id)}"><h2><span class="wsn">${esc(w.number ?? '')}</span>${esc(name)}`
      + `${ctxButton(`dp-ws-${id}`, `Context for ${name}`)}</h2>`
      + `<div class="trows">${tasks.map(t => taskRow({ t, view, origin, marked: t.id === item })).join('')}</div></section>`;
  }).join('');

  const empty = !parts.length
    ? '<p class="empty">No work yet — ask your assistant to add a workstream, then its tasks.</p>'
    : (!inbox && !sections ? '<p class="empty">Nothing open here.</p>' : '');
  const linkTo = (on) => {
    const query = new URLSearchParams({ ...(selected ? { ws: selected } : {}), ...(on ? { history: '1' } : {}) }).toString();
    return query ? `${base}?${query}` : base;
  };
  const historyLink = done.length || history
    ? `<p class="hist"><a href="${esc(linkTo(!history))}">${history ? 'Hide history' : `Show history (${done.length} done)`}</a></p>` : '';
  return { main: `${inbox}${sections}${empty}${historyLink}`, selected };
}
