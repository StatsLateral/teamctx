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

/* The tree, in three columns or one list. */
.tree-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.tree-head .section-title{margin:0}
.toggle{margin-left:auto;display:flex;gap:6px}
.toggle a{font-family:var(--font-mono);font-size:11px;text-decoration:none;color:var(--soft);
  border:1px solid var(--line);border-radius:6px;padding:4px 9px;background:var(--card)}
.toggle a.on{color:var(--ink);border-color:var(--accent)}
.columns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
/* A column scrolls inside itself, the way the app this came from did. Without
   a bound, one long How list drags the page down past everything beside it and
   the other two columns end up as short marks at the top of a tall blank. */
.col{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);
  display:flex;flex-direction:column;min-width:0;min-height:220px;max-height:calc(100vh - 16rem)}
.col-head{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--soft);font-weight:600;padding:10px 12px 8px;border-bottom:1px solid var(--line)}
.col-body{padding:8px;display:flex;flex-direction:column;gap:3px;overflow-y:auto;flex:1}
.item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:6px;
  border:1px solid transparent;background:none;text-align:left;width:100%;font:inherit;cursor:pointer}
.item:hover{background:var(--paper);border-color:var(--line)}
.item.marked{border-color:var(--accent);background:var(--accent-soft)}
/* A task or a review pointed at by a link is a row, not a statement — it gets
   the same emphasis without pretending it can open the drawer. */
tr.marked td{background:var(--accent-soft)}
tr.marked td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.item .text{flex:1;min-width:0;line-height:1.45;font-size:14px;overflow-wrap:anywhere}
.item.tier-why .text{font-weight:600;font-family:var(--font-display)}
.item.tier-what .text{font-weight:500}
.item.tier-how .text{color:var(--soft)}
.num{font-family:var(--font-mono);font-size:11px;color:var(--faint);min-width:30px;margin-top:3px}
.dot{flex-shrink:0;width:10px;height:10px;border-radius:99px;margin-top:6px;background:var(--faint)}
/* Nothing recorded, so nothing claimed. The space is kept so the text of every
   row still starts in the same place. */
.dot.none{background:none}
.dot.cli{background:var(--ink)}
.dot.mcp{background:var(--accent)}
.dot.web{background:var(--grey)}
.dot.imported{background:var(--indigo)}
/* The same bound for the single-column reading, so the page itself never grows
   past the window and the toggle does not change how far you have to scroll. */
.list{max-height:calc(100vh - 16rem);overflow-y:auto;padding-right:4px}
.list .item{margin-left:0}
.list .tier-what{margin-left:26px}
.list .tier-how{margin-left:52px}
.inherited{border:1px dashed var(--line);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:10px;
  background:var(--accent-soft)}
.inherited .section-title{margin-bottom:6px}
/* Read here, opened where it lives: these belong to the project, and the drawer
   for them is on the project's own lane. */
