import { shell, navBar, esc } from './theme.js';

/**
 * Where a project stands: its context, its work, and what waits on the manager.
 *
 * The tree is what teamctx exists to keep, and until now the only way to read it
 * was to ask an assistant — which asks a non-technical manager to know what to
 * ask for. This is the view from `git-for-non-tech-teams`, on teamctx's own data
 * and its own scoping: a sidebar of the parts somebody may see, the tree in
 * numbered Why / What / How columns, and a drawer on each item.
 *
 * Read-only, deliberately. Adding context, approving it and asking questions all
 * have a place already, and a second way to do any of them is a second thing to
 * keep honest. The drawer copies a prompt instead of answering one.
 */

const CSS = `
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

/* The tree, in three columns or one list. */
.tree-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.tree-head .section-title{margin:0}
.toggle{margin-left:auto;display:flex;gap:6px}
.toggle a{font-family:var(--font-mono);font-size:11px;text-decoration:none;color:var(--soft);
  border:1px solid var(--line);border-radius:6px;padding:4px 9px;background:var(--card)}
.toggle a.on{color:var(--ink);border-color:var(--accent)}
.columns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.col{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);
  display:flex;flex-direction:column;min-height:220px}
.col-head{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--soft);font-weight:600;padding:10px 12px 8px;border-bottom:1px solid var(--line)}
.col-body{padding:8px;display:flex;flex-direction:column;gap:3px}
.item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:6px;
  border:1px solid transparent;background:none;text-align:left;width:100%;font:inherit;cursor:pointer}
.item:hover{background:var(--paper);border-color:var(--line)}
.item.marked{border-color:var(--accent);background:var(--accent-soft)}
.item .text{flex:1;line-height:1.45;font-size:14px}
.item.tier-why .text{font-weight:600;font-family:var(--font-display)}
.item.tier-what .text{font-weight:500}
.item.tier-how .text{color:var(--soft)}
.num{font-family:var(--font-mono);font-size:11px;color:var(--faint);min-width:30px;margin-top:3px}
.dot{flex-shrink:0;width:10px;height:10px;border-radius:99px;margin-top:6px;background:var(--faint)}
.dot.human{background:var(--ink)}
.dot.human-ai{background:var(--accent)}
.dot.ai-service{background:var(--amber)}
.dot.tool{background:var(--indigo)}
.list .item{margin-left:0}
.list .tier-what{margin-left:26px}
.list .tier-how{margin-left:52px}
.inherited{border:1px dashed var(--line);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:10px;
  background:var(--accent-soft)}
.inherited .section-title{margin-bottom:6px}
.empty{color:var(--faint);font-style:italic;font-size:13px;padding:14px;border:1px dashed var(--line);
  border-radius:var(--radius-sm);text-align:center}

/* The drawer. */
.drawer{position:fixed;top:0;right:0;height:100vh;width:min(520px,100vw);background:var(--card);
  border-left:1px solid var(--line);z-index:40;transform:translateX(100%);transition:transform .25s ease;
  display:flex;flex-direction:column}
.drawer.open{transform:translateX(0)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:16px 20px;border-bottom:1px solid var(--line)}
.drawer-body{padding:20px;overflow-y:auto}
.drawer-body .statement{font-family:var(--font-display);font-size:18px;margin:0 0 10px}
.backdrop{display:none;position:fixed;inset:0;background:rgba(26,28,26,.35);z-index:39}
.backdrop.on{display:block}
.note{background:var(--amber-soft);color:var(--amber);padding:.5rem .7rem;border-radius:var(--radius-sm);
  margin-bottom:1rem;font-size:.9rem}

@media(max-width:760px){
  .layout{grid-template-columns:1fr}
  .lanes{display:none}
  .lane-pick{display:block}
  .columns{grid-template-columns:1fr}
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
    drawer.classList.add('open'); backdrop.classList.add('on');
  }
  function close() { drawer.classList.remove('open'); backdrop.classList.remove('on'); }
  document.querySelectorAll('.item').forEach(function (el) {
    el.addEventListener('click', function () { open(el); });
  });
  backdrop.addEventListener('click', close);
  document.getElementById('d-close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  document.getElementById('copy').addEventListener('click', function () {
    var b = this;
    navigator.clipboard.writeText(b.dataset.prompt).then(function () {
      b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy a prompt for your assistant'; }, 1500);
    });
  });
  var marked = document.querySelector('.marked');
  if (marked) { marked.scrollIntoView({ block: 'center' }); open(marked); }
  var pick = document.getElementById('lane-pick');
  if (pick) pick.addEventListener('change', function () { window.location.href = this.value; });
}());`;

