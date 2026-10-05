import { shell, navBar, esc } from './theme.js';
import { LABELS, RECORD_TYPES } from '../model.js';
import { projectRow, ROW_CSS } from './project-row.js';
import { workstreamLocation } from './workstream-location.js';
import { EDITABLE_RECORD_FIELDS } from '../ops.js';

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
.columns{display:grid;grid-template-columns:1fr;gap:10px}
/* Long context scrolls inside its panel; on phones the page scrolls instead. */
.col{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);
  display:flex;flex-direction:column;min-width:0;min-height:220px;max-height:calc(100vh - 16rem)}
.col-head{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--soft);font-weight:600;padding:10px 12px 8px;border-bottom:1px solid var(--line)}
.col-body{padding:8px;display:flex;flex-direction:column;gap:3px;overflow-y:auto;flex:1}
/* The same bound for the single-column reading, so the page itself never grows
   past the window and the toggle does not change how far you have to scroll. */
.list{max-height:calc(100vh - 16rem);overflow-y:auto;padding-right:4px}
.list .item{margin-left:0}
.inherited{border:1px dashed var(--line);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:10px;
  background:var(--accent-soft)}
.inherited .section-title{margin-bottom:6px}
.empty{color:var(--faint);font-style:italic;font-size:13px;padding:14px;border:1px dashed var(--line);
  border-radius:var(--radius-sm);text-align:center}
.task-filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-bottom:12px}
.task-filters label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.task-filters select{max-width:260px}
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
  .columns{grid-template-columns:1fr}
  /* On a phone the window is the scroller; a box inside a box is a trap. */
  .col,.list{max-height:none}
}`;

/**
 * Everything the page does after it loads, which is not much on purpose.
 *
 * Opening a drawer, copying a prompt, and finding whatever a link pointed at.
 * The view toggle is a link the server answers, so it survives with JavaScript
 * off — and so does the whole page, minus the drawer.
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

function itemButton({ row, contributions, where, marked, isProject, owner, repo, wsId, origin, pending = false, id, linkId = row.node.id }) {
  const { node, tier, n, parent } = row;
  const prompt = promptFor({
    node: { ...node, text: tier === 'task' ? node.title : node.text }, tier, where, isProject, owner, repo, parent, pending,
    link: origin ? `${origin}/project/${owner}/${repo}?${new URLSearchParams({
      ...(isProject ? {} : { ws: wsId }), ...(linkId ? { item: linkId } : {}),
    })}` : null,
  });
  const who = pending && node.author ? [node.author] : whoTouched(node, contributions);
  return projectRow({ node, type: tier, contributions, where, fallbackKey: n, marked, pending,
    id: id || `${tier === 'task' ? 't' : 'i'}-${node.id}`,
    relation: parent ? `↳ bends ${parent.key || (pending ? 'the proposed rule' : 'the rule above')}` : '',
    attributes: ` data-text="${esc(tier === 'task' ? node.title : node.text)}" data-kind="${esc(`${tier === 'task' ? 'Task' : (LABELS[tier] || tier).replace(/:$/, '')} ${node.key || (pending ? 'Pending' : n)}`)}"
  data-summary="${esc(node.detail || node.summary || '')}" data-who="${esc(who.join(', '))}"
  data-prompt="${escAttr(prompt)}"` });
}

const columns = (options) => `<div class="columns"><section class="col">
  <div class="col-head">Rules, decisions & assumptions</div>
  <div class="col-body">${options.rows.map(row => itemButton({ ...options, row, marked: row.node.id === options.item })).join('')}</div>
</section></div>`;

const list = ({ rows, contributions, where, project, item, isProject, owner, repo, wsId, origin }) => `<div class="list">
  ${rows.map(row => itemButton({
    row, contributions, where, project, isProject, owner, repo, wsId, origin, marked: row.node.id === item,
  })).join('')}
</div>`;

function historyHref({ base, selected, viewMode, item, history, taskWs, taskOwner }) {
  const query = new URLSearchParams({ taskWs, taskOwner });
  if (selected) query.set('ws', selected);
  if (viewMode === 'list') query.set('view', 'list');
  if (!history) {
    query.set('history', '1');
    if (item) query.set('item', item);
  }
  return `${base}?${query}`;
}

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
  })}${proposals}</div>`;
}

