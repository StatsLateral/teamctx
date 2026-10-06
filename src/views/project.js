import { shell, navBar, esc } from './theme.js';
import { LABELS, RECORD_TYPES } from '../model.js';
import { projectRow, ROW_CSS, rowHeader } from './project-row.js';
import { workstreamLocation } from './workstream-location.js';
import { EDITABLE_RECORD_FIELDS } from '../ops.js';
import { contradictionLabel } from '../contradictions.js';

/** Read-only project context, work and proposals, using one row layout. */

const CSS = `
/* The header is three short lines, and the tree is what somebody came for:
   whether they manage the project is not news to them, and the space it took
   pushed the columns below where the eye lands. */
.crumb{margin:0 0 .2rem;font-size:.85rem}
/* On the title's own line: standing is worth knowing and not worth a paragraph
   — it told you in a sentence before, and the sentence cost the space above the
   tree. */
.role-chip{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--accent);background:var(--accent-soft);border-radius:99px;padding:3px 9px;vertical-align:middle}
.slug{margin:0 0 1rem}
.layout{display:grid;grid-template-columns:240px 1fr;gap:20px;align-items:start}
.lanes{display:flex;flex-direction:column;gap:6px}
.lane{display:block;text-decoration:none;color:inherit;background:var(--card);
  border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px}
.lane:hover{border-color:var(--accent)}
.lane.on{border-color:var(--accent);background:var(--accent-soft)}
.lane-row{display:flex;align-items:baseline;gap:8px}
.lane-row .name{font-weight:600}
.lane-row .count{margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--faint)}
.lane-team{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.team-chip{font-size:11px;background:var(--grey-soft);color:var(--soft);
  padding:1px 7px;border-radius:99px}
.lane-pick{display:none}

/* Context in a bounded panel or a plain list. */
.tree-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.tree-head .section-title{margin:0}
.toggle{margin-left:auto;display:flex;gap:6px}
.toggle a{font-family:var(--font-mono);font-size:11px;text-decoration:none;color:var(--soft);
  border:1px solid var(--line);border-radius:6px;padding:4px 9px;background:var(--card)}
.toggle a.on{color:var(--ink);border-color:var(--accent)}
/* One reading of the context. There used to be a columns/list toggle; once
   tasks moved to their own list (#127) the two rendered the same rows, so the
   toggle offered a choice that changed nothing. Long context scrolls inside
   its box; on phones the page scrolls instead. */
.list{max-height:calc(100vh - 16rem);overflow-y:auto;padding-right:4px}
.list .item{margin-left:0}
/* Retired records, shown only while reading history. Dimmed so that turning
   history on visibly adds something, rather than mixing them in unnoticed. */
.item.retired{opacity:.6}
.item.retired:hover{opacity:.9}
.inherited{border:1px dashed var(--line);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:10px;
  background:var(--accent-soft)}
.inherited .section-title{margin-bottom:6px}
.empty{color:var(--faint);font-style:italic;font-size:13px;padding:14px;border:1px dashed var(--line);
  border-radius:var(--radius-sm);text-align:center}
/* The task list's heading and its filters share a line. The theme styles every
   select as a full-width form field, which is right on a settings page and
   wrong in a toolbar — so these are put back to the size of what they say. */
.tasks-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:10px}
.tasks-head .section-title{margin:0}
.tasks-head .count{font-family:var(--font-mono);font-size:11px;color:var(--faint)}
.task-filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 0 auto}
.task-filters .pick{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);
  border-radius:99px;background:var(--card);padding:2px 4px 2px 12px;margin:0}
.task-filters .pick:focus-within{border-color:var(--accent)}
.task-filters .pick span{font-family:var(--font-mono);font-size:11px;color:var(--faint);
  text-transform:uppercase;letter-spacing:.06em}
.task-filters select{width:auto;max-width:220px;border:0;background:transparent;font-size:13px;
  padding:4px 6px;color:var(--ink);cursor:pointer;margin:0}
.task-filters select:focus{outline:none}
.task-filters .apply{font-size:12px;font-weight:600;padding:5px 14px;border-radius:99px;
  background:var(--accent);color:#fff;border:1px solid var(--accent)}
.task-filters .apply:hover:not(:disabled){filter:brightness(1.08)}
/* Nothing to apply: the choice is what is already shown. */
.task-filters .apply:disabled{background:var(--grey-soft);color:var(--faint);border-color:var(--line);opacity:1}
/* What history added, said where it was added. */
.history-note{font-size:12px;color:var(--soft);background:var(--grey-soft);border-radius:var(--radius-sm);
  padding:6px 10px;margin:0 0 10px}
.task-filters .clear{font-size:12px;color:var(--soft)}
/* Context and Tasks as tabs over one panel, rather than one long page with the
   tasks somewhere below the context. The active tab is the highlighted one. */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:0 0 14px;scroll-margin-top:12px}
.tabs a{text-decoration:none;color:var(--soft);font-size:14px;font-weight:500;padding:8px 14px;
  border:1px solid transparent;border-bottom:none;border-radius:var(--radius-sm) var(--radius-sm) 0 0;
  margin-bottom:-1px}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-current="page"]{color:var(--ink);background:var(--card);border-color:var(--line);
  box-shadow:inset 0 2px 0 var(--accent)}
.tabs .n{font-family:var(--font-mono);font-size:11px;color:var(--faint);margin-left:6px}
.pager{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;
  font-size:13px;color:var(--soft)}
.pager a{text-decoration:none;border:1px solid var(--line);border-radius:99px;padding:3px 12px;
  background:var(--card);color:var(--ink)}
.pager .off{visibility:hidden}
.proposal{margin-bottom:12px;border:1px solid var(--line);border-radius:6px}

/* The drawer. */
.drawer{position:fixed;top:0;right:0;height:100vh;width:min(520px,100vw);background:var(--card);
  border-left:1px solid var(--line);z-index:40;transform:translateX(100%);transition:transform .25s ease;
  display:flex;flex-direction:column}
.drawer.open{transform:translateX(0)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:16px 20px;border-bottom:1px solid var(--line)}
.drawer-body{padding:20px;overflow-y:auto}
.drawer-body .statement{font-family:var(--font-display);font-size:18px;margin:0 0 10px;overflow-wrap:anywhere}
/* What the button is about to put on the clipboard, shut by default: it is long,
   and the drawer is for reading the statement, not the instructions. */
.peek{margin:1rem 0}
.peek summary{cursor:pointer;color:var(--accent);font-size:.85rem}
.peek pre{margin:.6rem 0 0;padding:.7rem .8rem;background:var(--paper);border:1px solid var(--line);
  border-radius:var(--radius-sm);font-family:var(--font-mono);font-size:12px;line-height:1.55;
  white-space:pre-wrap;overflow-wrap:anywhere;color:var(--soft)}
.backdrop{display:none;position:fixed;inset:0;background:rgba(26,28,26,.35);z-index:39}
.backdrop.on{display:block}
.note{background:var(--amber-soft);color:var(--amber);padding:.5rem .7rem;border-radius:var(--radius-sm);
  margin-bottom:1rem;font-size:.9rem}

@media(max-width:760px){
  .layout{grid-template-columns:1fr}
  .lanes{display:none}
  .lane-pick{display:block}
  /* On a phone the window is the scroller; a box inside a box is a trap. */
  .list{max-height:none}
  .task-filters{margin-left:0}
}`;