.inherit-row{display:flex;align-items:flex-start;gap:8px;padding:5px 8px}
.inherit-row .text{flex:1;font-family:var(--font-display);font-weight:600;font-size:14px}
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
  // Only a statement opens the drawer. A task or a review row carries the same
  // marker but none of the statement's data, and reading it would have put the
  // word "undefined" in the drawer and then on somebody's clipboard.
  var statement = document.querySelector('.item.marked');
  var row = document.querySelector('.marked');
  if (row) row.scrollIntoView({ block: 'center' });
  if (statement) open(statement);
  // With JavaScript the picker moves on choosing; without it, the form's own
  // button does the same thing — the small screen is not a worse place to read.
  var pick = document.getElementById('lane-pick');
  if (pick) pick.addEventListener('change', function () { this.form.submit(); });
}());`;

/** `1`, `1.2`, `1.2.3` — what the columns number each row with. */
const numbering = (tree) => {
  const rows = [];
  (tree?.whys || []).forEach((why, i) => {
    rows.push({ node: why, tier: 'why', n: `${i + 1}` });
    (why.whats || []).forEach((what, j) => {
      rows.push({ node: what, tier: 'what', n: `${i + 1}.${j + 1}`, parent: why });
      (what.hows || []).forEach((how, k) => {
        rows.push({ node: how, tier: 'how', n: `${i + 1}.${j + 1}.${k + 1}`, parent: what, grand: why });
      });
    });
  });
  return rows;
};

/**
 * Where the most recent contribution behind a statement came from.
 *
 * The old app coloured these by `human` / `human+AI` / `ai-service`, which its
 * own data model recorded. teamctx records something different and more
 * reliable: which surface the contribution arrived through — `cli`, `mcp`,
 * `web`, or a connector's own name when it was imported. Mapping the old names
 * onto these would have been a guess dressed as provenance, and one of the three
 * colours could never have been reached at all.
 */
function kindOf(node, contributions) {
  const ids = node.sourceContributionIds || [];
  const source = (ids.length ? contributions[ids[ids.length - 1]]?.source : '') || '';
  if (source === 'cli') return 'cli';
  if (source === 'mcp') return 'mcp';
  if (source === 'web') return 'web';
  return source ? 'imported' : 'none';
}

/** Everybody whose contribution touched a statement, by name. */
const whoTouched = (node, contributions) => [...new Set(
  (node.sourceContributionIds || []).map(id => contributions[id]?.author).filter(Boolean),
)];

/**
 * What to paste into a fresh chat.
 *
 * Three versions of this have been wrong in three different ways, and the last
 * one was wrong expensively: it named the repository and then added "your
 * connector may be named something else", which told an assistant connected to a
 * *different* project to carry on regardless. It did — it could not find the
 * statement, found the nearest thing, and answered about that instead. A prompt
 * that invites a silent substitution is worse than a vague one.
 *
 * So: check first, quote exactly, and say what to do when it does not match. The
 * assistant is told which repository, how to confirm it is on that one, that the
 * statement is quoted word for word from a page, and to say so rather than
 * reach for the closest match if it is not there.
 */
function promptFor({ node, tier, where, wsId, isProject, owner, repo, link, parent, grand }) {
  const place = isProject
    ? "the project's own context (not a workstream)"
    : `the part of the work called "${where}"${wsId ? ` (id: ${wsId})` : ''}`;
  // Where it hangs, said rather than left to be found: an assistant that has to
  // go looking reads the whole project, and then answers with the whole project.
  //
  // Each ancestor is named by what it actually is. A What hangs under a Why, a
  // How under a What and then a Why — calling every parent "the What" put a
  // goal's words in front of the assistant under the wrong word.
  const above = tier === 'how'
    ? [['What', parent], ['Why', grand]]
    : tier === 'what' ? [['Why', parent]] : [];
  const lineage = above
    .filter(([, n]) => n)
    .map(([label, n]) => `the ${label} "${n.text}"`)
    .join(', under ');

  // Three numbered steps, each its own block, and the statement on a line of its
  // own. The same words ran together as one paragraph of a hundred-odd words:
  // correct, and unreadable the moment it landed in a chat box — somebody who
  // cannot see the shape of what they just pasted deletes it instead of sending
  // it. Pasting newlines into a chat input does not send the message, so the
  // readable version costs nothing.
  const step = (...lines) => lines.filter(Boolean).join('\n');

  return [
    'Using teamctx.',
    step(
      `1) Confirm you are connected to the repository ${owner}/${repo}.`,
      '   get_connect_url returns a URL containing the owner and repo. If it is a different one,',
      '   stop and tell me, rather than answering from the project you are connected to.',
    ),
    step(
      `2) In ${place}, find this ${tier}, quoted word for word from the project page:`,
      `   "${node.text}"`,
      lineage ? `   It sits under ${lineage}.` : '',
      '   If it is not there, say so plainly rather than answering about the closest thing you can find.',
    ),
    step(
      `3) Answer about that one ${tier}: why it is there, what it requires, and what is still open for it.`,
      '   Keep it short. Do not summarise the rest of the project, list its other goals or tasks,',
      '   or report what is open elsewhere, unless I ask.',
    ),
    link ? `The page it came from: ${link}` : '',
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

function itemButton({ row, contributions, where, project, marked, isProject, owner, repo, wsId, origin }) {
  const { node, tier, n, parent, grand } = row;
  const prompt = promptFor({
    node, tier, where, wsId, isProject, owner, repo, parent, grand,
    link: origin ? `${origin}/project/${owner}/${repo}?${new URLSearchParams({
      ...(isProject ? {} : { ws: wsId }), item: node.id,
    })}` : null,
  });
  const who = whoTouched(node, contributions);
  return `<button class="item tier-${tier}${marked ? ' marked' : ''}" id="i-${esc(node.id)}"
  data-text="${esc(node.text)}" data-kind="${esc(`${tier} ${n}`)}"
  data-summary="${esc(node.summary || '')}" data-who="${esc(who.join(', '))}"
  data-prompt="${escAttr(prompt)}">
  <span class="dot ${kindOf(node, contributions)}"></span>
  <span class="num">${n}</span>
  <span class="text">${esc(node.text)}</span>