/** `1`, `1.2`, `1.2.3` — what the columns number each row with. */
const numbering = (tree) => {
  const rows = [];
  (tree?.whys || []).forEach((why, i) => {
    rows.push({ node: why, tier: 'why', n: `${i + 1}` });
    (why.whats || []).forEach((what, j) => {
      rows.push({ node: what, tier: 'what', n: `${i + 1}.${j + 1}`, parent: why });
      (what.hows || []).forEach((how, k) => {
        rows.push({ node: how, tier: 'how', n: `${i + 1}.${j + 1}.${k + 1}`, parent: what });
      });
    });
  });
  return rows;
};

/** The kind of the most recent contribution behind a statement, for its dot. */
function kindOf(node, contributions) {
  const ids = node.sourceContributionIds || [];
  const last = ids.length ? contributions[ids[ids.length - 1]] : null;
  const source = last?.source || '';
  if (source === 'human' || source === 'cli' || source === 'web') return 'human';
  if (source === 'human+AI' || source === 'mcp') return 'human-ai';
  if (source === 'ai-service' || source === 'agent') return 'ai-service';
  if (source) return 'tool';
  return '';
}

/** Everybody whose contribution touched a statement, by name. */
const whoTouched = (node, contributions) => [...new Set(
  (node.sourceContributionIds || []).map(id => contributions[id]?.author).filter(Boolean),
)];

function itemButton({ row, contributions, where, project, marked }) {
  const { node, tier, n } = row;
  const prompt = `Tell me more about "${n} ${node.text}" in ${where} on ${project}.`;
  const who = whoTouched(node, contributions);
  return `<button class="item tier-${tier}${marked ? ' marked' : ''}" id="i-${esc(node.id)}"
  data-text="${esc(node.text)}" data-kind="${esc(`${tier} ${n}`)}"
  data-summary="${esc(node.summary || '')}" data-who="${esc(who.join(', '))}"
  data-prompt="${esc(prompt)}">
  <span class="dot ${kindOf(node, contributions)}"></span>
  <span class="num">${n}</span>
  <span class="text">${esc(node.text)}</span>
</button>`;
}

const columns = ({ rows, contributions, where, project, item }) => `<div class="columns">
  ${['why', 'what', 'how'].map(tier => `<section class="col">
    <div class="col-head">${tier === 'why' ? 'Why' : tier === 'what' ? 'What' : 'How'}</div>
    <div class="col-body">
      ${rows.filter(r => r.tier === tier).map(row => itemButton({
    row, contributions, where, project, marked: row.node.id === item,
  })).join('')
    || '<p class="muted" style="margin:6px 8px">Nothing here yet.</p>'}
    </div>
  </section>`).join('')}
</div>`;

const list = ({ rows, contributions, where, project, item }) => `<div class="list">
  ${rows.map(row => itemButton({
    row, contributions, where, project, marked: row.node.id === item,
  })).join('')}
</div>`;