/**
 * Everything the page does after it loads, which is not much on purpose.
 *
 * Opening a drawer, copying a prompt, and finding whatever a link pointed at.
 * The filters and the history link are answered by the server, so they work
 * with JavaScript off — and so does the whole page, minus the drawer.
 */
const SCRIPT = `
(function () {
  var drawer = document.getElementById('drawer');
  var backdrop = document.getElementById('backdrop');
  function open(el) {
    document.getElementById('d-text').textContent = el.dataset.text;
    document.getElementById('d-kind').textContent = el.dataset.kind;
    document.getElementById('d-summary').textContent = el.dataset.summary || 'No summary recorded.';
    document.getElementById('d-who').textContent = el.dataset.who || 'Nobody recorded.';
    document.getElementById('copy').dataset.prompt = el.dataset.prompt;
    document.getElementById('d-prompt').textContent = el.dataset.prompt;
    drawer.classList.add('open'); backdrop.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    document.getElementById('d-close').focus();
  }
  function close() {
    drawer.classList.remove('open'); backdrop.classList.remove('on');
    drawer.setAttribute('aria-hidden', 'true');
  }
  document.querySelectorAll('.item').forEach(function (el) {
    el.addEventListener('click', function () { open(el); });
  });
  backdrop.addEventListener('click', close);
  document.getElementById('d-close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  document.getElementById('copy').addEventListener('click', function () {
    var b = this;
    var back = function () { b.textContent = 'Copy a prompt for your assistant'; };
    // The clipboard API does not exist on a plain-http deployment, and the
    // failure is silent unless it is caught: the button appears to do nothing.
    if (!navigator.clipboard) {
      b.textContent = 'Select the text above to copy it'; setTimeout(back, 2500); return;
    }
    navigator.clipboard.writeText(b.dataset.prompt).then(function () {
      b.textContent = 'Copied'; setTimeout(back, 1500);
    }, function () {
      b.textContent = 'Could not copy'; setTimeout(back, 2500);
    });
  });
  // Shared rows carry the text and prompt for their drawer.
  var statement = document.querySelector('.item.marked[data-prompt]');
  var row = document.querySelector('.marked');
  if (row) row.scrollIntoView({ block: 'center' });
  if (statement) open(statement);
  // With JavaScript the picker moves on choosing; without it, the form's own
  // button does the same thing — the small screen is not a worse place to read.
  var pick = document.getElementById('lane-pick');
  if (pick) pick.addEventListener('change', function () { this.form.submit(); });
  // The Filter button is live only when the choice differs from what is shown.
  // Without JavaScript it simply stays live, so filtering still works.
  var filters = document.querySelector('.task-filters');
  if (filters) {
    var apply = filters.querySelector('.apply');
    var selects = filters.querySelectorAll('select');
    var shown = Array.prototype.map.call(selects, function (s) { return s.value; }).join('|');
    var sync = function () {
      apply.disabled = Array.prototype.map.call(selects, function (s) { return s.value; }).join('|') === shown;
    };
    Array.prototype.forEach.call(selects, function (s) { s.addEventListener('change', sync); });
    sync();
  }
}());`;