</button>`;
}

const columns = ({ rows, contributions, where, project, item, isProject, owner, repo, wsId, origin }) => `<div class="columns">
  ${['why', 'what', 'how'].map(tier => `<section class="col">
    <div class="col-head">${tier === 'why' ? 'Why' : tier === 'what' ? 'What' : 'How'}</div>
    <div class="col-body">
      ${rows.filter(r => r.tier === tier).map(row => itemButton({
    row, contributions, where, project, isProject, owner, repo, wsId, origin, marked: row.node.id === item,
  })).join('')
    || '<p class="muted" style="margin:6px 8px">Nothing here yet.</p>'}
    </div>
  </section>`).join('')}
</div>`;

const list = ({ rows, contributions, where, project, item, isProject, owner, repo, wsId, origin }) => `<div class="list">
  ${rows.map(row => itemButton({
    row, contributions, where, project, isProject, owner, repo, wsId, origin, marked: row.node.id === item,
  })).join('')}
</div>`;

export const projectPage = ({ user, view, selected, viewMode = 'columns', item = null, note = null, origin = null }) => {
  const isProject = selected === null;
  const tree = isProject ? view.projectTree : view.trees[selected];
  const where = isProject ? (view.project || 'the project') : (view.workstreams.find(w => w.id === selected)?.name || selected);
  const rows = numbering(tree);
  const base = `/project/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}`;
  const laneHref = (ws) => `${base}?${new URLSearchParams(ws === null ? {} : { ws }).toString()}`;
  const modeHref = (mode) => {
    const q = new URLSearchParams(selected === null ? {} : { ws: selected });
    // Whatever the link pointed at survives the toggle — losing the highlight on
    // the first click defeats having landed on it.
    if (item) q.set('item', item);
    if (mode === 'list') q.set('view', 'list');
    return `${base}${q.toString() ? `?${q}` : ''}`;
  };

  // The project's own Whys sit above a workstream's, the way teamctx composes
  // context: inherited, not owned, and said so rather than blended in.
  const inherited = !isProject && (view.projectTree?.whys || []).length
    ? `<div class="inherited">
      <div class="section-title">Project context — inherited</div>
      ${(view.projectTree.whys || []).map(w => `<div class="inherit-row">
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
      ${lane(null, view.project || 'Project', [], (view.projectTree?.whys || []).length, isProject)}
      ${view.workstreams.map(w => lane(w.id, w.name, w.members, (view.trees[w.id]?.whys || []).length, w.id === selected)).join('')}
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
        <a href="${modeHref('columns')}" class="${viewMode === 'columns' ? 'on' : ''}">⊞ columns</a>
        <a href="${modeHref('list')}" class="${viewMode === 'list' ? 'on' : ''}">≡ list</a>
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
    <details class="peek">
      <summary>See the prompt first</summary>
      <pre id="d-prompt"></pre>
    </details>
    <button class="primary" id="copy">Copy a prompt for your assistant</button>
  </div>
</aside>`, { wide: true, extraCss: CSS, script: SCRIPT });
};