export const projectPage = ({ user, view, selected, viewMode = 'columns', item = null, note = null }) => {
  const isProject = selected === null;
  const tree = isProject ? view.projectTree : view.trees[selected];
  const where = isProject ? (view.project || 'the project') : (view.workstreams.find(w => w.id === selected)?.name || selected);
  const rows = numbering(tree);
  const base = `/project/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}`;
  const laneHref = (ws) => `${base}?${new URLSearchParams(ws === null ? {} : { ws }).toString()}`;
  const modeHref = (mode) => {
    const q = new URLSearchParams(selected === null ? {} : { ws: selected });
    if (mode === 'list') q.set('view', 'list');
    return `${base}${q.toString() ? `?${q}` : ''}`;
  };

  // The project's own Whys sit above a workstream's, the way teamctx composes
  // context: inherited, not owned, and said so rather than blended in.
  const inherited = !isProject && (view.projectTree?.whys || []).length
    ? `<div class="inherited">
      <div class="section-title">Project context — inherited</div>
      ${(view.projectTree.whys || []).map(w => `<div class="item tier-why" style="cursor:default">
        <span class="dot ${kindOf(w, view.contributions)}"></span>
        <span class="text">${esc(w.text)}</span>
      </div>`).join('')}
    </div>`
    : '';

  const lane = (id, name, members, count, on) => `<a class="lane${on ? ' on' : ''}" href="${laneHref(id)}">
    <div class="lane-row"><span class="name">${esc(name)}</span><span class="count">${count}</span></div>
    ${members.length ? `<div class="lane-team">${members.map(m => `<span class="team-chip">${esc(m)}</span>`).join('')}</div>` : ''}
  </a>`;

  return shell(view.project || `${view.owner}/${view.repo}`, `
${navBar({ user, current: '/projects' })}
<p><a href="/projects">← All projects</a></p>
<h1>${esc(view.project || `${view.owner}/${view.repo}`)}</h1>
<p class="muted"><code>${esc(view.owner)}/${esc(view.repo)}</code> ·
${view.isManager ? 'you manage this project' : 'you are on this project'}</p>
${note ? `<p class="note">${esc(note)}</p>` : ''}

<div class="layout">
  <aside>
    <div class="section-title">The work</div>
    <div class="lanes">
      ${lane(null, view.project || 'Project', [], (view.projectTree?.whys || []).length, isProject)}
      ${view.workstreams.map(w => lane(w.id, w.name, w.members, (view.trees[w.id]?.whys || []).length, w.id === selected)).join('')}
    </div>
    <select id="lane-pick" class="lane-pick">
      <option value="${laneHref(null)}"${isProject ? ' selected' : ''}>${esc(view.project || 'Project')}</option>
      ${view.workstreams.map(w => `<option value="${laneHref(w.id)}"${w.id === selected ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
    </select>
  </aside>

  <main>
    <div class="tree-head">
      <span class="section-title">${esc(where)}</span>
      <span class="toggle">
        <a href="${modeHref('columns')}" class="${viewMode === 'columns' ? 'on' : ''}">⊞ columns</a>
        <a href="${modeHref('list')}" class="${viewMode === 'list' ? 'on' : ''}">≡ list</a>
      </span>
    </div>
    ${inherited}
    ${rows.length
    ? (viewMode === 'list' ? list : columns)({ rows, contributions: view.contributions, where, project: view.project || view.repo, item })
    : '<p class="empty">Nothing written here yet — ask your assistant to add context.</p>'}

    <section style="margin-top:2rem">
      <div class="section-title">Tasks</div>
      ${view.tasks.open.length ? `<table>
        <tr><th>Task</th><th>Who has it</th><th>Where</th></tr>
        ${view.tasks.open.map(t => `<tr id="t-${esc(t.id)}"${t.id === item ? ' class="marked"' : ''}>
          <td>${esc(t.title)}</td>
          <td class="muted">${t.owner ? esc(t.owner) : 'nobody yet'}</td>
          <td class="muted">${esc(t.where)}</td>
        </tr>`).join('')}
      </table>` : '<p class="muted">Nothing open.</p>'}
      ${view.tasks.done.length ? `<p class="muted">${view.tasks.done.length}
        task${view.tasks.done.length === 1 ? '' : 's'} already done.</p>` : ''}
    </section>

    ${view.pending ? `<section style="margin-top:2rem">
      <div class="section-title">Waiting on you</div>
      ${view.pending.length ? `<table>
        <tr><th>From</th><th>What</th><th>Where</th></tr>
        ${view.pending.map(q => `<tr id="r-${esc(q.id)}"${q.id === item ? ' class="marked"' : ''}>
          <td>${esc(q.author)}</td>
          <td>${esc(q.summary || '(no summary)')}</td>
          <td class="muted">${esc(q.where)}</td>
        </tr>`).join('')}
      </table>` : '<p class="muted">Nothing is waiting for review.</p>'}
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
    <button class="primary" id="copy">Copy a prompt for your assistant</button>
  </div>
</aside>`, { wide: true, extraCss: CSS, script: SCRIPT });
};