export const projectPage = ({ user, view, selected, viewMode = 'columns', item = null, note = null, origin = null, filters = {}, history = false }) => {
  const isProject = selected === null;
  const tree = isProject ? view.projectTree : view.trees[selected];
  const where = workstreamLocation(view.workstreams, selected, view.project);
  // A deep link to history must remain useful without changing the stored record.
  history ||= [view.projectTree, tree].some(t => (t?.records || []).some(r => r.id === item && r.status !== 'active'));
  const rows = numbering(tree, history);
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
  const laneHref = (ws) => `${base}?${new URLSearchParams(ws === null ? {} : { ws }).toString()}`;
  const modeHref = (mode) => {
    const q = new URLSearchParams(selected === null ? {} : { ws: selected });
    // Whatever the link pointed at survives the toggle — losing the highlight on
    // the first click defeats having landed on it.
    if (item) q.set('item', item);
    if (mode === 'list') q.set('view', 'list');
    if (history) q.set('history', '1');
    q.set('taskWs', taskWs);
    q.set('taskOwner', taskOwner);
    return `${base}${q.toString() ? `?${q}` : ''}`;
  };

  // The project's goal and its active records sit above a workstream's, the way
  // teamctx composes context: inherited, not owned, and said so.
  const inheritedRows = isProject ? [] : numbering(view.projectTree, history);
  const inherited = inheritedRows.length
    ? `<div class="inherited">
      <div class="section-title">Project context — inherited</div>
      ${inheritedRows.map(row => itemButton({ row, contributions: view.contributions, where: view.project,
        isProject: true, owner: view.owner, repo: view.repo, origin, marked: row.node.id === item })).join('')}
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
      ${viewMode === 'list' ? '<input type="hidden" name="view" value="list">' : ''}
      <select id="lane-pick" name="ws">
        <option value=""${isProject ? ' selected' : ''}>${esc(view.project || 'Project')}</option>
        ${view.workstreams.map(w => `<option value="${esc(w.id)}"${w.id === selected ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
      </select>
      <button type="submit">Open</button>
    </form>
  </aside>

  <main>
    <div class="tree-head">
      <span class="section-title">${esc(where)}</span>
      <span class="toggle">
        <a href="${esc(modeHref('columns'))}" class="${viewMode === 'columns' ? 'on' : ''}">⊞ columns</a>
        <a href="${esc(modeHref('list'))}" class="${viewMode === 'list' ? 'on' : ''}">≡ list</a>
        <a href="${esc(historyHref({ base, selected, viewMode, item, history, taskWs, taskOwner }))}" class="${history ? 'on' : ''}">${history ? 'Hide history' : 'Show history'}</a>
      </span>
    </div>
    ${inherited}
    ${rows.length
    ? (viewMode === 'list' ? list : columns)({
      rows,
      contributions: view.contributions,
      where,
      project: view.project || view.repo,
      item,
      isProject,
      owner: view.owner,
      repo: view.repo,
      wsId: selected,
      origin,
    })
    : '<p class="empty">Nothing written here yet — ask your assistant to add context.</p>'}

    <section style="margin-top:2rem">
      <div class="section-title">Tasks</div>
      <form class="task-filters" method="GET" action="${base}">
        ${selected ? `<input type="hidden" name="ws" value="${esc(selected)}">` : ''}
        ${viewMode === 'list' ? '<input type="hidden" name="view" value="list">' : ''}
        ${history ? '<input type="hidden" name="history" value="1">' : ''}
        <label>Where <select name="taskWs">
          ${[['@all', 'All work'], ['@project', view.project || 'Overall project'], ...view.workstreams.map(w => [w.id, workstreamLocation(view.workstreams, w.id)])]
    .map(([value, label]) => `<option value="${esc(value)}"${value === taskWs ? ' selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label>
        <label>Owner <select name="taskOwner">
          ${[['@all', 'Everyone'], ['@unassigned', 'Unassigned'], ...owners.map(o => [o, o])].map(([value, label]) => `<option value="${esc(value)}"${value === taskOwner ? ' selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label><button type="submit">Filter tasks</button>
      </form>
      <div class="task-list">${tasks.length ? tasks.map(t => itemButton({
        row: { node: t, tier: 'task', n: '—' }, contributions: view.contributions, where: t.where,
        isProject: !t.workstream, wsId: t.workstream, owner: view.owner, repo: view.repo,
        origin, marked: t.id === item,
      })).join('') : '<p class="muted">No open tasks match these filters.</p>'}</div>
      ${view.tasks.done.length ? `<p class="muted">${view.tasks.done.length}
        task${view.tasks.done.length === 1 ? '' : 's'} already done.</p>` : ''}
    </section>

    ${view.pending ? `<section style="margin-top:2rem">
      <div class="section-title">Waiting on you</div>
      ${view.pending.length ? view.pending.map(q => queueRows({ q, view, item, origin })).join('') : '<p class="muted">Nothing is waiting for review.</p>'}
    </section>` : ''}
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