/**
 * Context rows, with each exception after its rule. Expired active exceptions
 * stay visible with warnings. Retired records appear only when reading history.
 */
const numbering = (tree, history = false) => {
  // Only the known types: a type read from the repository is somebody else's
  // text, and it ends up in markup.
  const active = (tree?.records || []).filter(r => RECORD_TYPES.includes(r.type) && (history || r.status === 'active'));
  const rows = [];
  let k = 0;
  for (const r of active.filter(x => x.type !== 'exception')) {
    rows.push({ node: r, tier: r.type, n: `${++k}` });
    if (r.type !== 'rule') continue;
    for (const e of active.filter(x => x.type === 'exception' && x.links?.bends === r.id)) {
      rows.push({ node: e, tier: 'exception', n: `${k}a`, parent: r });
    }
  }
  for (const e of active.filter(x => x.type === 'exception' && !rows.some(row => row.node.id === x.id))) {
    rows.push({ node: e, tier: 'exception', n: `${++k}` });
  }
  if (tree?.goal?.text) rows.unshift({ node: { ...tree.goal, id: 'goal' }, tier: 'goal', n: '—' });
  return rows;
};

/** Everybody whose contribution touched a statement, by name. */
const whoTouched = (node, contributions) => [...new Set(
  (node.sourceContributionIds || []).map(id => contributions[id]?.author).filter(Boolean),
)];

/**
 * What to paste into a fresh chat.
 *
 * Four versions of this have been wrong, each in a smaller way than the last.
 * The one before this said the right things in the wrong voice: it opened with
 * "Using teamctx", numbered its checks ahead of the question, and named the
 * statement's ancestors "the What" and "the Why". What came back was written in
 * those words — headings, field names, a walk back up the tree — to somebody who
 * had asked about one line on a page and does not care how it is stored.
 *
 * So the question comes first, in the words the person would use out loud, and
 * everything the assistant has to do is below it under a heading addressed to
 * the assistant. The checks are unchanged; they are just no longer the first
 * thing anybody reads.
 *
 * It says what to talk about and nothing about how to lay it out. An earlier
 * draft banned headings and bullet lists, which is the wrong lever: the problem
 * was never the shape of the answer but its subject — an assistant explaining
 * the data model instead of the work — and telling a model how to format itself
 * costs it the formatting it would have chosen well.
 */
function promptFor({ node, tier, where, isProject, owner, repo, link, parent, pending }) {
  const place = isProject
    ? "the project's own context (not one part of the work)"
    : `the part of the work called "${where}"`;

  // Where it hangs, said in plain English. The lineage has to be here — an
  // assistant left to find the parents reads the whole project, and then answers
  // with the whole project — but labelling them by tier taught it to answer in
  // those labels too. A goal is a goal, whatever the file calls it.
  const lineage = tier === 'exception' && parent
    ? `It is an allowed exception to the rule "${parent.text}".`
    : '';

  const line = (...lines) => lines.filter(Boolean).join('\n');

  return [
    `Tell me more about ${node.key ? `${node.key}: ` : ''}"${node.text}".`,
    [lineage,
      'Answer in plain language — I want the context that matters, not a tour of how the project is organised.',
    ].filter(Boolean).join(' '),
    line(
      'Instructions for the AI agent:',
      `- Confirm you are connected to the repository ${owner}/${repo}. get_connect_url returns a URL containing the owner and repo. If it is a different one, stop and tell me, rather than answering from the project you are connected to.`,
      `- Find this, quoted word for word, in ${pending ? 'the pending review queue for ' : ''}${place}: "${node.text}". If it is not there, say so plainly rather than answering about the closest thing you can find.`,
      '- Then tell me about that one thing, the way a colleague would: why it is there, what it requires, and what is still open for it.',
      '- Do not explain how the project stores any of this, do not walk me back up the structure it sits in, and do not name its parts. Where something has not been decided yet, say so and move on.',
      '- Keep to this one thing. Do not summarise the rest of the project, list its other goals or tasks, or report what is open elsewhere, unless I ask.',
      link ? `- The page it came from: ${link}` : '',
    ),
  ].filter(Boolean).join('\n\n');
}

/**
 * The prompt, inside an attribute, with its newlines intact.
 *
 * A raw newline in an attribute value survives parsing, but it also breaks the
 * generated HTML across lines for no reason. `&#10;` keeps the markup on one
 * line and decodes back to the newline the clipboard needs.
 */
const escAttr = (v) => esc(v).replace(/\n/g, '&#10;');

function itemButton({ row, contributions, where, marked, isProject, owner, repo, wsId, origin, pending = false, id, linkId = row.node.id, warnings = [] }) {
  const { node, tier, n, parent } = row;
  const prompt = promptFor({
    node: { ...node, text: tier === 'task' ? node.title : node.text }, tier, where, isProject, owner, repo, parent, pending,
    link: origin ? `${origin}/project/${owner}/${repo}?${new URLSearchParams({
      ...(isProject ? {} : { ws: wsId }), ...(linkId ? { item: linkId } : {}),
    })}` : null,
  });
  const who = pending && node.author ? [node.author] : whoTouched(node, contributions);
  return projectRow({ node, type: tier, contributions, where, fallbackKey: n, marked, pending, warnings,
    id: id || `${tier === 'task' ? 't' : 'i'}-${node.id}`,
    relation: parent ? `↳ bends ${parent.key || (pending ? 'the proposed rule' : 'the rule above')}` : '',
    attributes: ` data-text="${esc(tier === 'task' ? node.title : node.text)}" data-kind="${esc(`${tier === 'task' ? 'Task' : (LABELS[tier] || tier).replace(/:$/, '')} ${node.key || (pending ? 'Pending' : n)}`)}"
  data-summary="${esc(node.detail || node.summary || '')}" data-who="${esc(who.join(', '))}"
  data-prompt="${escAttr(prompt)}"` });
}

const list = ({ rows, contributions, where, project, item, isProject, owner, repo, wsId, origin }) => `<div class="list">
  ${rows.map(row => itemButton({
    row, contributions, where, project, isProject, owner, repo, wsId, origin, marked: row.node.id === item,
  })).join('')}
</div>`;


function queueRows({ q, view, item, origin }) {
  const tree = q.workstream ? view.trees[q.workstream] : view.projectTree;
  const operations = Array.isArray(q.operations) ? q.operations : [];
  const render = (node, tier, index) => {
    const bends = node.links?.bends;
    const existingRule = tier === 'exception' && bends
      ? (tree?.records || []).find(r => r.type === 'rule' && r.id === bends) : null;
    const proposedRule = tier === 'exception' && bends && !existingRule
      ? operations.find(op => op?.type === 'addRecord' && op.ref === bends && op.record?.type === 'rule')?.record : null;
    const parent = existingRule || (proposedRule ? { ...proposedRule, key: null } : null);
    return itemButton({
      row: { node: { ...node, source: q.source, author: q.author }, tier, n: '—', parent }, contributions: view.contributions,
      where: q.where, isProject: !q.workstream, wsId: q.workstream,
      owner: view.owner, repo: view.repo, origin, pending: true,
      id: `proposal-${q.id}-${index}`, linkId: q.id,
      warnings: (q.contradictions || []).filter(c => c.operationIndex === index).map(contradictionLabel),
    });
  };
  const proposals = operations.map((op, i) => {
    if (!op || typeof op !== 'object') return '';
    // Keys on queued additions have not been allocated. Displaying the page
    // must never imply that a proposed key has been reserved.
    if (op.type === 'addRecord') {
      if (!RECORD_TYPES.includes(op.record?.type)) return '';
      return render({ ...op.record, key: null }, op.record.type, i);
    }
    if (op.type === 'addTask') return render({ title: op.title, owner: op.owner }, 'task', i);
    if (op.type === 'setGoal') return render({ text: op.text }, 'goal', i);
    const record = (tree?.records || []).find(r => r.id === op.id);
    if (record && op.type === 'editRecord') {
      // Approval permits only these fields and merges links rather than
      // replacing them. The preview must describe the same change.
      const changes = Object.fromEntries(Object.entries(op.changes || {}).filter(([key]) => EDITABLE_RECORD_FIELDS.includes(key)));
      const next = { ...record, ...changes };
      if (changes.links) next.links = { ...record.links, ...changes.links };
      return render(next, record.type, i);
    }
    if (record && op.type === 'setRecordStatus') {
      return render({ ...record, status: op.status }, record.type, i);
    }
    const task = (tree?.tasks || []).find(t => t.id === op.id);
    if (task && ['editTask', 'removeTask'].includes(op.type)) {
      return render({ ...task, title: op.title || task.title, status: op.type === 'removeTask' ? 'Removing' : task.status }, 'task', i);
    }
    return '';
  }).join('');
  return `<div class="proposal">${itemButton({
    row: { node: { id: q.id, text: q.summary || '(no summary)', owner: q.author, author: q.author, source: q.source }, tier: 'review', n: '—' },
    contributions: view.contributions, where: q.where, isProject: !q.workstream, wsId: q.workstream,
    owner: view.owner, repo: view.repo, origin, pending: true, id: `r-${q.id}`, marked: q.id === item,
    warnings: (q.contradictions || []).map(contradictionLabel),
  })}${proposals}</div>`;
}

/** How many rows one page of a list shows. */
export const PAGE_SIZE = 20;

/**
 * Split rows into pages without separating an exception from its rule.
 *
 * An exception reads as a contradiction without the rule it bends, so it stays
 * on the page its rule is on even when that page runs one or two over.
 */
export function paginate(rows, size = PAGE_SIZE) {
  const pages = [];
  for (const row of rows) {
    const last = pages[pages.length - 1];
    const keepWithRule = row.tier === 'exception' && row.parent && last;
    if (!last || (last.length >= size && !keepWithRule)) pages.push([row]);
    else last.push(row);
  }
  return pages.length ? pages : [[]];
}

/** The page to show: the one holding what a link points at, else the one asked for. */
function pageFor(pages, asked, item, idOf = r => r.node?.id) {
  const holding = item ? pages.findIndex(p => p.some(r => idOf(r) === item)) : -1;
  if (holding >= 0) return holding + 1;
  return Math.min(Math.max(1, asked || 1), pages.length);
}

export const projectPage = ({ user, view, selected, item = null, note = null, origin = null, filters = {}, history = false, tab = null, page = 1, inheritedPage: askedInherited = 1 }) => {
  const isProject = selected === null;
  const tree = isProject ? view.projectTree : view.trees[selected];
  const where = workstreamLocation(view.workstreams, selected, view.project);
  // A deep link to history must remain useful without changing the stored record.
  history ||= [view.projectTree, tree].some(t => (t?.records || []).some(r => r.id === item && r.status !== 'active'));
  const rows = numbering(tree, history);
  // How much history there is to show, here and in what this part inherits.
  // The link said "Show history" on a project with none, and turning it on then
  // changed nothing — which reads as a broken button. It is offered only when it
  // will add something, and says how much.
  const retired = [tree, isProject ? null : view.projectTree]
    .flatMap(t => (t?.records || []).filter(r => RECORD_TYPES.includes(r.type) && r.status !== 'active')).length;
  const allTasks = [...view.tasks.open, ...view.tasks.done];
  const owners = [...new Set(allTasks.map(t => t.owner).filter(Boolean))].sort();
  const workstreamValues = ['@all', '@project', ...view.workstreams.map(w => w.id)];
  let taskWs = workstreamValues.includes(filters.workstream) ? filters.workstream : selected || '@all';
  let taskOwner = ['@all', '@unassigned', ...owners].includes(filters.owner) ? filters.owner : '@all';
  const linkedTask = allTasks.find(t => t.id === item);
  if (linkedTask) {
    if (taskWs !== '@all' && taskWs !== (linkedTask.workstream || '@project')) taskWs = linkedTask.workstream || '@project';
    if (taskOwner !== '@all' && taskOwner !== (linkedTask.owner || '@unassigned')) taskOwner = '@all';
  }
  const tasks = allTasks.filter(t => (t.status === 'open' || t.id === item)
    && (taskWs === '@all' || (t.workstream || '@project') === taskWs)
    && (taskOwner === '@all' || (t.owner || '@unassigned') === taskOwner));
  const base = `/project/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}`;
  // A link to a task opens the Tasks tab, a link to a record the Context tab;
  // otherwise the tab asked for, and Context by default.
  // A link carrying task filters is about tasks too, so an old filtered link
  // still lands on the list it filtered.
  const filtering = filters.workstream !== undefined || filters.owner !== undefined;
  // The review queue is the manager's, so its tab exists only for them.
  const reviewing = Array.isArray(view.pending);
  const linkedReview = reviewing && item && view.pending.some(q => q.id === item);
  const active = linkedTask ? 'tasks'
    : (item && rows.some(r => r.node.id === item)) ? 'context'
      : linkedReview ? 'review'
        : tab === 'review' && reviewing ? 'review'
          : tab === 'tasks' || (tab !== 'context' && filtering) ? 'tasks' : 'context';
  const onTasks = active === 'tasks';
  // Every link and form in the panel lands back on the panel, not the top of
  // the page — a filter or a page turn reloads, and the reader was down here.
  const panelHref = (params) => {
    const q = new URLSearchParams();
    if (selected) q.set('ws', selected);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    return `${base}${q.toString() ? `?${q}` : ''}#panel`;
  };
  const taskParams = { tab: 'tasks', taskWs: taskWs !== (selected || '@all') ? taskWs : '', taskOwner: taskOwner !== '@all' ? taskOwner : '' };
  const laneHref = (ws) => `${base}?${new URLSearchParams({ ...(ws === null ? {} : { ws }), ...(onTasks ? { tab: 'tasks' } : {}) }).toString()}`;

  // In a workstream there are two context tables — the project's, inherited,
  // and this part's own — and each pages on its own: `page` for this part,
  // `ipage` for the inherited one. Each pager keeps the other's place.
  const inheritedRows = isProject ? [] : numbering(view.projectTree, history);
  const inheritedPages = paginate(inheritedRows);
  const inheritedAt = onTasks ? 1 : pageFor(inheritedPages, askedInherited, item);
  const contextPages = paginate(rows);
  const contextPage = onTasks ? 1 : pageFor(contextPages, page, item);
  const contextParams = {
    history: history ? '1' : '',
    page: contextPage > 1 ? contextPage : '',
    ipage: inheritedAt > 1 ? inheritedAt : '',
  };
  const taskPages = paginate(tasks.map(t => ({ node: t })));
  const taskPage = onTasks ? pageFor(taskPages, page, item) : 1;
  // `key` is which page parameter this pager turns; everything else in `params`
  // is carried as it is, so turning one table's page leaves the other's alone.
  // The queue pages by proposal rather than by row: one proposal can carry
  // several changes, and splitting it across pages would hide part of what is
  // being approved.
  const reviewPages = reviewing ? paginate(view.pending.map(q => ({ node: q })), 10) : [[]];
  const reviewPage = active === 'review' ? pageFor(reviewPages, page, item) : 1;
  const pager = (pages, at, params, key = 'page') => (pages.length < 2 ? '' : `<nav class="pager" aria-label="Pages">
      <a class="${at > 1 ? '' : 'off'}" href="${esc(panelHref({ ...params, [key]: at - 1 > 1 ? at - 1 : '' }))}">← Previous</a>
      <span>Page ${at} of ${pages.length}</span>
      <a class="${at < pages.length ? '' : 'off'}" href="${esc(panelHref({ ...params, [key]: at + 1 }))}">Next →</a>
    </nav>`);

  // The project's goal and its active records sit above a workstream's, the way
  // teamctx composes context: inherited, not owned, and said so.
  const inherited = inheritedRows.length
    ? `<div class="inherited">
      <div class="section-title">Project context — inherited</div>
      ${rowHeader()}
      ${inheritedPages[inheritedAt - 1].map(row => itemButton({ row, contributions: view.contributions, where: view.project,
        isProject: true, owner: view.owner, repo: view.repo, origin, marked: row.node.id === item })).join('')}
      ${pager(inheritedPages, inheritedAt, contextParams, 'ipage')}
    </div>`
    : '';

  const lane = (id, name, members, count, on) => `<a class="lane${on ? ' on' : ''}" href="${laneHref(id)}">
    <div class="lane-row"><span class="name">${esc(name)}</span><span class="count">${count}</span></div>
    ${members.length ? `<div class="lane-team">${members.map(m => `<span class="team-chip">${esc(m)}</span>`).join('')}</div>` : ''}
  </a>`;

  return shell(view.project || `${view.owner}/${view.repo}`, `
${navBar({ user, current: '/projects' })}
<p class="crumb"><a href="/projects">← All projects</a></p>
<h1>${esc(view.project || `${view.owner}/${view.repo}`)}${view.isManager
    ? ' <span class="role-chip">Manager</span>'
    : ''}</h1>
<p class="muted slug"><code>${esc(view.owner)}/${esc(view.repo)}</code></p>
${note ? `<p class="note">${esc(note)}</p>` : ''}

<div class="layout">
  <aside>
    <div class="section-title">The work</div>
    <div class="lanes">
      ${lane(null, view.project || 'Project', [], (view.projectTree?.records || []).filter(r => RECORD_TYPES.includes(r.type) && r.status === 'active').length, isProject)}
      ${view.workstreams.map(w => lane(w.id, w.name, w.members, (view.trees[w.id]?.records || []).filter(r => RECORD_TYPES.includes(r.type) && r.status === 'active').length, w.id === selected)).join('')}
    </div>
<form class="lane-pick" method="GET" action="${base}">
      <select id="lane-pick" name="ws">
        <option value=""${isProject ? ' selected' : ''}>${esc(view.project || 'Project')}</option>
        ${view.workstreams.map(w => `<option value="${esc(w.id)}"${w.id === selected ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select>
      <button type="submit">Open</button>
    </form>
  </aside>

  <main>
    <nav class="tabs" id="panel" aria-label="What to show">
      <a href="${esc(panelHref({ history: history ? '1' : '' }))}"${active === 'context' ? ' aria-current="page"' : ''}>Context<span class="n">${rows.length}</span></a>
      <a href="${esc(panelHref(taskParams))}"${onTasks ? ' aria-current="page"' : ''}>Tasks<span class="n">${tasks.length} open</span></a>
      ${reviewing ? `<a href="${esc(panelHref({ tab: 'review' }))}"${active === 'review' ? ' aria-current="page"' : ''}>Waiting on you<span class="n">${view.pending.length}</span></a>` : ''}
    </nav>
    ${active === 'review' ? `<section>
      <div class="tree-head"><span class="section-title">Waiting on you</span></div>
      ${view.pending.length ? `${rowHeader({ text: 'Proposal' })}
      ${reviewPages[reviewPage - 1].map(({ node: q }) => queueRows({ q, view, item, origin })).join('')}
      ${pager(reviewPages, reviewPage, { tab: 'review' })}` : '<p class="muted">Nothing is waiting for review.</p>'}
    </section>` : onTasks ? `<section>
      <div class="tasks-head">
        <span class="section-title">Tasks${taskWs === '@all' ? '' : ` — ${esc(taskWs === '@project' ? (view.project || 'Overall project') : workstreamLocation(view.workstreams, taskWs))}`}</span>
        <form class="task-filters" method="GET" action="${esc(`${base}#panel`)}">
          ${selected ? `<input type="hidden" name="ws" value="${esc(selected)}">` : ''}
          <input type="hidden" name="tab" value="tasks">
          <label class="pick"><span>Where</span><select name="taskWs" aria-label="Which part of the work">
            ${[['@all', 'All work'], ['@project', view.project || 'Overall project'], ...view.workstreams.map(w => [w.id, workstreamLocation(view.workstreams, w.id)])]
    .map(([value, label]) => `<option value="${esc(value)}"${value === taskWs ? ' selected' : ''}>${esc(label)}</option>`).join('')}
          </select></label>
          <label class="pick"><span>Owner</span><select name="taskOwner" aria-label="Whose tasks">
            ${[['@all', 'Everyone'], ['@unassigned', 'Unassigned'], ...owners.map(o => [o, o])].map(([value, label]) => `<option value="${esc(value)}"${value === taskOwner ? ' selected' : ''}>${esc(label)}</option>`).join('')}
          </select></label>
          <button type="submit" class="apply">Filter</button>
          ${taskWs !== (selected || '@all') || taskOwner !== '@all'
    ? `<a class="clear" href="${esc(panelHref({ tab: 'tasks' }))}">Clear</a>` : ''}
        </form>
      </div>
      ${tasks.length ? rowHeader({ text: 'Task' }) : ''}
      <div class="task-list">${tasks.length ? taskPages[taskPage - 1].map(({ node: t }) => itemButton({
        row: { node: t, tier: 'task', n: '—' }, contributions: view.contributions, where: t.where,
        isProject: !t.workstream, wsId: t.workstream, owner: view.owner, repo: view.repo,
        origin, marked: t.id === item,
      })).join('') : '<p class="muted">No open tasks match these filters.</p>'}</div>
      ${pager(taskPages, taskPage, taskParams)}
      ${view.tasks.done.length ? `<p class="muted">${view.tasks.done.length}
        task${view.tasks.done.length === 1 ? '' : 's'} already done.</p>` : ''}
    </section>` : `<section>
    <div class="tree-head">
      <span class="section-title">${esc(where)}</span>
      ${retired || history ? `<span class="toggle">
        <a href="${esc(panelHref({ history: history ? '' : '1', item: history ? '' : item }))}" class="${history ? 'on' : ''}">${history ? 'Hide history' : `Show history (${retired})`}</a>
      </span>` : ''}
    </div>
    ${history && retired ? `<p class="history-note">Showing ${retired} retired record${retired === 1 ? '' : 's'} — replaced, broken or closed — dimmed, with their status. Current context is not dimmed.</p>` : ''}
    ${inherited}
    ${rows.length
    ? `${rowHeader()}${list({
      rows: contextPages[contextPage - 1],
      contributions: view.contributions,
      where,
      project: view.project || view.repo,
      item,
      isProject,
      owner: view.owner,
      repo: view.repo,
      wsId: selected,
      origin,
    })}${pager(contextPages, contextPage, contextParams)}`
    : '<p class="empty">Nothing written here yet — ask your assistant to add context.</p>'}
    </section>`}
  </main>
</div>

<div class="backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <div class="drawer-head">
    <span class="section-title" id="d-kind" style="margin:0"></span>
    <button class="ghost" id="d-close" aria-label="Close">✕</button>
  </div>
  <div class="drawer-body">
    <p class="statement" id="d-text"></p>
    <div class="section-title">Summary</div>
    <p id="d-summary"></p>
    <div class="section-title">Who wrote it</div>
    <p id="d-who"></p>
    <details class="peek">
      <summary>See the prompt first</summary>
      <pre id="d-prompt"></pre>
    </details>
    <button class="primary" id="copy">Copy a prompt for your assistant</button>
  </div>
</aside>`, { wide: true, extraCss: `${CSS}\n${ROW_CSS}`, script: SCRIPT });
};
