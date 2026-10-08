import { shell, navBar, esc } from './theme.js';
import { today } from '../model.js';
import { workHtml, treeHtml, ctxButton } from './project-work.js';
import { mcpUrl, shortMcpUrl } from './mcp-url.js';
import { assistantPlan } from './assistant-actions.js';
import { panelsHtml, assistantBlockHtml } from './drawers.js';
import { drawerPrompts } from '../prompts.js';

/** Read-only project context, work and proposals, using one row layout. */

const CSS = `
/* Type and spacing follow the demo: 14px body at 1.45, a 28px title, a 19px goal.
   The shared theme leaves the body at the browser's 16px, which made the waiting
   items, the goal's why and everything in the drawer read a size larger than the
   rows beside them. */
body{font-size:14px;line-height:1.45}
h1{font-size:28px;line-height:1.25;margin:0 0 .35rem}
/* The header is three short lines, and the tree is what somebody came for:
   whether they manage the project is not news to them, and the space it took
   pushed the columns below where the eye lands. */
.crumb{margin:0 0 .2rem;font-size:.85rem}
/* On the title's own line: standing is worth knowing and not worth a paragraph
   — it told you in a sentence before, and the sentence cost the space above the
   tree. */
.role-chip{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--accent);background:var(--accent-soft);border-radius:99px;padding:3px 9px;vertical-align:middle}
/* The goal and why it matters open the page: serif and ink for the goal, body
   size and soft grey for the why. Three lines in all, so the CSS clamp below is
   the no-JavaScript answer (goal two lines, why one) and the script gives the
   why whatever the goal leaves. The stored text is never cut. */
.goal-block{margin:12px 0 26px;max-width:none}
.goal-text{font-family:var(--font-display);font-weight:500;font-size:19px;line-height:1.4;color:var(--ink);margin:0 0 6px;
  overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.goal-why{font-size:14px;line-height:1.55;color:var(--soft);margin:0;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden}
.layout{display:grid;grid-template-columns:262px 1fr;gap:22px 34px;align-items:start}
/* The left column is pinned and sized to the screen: the tree scrolls inside its
   own area and Settings stays at the foot, on screen however long the tree is.
   The script fits the height from where the column starts; this is the answer
   before it runs and when it cannot. */
.layout>aside{position:sticky;top:12px;display:flex;flex-direction:column;min-height:260px;max-height:calc(100vh - 24px)}
.rail-work{flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:2px}
.settings{flex:none;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
.mcp-row{display:flex;align-items:center;gap:8px}
.mcp-url{flex:1 1 auto;min-width:0;font-family:var(--font-mono);font-size:11px;color:var(--soft);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.copy-url{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;
  border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--soft);cursor:pointer}
.copy-url:hover,.copy-url:focus-visible{border-color:var(--accent);color:var(--ink)}
.copy-url svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.copy-url .ico-check{display:none;color:var(--accent)}
.copy-url.done .ico-copy{display:none}
.copy-url.done .ico-check{display:block}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* The tree: the whole project, then each part of the work with the parts inside
   it indented. A dot says something in there needs a look; the number is how many
   tasks are open at or under it. */
.tree,.tree ul{list-style:none;margin:0;padding:0}
.tree ul{margin-left:12px;padding-left:6px;border-left:1px solid var(--line)}
.node{display:flex;align-items:baseline;gap:8px;padding:6px 8px;border-radius:6px;text-decoration:none;color:var(--ink);font-size:14px;line-height:1.35}
.node:hover{background:var(--accent-soft)}
.node.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.node .num{flex:none;width:14px;font-family:var(--font-mono);font-size:11px;color:var(--faint)}
.node .nm{min-width:0;overflow-wrap:anywhere}
.node .dot{flex:none;align-self:center;width:7px;height:7px;border-radius:50%;background:var(--amber)}
.node .cnt{flex:none;margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--faint)}
.node.root{font-family:var(--font-display);font-weight:600;font-size:15px;padding-left:8px}
.stline{margin:.35rem 0 0;font-size:13px;color:var(--soft)}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:1.5;padding:1px 9px;border-radius:99px;background:var(--grey-soft);color:var(--soft);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.chip.agent{color:#5b61d6;background:color-mix(in srgb,#5b61d6 12%,transparent)}
.chip.warn{color:var(--amber);background:var(--amber-soft)}
.chip.none{color:var(--faint)}

/* What is waiting on the manager, above the work. */
.inbox{border:1px solid var(--amber);background:var(--amber-soft);border-radius:var(--radius);padding:14px 16px 4px;margin:0 0 28px}
.inbox h2{font-family:var(--font-display);font-size:18px;margin:0 0 8px;color:var(--ink)}
.q{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:4px 12px;padding:11px 0;align-items:start;cursor:pointer;
  border-top:1px solid color-mix(in srgb,var(--amber) 28%,transparent)}
.q.marked{background:color-mix(in srgb,var(--amber) 10%,transparent);box-shadow:inset 3px 0 0 var(--amber)}
.q .num{font-family:var(--font-mono);font-size:12px;color:var(--soft);padding-top:2px}
.q .what{min-width:0}
.qmain{display:block;width:100%;text-align:left;background:none;border:0;padding:0;font:inherit;font-weight:500;color:var(--ink);cursor:pointer;overflow-wrap:anywhere}
.q:hover .qmain{text-decoration:underline}
/* Work sent back for a task: what arrived, under the task's own title. */
.q .submitted{grid-column:2;color:var(--soft);font-size:13px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.approving{margin:0 0 .6rem;font-size:13px;line-height:1.5;color:var(--ink)}
.q .sub{grid-column:2;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;color:var(--soft);font-size:12.5px}
.qicons{grid-column:3;grid-row:1 / span 2;align-self:center;display:flex;gap:6px}
.qicon{width:34px;height:34px;display:grid;place-items:center;padding:0;border:1px solid var(--line);background:var(--card);border-radius:8px;color:var(--soft);cursor:pointer}
.qicon:hover,.qicon:focus-visible{border-color:var(--accent);color:var(--accent)}
.qicon.rv{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.qicon.rv:hover,.qicon.rv:focus-visible{background:var(--accent);border-color:var(--accent);color:#fff}

/* Every part of the work with something open, each under its own heading. */
.wsec{margin:0 0 30px}
.wsec h2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:var(--font-display);font-weight:600;font-size:19px;margin:0 0 4px}
.wsn{font-family:var(--font-mono);font-weight:400;font-size:12px;color:var(--faint)}
.wsec .ctx-open{width:26px;height:26px}
.wsec .ctx-open svg{width:14px;height:14px}
.trows{border-bottom:1px solid var(--line)}
.noTasks{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding:2px 0 14px}
.noTasks .empty{flex:0 1 auto;border:0;padding:6px 0;text-align:left}
.mk-tasks{font:inherit;font-size:13px;font-weight:600;color:var(--ink);background:transparent;border:1px solid var(--accent);border-radius:var(--radius-sm);padding:6px 12px;cursor:pointer}
.mk-tasks:hover,.mk-tasks:focus-visible{background:var(--accent);color:var(--bg,#fff)}
.tasknote{font-size:13px;color:var(--muted,var(--faint));margin:0 0 12px}
.trow{display:grid;grid-template-columns:48px minmax(0,1fr) minmax(0,230px) 48px;gap:6px 12px;align-items:start;width:100%;text-align:left;
  background:none;border:0;border-top:1px solid var(--line);border-radius:0;padding:9px 8px;font:inherit;color:inherit;cursor:pointer}
.trow:hover{background:var(--accent-soft)}
.trow .num{font-family:var(--font-mono);font-size:12px;color:var(--soft);padding-top:2px}
.trow .ttl{min-width:0;font-size:14px;line-height:1.45;overflow-wrap:anywhere}
.trow .own{min-width:0}
.trow .clip{color:var(--faint);font-size:12px;white-space:nowrap}
.trow.done .ttl{text-decoration:line-through}
.trow.done{opacity:.55}
.item.marked{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.hist{margin:.5rem 0 0;font-size:12.5px}
.hist a{color:var(--soft);text-decoration:underline}
.empty{color:var(--faint);font-style:italic;font-size:13px;padding:14px;border:1px dashed var(--line);border-radius:var(--radius-sm);text-align:center}
.stale-note{background:var(--amber-soft);color:var(--amber);font-size:12px;padding:6px 8px;border-radius:6px;margin:0 0 10px}
.plain{margin:0 0 1rem;padding-left:1.1rem}
.plain li{margin:0 0 .4rem;line-height:1.45;overflow-wrap:anywhere}
/* A task's history: the date, who, what happened, one line each. */
.hstatus{margin:0 0 .4rem;font-size:13px;color:var(--ink);font-weight:600}
.history{list-style:none;padding-left:0}
.history li{font-size:13px;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.history .hdate{font-family:var(--font-mono);font-size:11px;color:var(--faint);min-width:76px}
.history .hwait{font-size:11px;color:var(--amber);background:var(--amber-soft);border-radius:99px;padding:0 7px}
#d-history-earlier{margin:0 0 .4rem}
/* The theme gives every button and these rows a display of their own, which
   overrides the hidden attribute: the empty Show earlier button left a gap, and
   the earlier lines it holds back stayed on screen. */
#d-history-earlier[hidden],.history li[hidden]{display:none}
#d-text.done{text-decoration:line-through;opacity:.75}
.decide p{margin:0 0 .5rem;font-size:13px;line-height:1.5;color:var(--ink);overflow-wrap:anywhere}
.decide code{font-family:var(--font-mono);font-size:12px}
/* One instruction per line, its Copy button beside it; the text wraps first. */
.decide .decide-where{margin:.6rem 0 .3rem;font-size:12px;color:var(--soft)}
.decide-line{display:flex;align-items:center;gap:8px;margin:0 0 6px}
/* What the line shows is clipped to one line here; Copy takes the whole text. */
.decide-line code{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:var(--ink)}
.decide-copy{flex:none;font-size:12px;padding:4px 10px;border-radius:6px}

/* The drawer. */
.drawer{position:fixed;top:0;right:0;height:100vh;width:min(520px,100vw);background:var(--card);
  border-left:1px solid var(--line);z-index:40;transform:translateX(100%);transition:transform .25s ease;
  display:flex;flex-direction:column}
.drawer.open{transform:translateX(0)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:16px 20px;border-bottom:1px solid var(--line)}
.drawer-body{padding:20px;overflow-y:auto}
.dpanel[hidden]{display:none}
.dpanel .why-full{margin:0 0 1rem;color:var(--soft);overflow-wrap:anywhere}
.cgroup{margin:0 0 1rem}
.cgroup h3{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin:0 0 .35rem;font-weight:500}
.cgroup ul{margin:0;padding-left:1.1rem}
.cgroup li{margin:0 0 .45rem;line-height:1.45;overflow-wrap:anywhere}
.cgroup li ul{margin-top:.35rem}
.why-line,.needs-line{display:block;font-size:12px;color:var(--soft)}
.needs-line{color:var(--amber)}
.until{color:var(--soft);font-size:12px}
.ctxline{font-size:13px;color:var(--soft);margin:.4rem 0 1rem}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer}
/* Context icons: a small panel glyph that opens a drawer. */
.ctx-open{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;flex:none;
  border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--soft);cursor:pointer}
.ctx-open:hover,.ctx-open:focus-visible{border-color:var(--accent);color:var(--ink)}
.ctx-open svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.goal-block{display:flex;align-items:flex-start;gap:12px}
.goal-copy{flex:1 1 auto;min-width:0}
/* The assistant block every drawer carries. */
.assist{margin-top:1.4rem;padding-top:1rem;border-top:1px solid var(--line)}
.amode{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--soft);margin:0 0 .7rem}
.amode[hidden]{display:none}
.assist .amode label{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:400;color:var(--soft);cursor:pointer}
.assist .amode input[type=radio]{width:auto;margin:0;padding:0;flex:none;accent-color:var(--accent)}
.chatrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.chatcap{font-size:13px;color:var(--soft)}
.chatico{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;padding:0;border:1px solid var(--line);
  border-radius:10px;background:var(--card);color:var(--ink);cursor:pointer}
.chatico:hover,.chatico:focus-visible{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);outline:none}
.chatdiv{width:1px;height:26px;background:var(--line);margin:0 2px}
.chatnote{font-size:12px;color:var(--faint);margin:.6rem 0 0}
.toast{min-height:1.2em;font-size:13px;color:var(--accent);margin:.6rem 0 0}
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

@media(max-width:900px){
  /* One column: the tree and Settings are ordinary sections, no pinning. */
  .layout{grid-template-columns:1fr}
  .layout>aside{position:static;min-height:0;max-height:none}
  .rail-work{overflow:visible}
}
@media(max-width:640px){
  .trow{grid-template-columns:40px minmax(0,1fr)}
  .trow .own,.trow .clip{grid-column:2}
  .q{grid-template-columns:36px minmax(0,1fr)}
  .qicons{grid-column:2;grid-row:auto;justify-self:start}
}`;

/**
 * How many lines the why gets, given how many lines the goal needs.
 *
 * Three lines in all, sub-heading included: the goal takes up to two and the why
 * takes what is left, at least one. A one-line goal leaves two for the why.
 * Display only; the stored text is never shortened. Also inlined into the page
 * script below, so the browser and the tests run the same rule.
 */
export const whyLinesLeft = (goalLines) => Math.max(1, 3 - Math.min(2, goalLines));

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
  var prompts = JSON.parse(document.getElementById('prompts').textContent);
  var assistantPlan = ${assistantPlan.toString()};
  var current = { short: '', full: '' };
  var opener = null;
  var taskView = document.getElementById('d-task');
  var panels = document.querySelectorAll('.dpanel');
  var peek = document.getElementById('d-prompt');
  var mode = function () {
    var picked = document.querySelector('input[name="amode"]:checked');
    return picked ? picked.value : 'connected';
  };
  var showPrompt = function () { peek.textContent = mode() === 'paste' ? current.full : current.short; };
  // The prompts for one place, from the map the server built for this reader. A
  // part they cannot see is not in it, and falls back to the project's.
  var forScope = function (scope) {
    if (scope && scope.indexOf('ws:') === 0 && prompts.ws[scope.slice(3)]) return prompts.ws[scope.slice(3)];
    return prompts.project;
  };
  var reveal = function () {
    // Every opening starts at the top: the drawer kept its scroll, so after a
    // Review click had gone down to Decide, the next item opened partway down.
    // Only the Review icon then scrolls on, to the decision.
    drawer.querySelector('.drawer-body').scrollTop = 0;
    drawer.classList.add('open'); backdrop.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    document.getElementById('toast').textContent = '';
    document.getElementById('d-close').focus();
  };
  // A task's history (#143): the status, then one line per event, oldest first,
  // all written as text. Past ten events the earlier ones wait behind a link,
  // and nothing is dropped.
  var HISTORY_SHOWN = 10;
  function showHistory(data) {
    var wrap = document.getElementById('d-history-wrap');
    var list = document.getElementById('d-history');
    var earlier = document.getElementById('d-history-earlier');
    wrap.hidden = !data;
    list.textContent = '';
    earlier.hidden = true;
    if (!data) return;
    document.getElementById('d-history-status').textContent = data.status;
    var hidden = Math.max(0, data.lines.length - HISTORY_SHOWN);
    data.lines.forEach(function (line, i) {
      var li = document.createElement('li');
      if (i < hidden) { li.hidden = true; li.className = 'earlier'; }
      var date = document.createElement('span'); date.className = 'hdate';
      date.textContent = line.date; if (line.at) date.title = line.at;
      li.appendChild(date);
      var text = line.text;
      if (line.who) {
        var chip = document.createElement('span'); chip.className = 'chip' + (line.agent ? ' agent' : '');
        chip.textContent = (line.agent ? '\\u{1F916} ' : '\\u{1F464} ') + line.who;
        li.appendChild(chip);
      } else {
        text = text.charAt(0).toUpperCase() + text.slice(1);
      }
      li.appendChild(document.createTextNode(' ' + text));
      if (line.waiting) {
        var tag = document.createElement('span'); tag.className = 'hwait'; tag.textContent = 'waiting for approval';
        li.appendChild(tag);
      }
      list.appendChild(li);
    });
    if (hidden) {
      earlier.hidden = false;
      earlier.textContent = 'Show earlier (' + hidden + ')';
    }
  }
  document.getElementById('d-history-earlier').addEventListener('click', function () {
    document.querySelectorAll('#d-history li.earlier').forEach(function (li) { li.hidden = false; });
    this.hidden = true;
  });
  // The assistant block says what it is for: asking about something, or deciding it.
  function assistFor(deciding) {
    document.getElementById('d-assist-title').textContent = deciding ? 'Decide in your assistant' : 'Ask in your assistant';
    var modes = document.getElementById('d-amode');
    modes.hidden = deciding;
    if (deciding) modes.querySelector('input[value="connected"]').checked = true;
  }
  function open(el) {
    opener = el;
    taskView.hidden = false;
    panels.forEach(function (p) { p.hidden = true; });
    document.getElementById('d-text').textContent = el.dataset.text;
    // Shown only when there is something to show, so the drawer does not carry
    // an empty line about a record that is standing on solid ground.
    var review = document.getElementById('d-review');
    review.textContent = el.dataset.review || '';
    review.style.display = el.dataset.review ? 'block' : 'none';
    document.getElementById('d-kind').textContent = el.dataset.kind;
    document.getElementById('d-summary').textContent = el.dataset.summary || 'No summary recorded.';
    // A waiting item also says what approving would change, what to check it
    // against, and how to decide it; a task has none of that.
    var queued = !!el.dataset.queue;
    document.getElementById('d-queue').hidden = !queued;
    if (queued) {
      var fill = function (id, key) {
        var list = document.getElementById(id);
        list.textContent = '';
        JSON.parse(el.dataset[key] || '[]').forEach(function (line) {
          var li = document.createElement('li'); li.textContent = line; list.appendChild(li);
        });
        return list.children.length;
      };
      // Work for a task shows what arrived, and what approving it does (#144).
      document.getElementById('d-changes-title').textContent = el.dataset.changesTitle || 'What it would change';
      var approving = document.getElementById('d-approving');
      approving.textContent = el.dataset.approving || '';
      approving.hidden = !el.dataset.approving;
      fill('d-changes', 'changes');
      document.getElementById('d-checks-wrap').hidden = !fill('d-checks', 'checks');
      // Each instruction on its own line with a Copy button, under where it is
      // used. Built as text nodes: these are somebody else's words.
      var decide = document.getElementById('d-decide');
      decide.textContent = '';
      var group = null;
      JSON.parse(el.dataset.decide || '[]').forEach(function (line) {
        if (line.where !== group) {
          group = line.where;
          var head = document.createElement('p'); head.className = 'decide-where'; head.textContent = group;
          decide.appendChild(head);
        }
        var row = document.createElement('div'); row.className = 'decide-line';
        // The label is shown, clipped by CSS to fit; the whole text is copied.
        var code = document.createElement('code'); code.textContent = line.label; code.title = line.label;
        var copy = document.createElement('button');
        copy.type = 'button'; copy.className = 'decide-copy'; copy.textContent = 'Copy';
        copy.setAttribute('aria-label', 'Copy: ' + line.label);
        copy.dataset.copy = line.text;
        copy.dataset.label = line.label;
        row.appendChild(code); row.appendChild(copy); decide.appendChild(row);
      });
    }
    document.getElementById('d-who').textContent = el.dataset.who || 'Nobody recorded.';
    // A done task reads as done here too.
    document.getElementById('d-text').classList.toggle('done', el.dataset.done === '1');
    showHistory(el.dataset.history ? JSON.parse(el.dataset.history) : null);
    // One sentence and a way in, instead of the list of records that govern it.
    var ws = el.dataset.ws || '';
    var ctx = document.getElementById('d-ctx');
    ctx.hidden = queued || !(ws && document.getElementById('dp-ws-' + ws));
    ctx.dataset.panel = 'dp-ws-' + ws;
    var scoped = forScope(ws ? 'ws:' + ws : 'project');
    // A waiting item is decided, not asked about, and only an assistant that is
    // connected to teamctx can approve anything, so it has one prompt and no
    // paste mode.
    assistFor(queued);
    current = queued
      ? { short: el.dataset.prompt, full: el.dataset.prompt }
      : {
        short: el.dataset.prompt,
        full: scoped.full + '\\n---\\n' + (el.dataset.ask || '') + '\\nAnswer in plain language, from the context above only.\\n'
      };
    showPrompt();
    reveal();
  }
  function openPanel(id, from) {
    var panel = document.getElementById(id);
    if (!panel) return;
    if (from) opener = from;
    taskView.hidden = true;
    assistFor(false);
    panels.forEach(function (p) { p.hidden = p !== panel; });
    // The button under an empty part asks for help with its tasks; every other way
    // in is just to read the part's context.
    var forTasks = !!(from && from.dataset && from.dataset.intent === 'tasks');
    var scoped = forScope(panel.dataset.scope);
    document.getElementById('d-kind').textContent = panel.dataset.title + (forTasks ? ' · New tasks' : '');
    panel.querySelectorAll('[data-for="tasks"]').forEach(function (n) { n.hidden = !forTasks; });
    current = forTasks && scoped.tasks ? scoped.tasks : scoped;
    showPrompt();
    reveal();
  }
  function close() {
    drawer.classList.remove('open'); backdrop.classList.remove('on');
    drawer.setAttribute('aria-hidden', 'true');
    if (opener && opener.focus) opener.focus();
  }
  document.querySelectorAll('.item, .q').forEach(function (el) {
    el.addEventListener('click', function () { open(el); });
  });
  // The eye reads a waiting item; the other icon opens it at the decision. Either
  // way exactly one drawer opens, and focus returns to the icon that opened it.
  document.querySelectorAll('.qicon').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      open(b.closest('.q'));
      opener = b;
      if (b.dataset.open === 'review') {
        var at = document.getElementById('d-decide-title');
        if (at && at.scrollIntoView) at.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
  document.querySelectorAll('[data-panel]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPanel(el.dataset.panel, el); });
  });
  document.getElementById('d-ctx-open').addEventListener('click', function () {
    openPanel(document.getElementById('d-ctx').dataset.panel);
  });
  backdrop.addEventListener('click', close);
  document.getElementById('d-close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  document.querySelectorAll('input[name="amode"]').forEach(function (r) { r.addEventListener('change', showPrompt); });
  // The clipboard API does not exist on a plain-http deployment, and the failure
  // is silent unless it is caught: the button appears to do nothing. The fallback
  // is a hidden field and the browser's own copy command.
  var toText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var field = document.createElement('textarea');
      field.value = text; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.appendChild(field); field.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(field);
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  };
  var say = function (message) {
    var toast = document.getElementById('toast');
    toast.textContent = message;
    setTimeout(function () { if (toast.textContent === message) toast.textContent = ''; }, 3500);
  };
  document.querySelectorAll('.chatico').forEach(function (b) {
    // A click on the inner SVG lands here too, because the listener is on the button.
    b.addEventListener('click', function () {
      var plan = assistantPlan(b.dataset.go, mode(), current);
      var go = function () { if (plan.open) window.open(plan.open, '_blank', 'noopener'); if (plan.toast) say(plan.toast); };
      if (!plan.copy) { go(); return; }
      toText(plan.copy).then(go, function () { say('Could not copy. Open "See the prompt first" and copy it from there.'); });
    });
  });
  // One listener for the Decide lines, which are rebuilt on every opening.
  document.getElementById('d-decide').addEventListener('click', function (e) {
    var b = e.target.closest('.decide-copy');
    if (!b) return;
    // Said on the button: the drawer's message line sits below the fold when
    // Decide is on screen, so a copy there went unconfirmed.
    toText(b.dataset.copy).then(function () {
      say('Copied: ' + b.dataset.label);
      b.textContent = 'Copied';
      setTimeout(function () { b.textContent = 'Copy'; }, 2000);
    }, function () { say('Could not copy. Select the line and copy it by hand.'); });
  });
  // Shared rows carry the text and prompt for their drawer.
  var statement = document.querySelector('.marked[data-prompt]');
  var row = document.querySelector('.marked');
  if (row) row.scrollIntoView({ block: 'center' });
  if (statement) open(statement);
  // The goal and why share three lines. Measured after fonts load and on resize,
  // so it holds at phone width; without JavaScript the CSS clamp (2 and 1) stands.
  var block = document.getElementById('goal-block');
  if (block) {
    var goal = block.querySelector('.goal-text');
    var why = block.querySelector('.goal-why');
    var whyLinesLeft = ${whyLinesLeft.toString()};
    var fit = function () {
      goal.style.webkitLineClamp = 'none';
      var lh = parseFloat(getComputedStyle(goal).lineHeight);
      var lines = Math.max(1, Math.round(goal.getBoundingClientRect().height / lh));
      goal.style.webkitLineClamp = String(Math.min(2, lines));
      if (why) why.style.webkitLineClamp = String(whyLinesLeft(lines));
    };
    fit();
    window.addEventListener('resize', fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  }
  // The left column is as tall as the screen allows from where it starts, so
  // Settings is on screen at first load and while scrolling. Recomputed on
  // scroll, resize and when fonts load; one column under 900px, where it is not
  // pinned at all.
  var rail = document.querySelector('.layout > aside');
  if (rail) {
    var wide = window.matchMedia('(min-width: 901px)');
    var fitRail = function () {
      if (!wide.matches) { rail.style.maxHeight = ''; return; }
      var top = Math.max(rail.getBoundingClientRect().top, 12);
      rail.style.maxHeight = Math.max(260, window.innerHeight - top - 12) + 'px';
    };
    fitRail();
    window.addEventListener('scroll', fitRail, { passive: true });
    window.addEventListener('resize', fitRail);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitRail);
  }
  // Copy the full address, never the shortened text. The clipboard API does not
  // exist on a plain-http page or an old browser, so there is a fallback that
  // uses a hidden field and the browser's own copy command.
  var copyUrl = document.querySelector('.copy-url');
  if (copyUrl) {
    var copyText = function (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      return new Promise(function (resolve, reject) {
        var field = document.createElement('textarea');
        field.value = text; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.appendChild(field); field.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(field);
        if (ok) resolve(); else reject(new Error('copy failed'));
      });
    };
    copyUrl.addEventListener('click', function () {
      var b = this;
      copyText(b.dataset.url).then(function () {
        b.classList.add('done');
        setTimeout(function () { b.classList.remove('done'); }, 1600);
      }, function () { b.title = 'Could not copy: select the address and copy it'; });
    });
  }
}());`;

export const projectPage = ({ user, view, selected, item = null, note = null, origin = null, history = false }) => {
  const base = `/project/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}`;
  // The page is the work and what is waiting; the tree says which part of it.
  const { main, selected: shown } = workHtml({ view, selected, item, history, origin, base });

  // The one thing a person needs to start working with an assistant: its address.
  // Read-only text beside a copy button, never an input: a box would say it can be
  // edited. The team lines are counts for now; each joins as its data reaches the page.
  const people = (view.members || []).length;
  const agents = (view.agents || []).length;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const settings = (origin || people || agents) ? (() => {
    const parts = { origin, owner: view.owner, repo: view.repo };
    const full = origin ? mcpUrl(parts) : '';
    return `<section class="settings" aria-label="Settings">
      <div class="section-title">Settings</div>
      ${origin ? `<div class="mcp-row">
        <span class="mcp-url" id="mcp-url" title="${esc(full)}" aria-describedby="mcp-help">${esc(shortMcpUrl(parts))}</span>
        <button type="button" class="copy-url" data-url="${esc(full)}" aria-label="Copy the MCP URL" title="Copy the MCP URL">
          <svg class="ico-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>
          <svg class="ico-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </button>
      </div>
      <span class="sr-only" id="mcp-help">Add this as a custom connector in Claude, ChatGPT or Copilot</span>` : ''}
      ${people ? `<p class="stline">${plural(people, 'team member')}</p>` : ''}
      ${agents ? `<p class="stline">${plural(agents, 'agent')}</p>` : ''}
    </section>`;
  })() : '';

  return shell(view.project || `${view.owner}/${view.repo}`, `
${navBar({ user, current: '/projects' })}
<p class="crumb"><a href="/projects">← All projects</a></p>
<h1>${esc(view.project || `${view.owner}/${view.repo}`)}${view.isManager
    ? ' <span class="role-chip">Manager</span>'
    : ''}</h1>
${view.projectTree?.goal?.text ? `<div class="goal-block" id="goal-block"><div class="goal-copy"><p class="goal-text">${esc(view.projectTree.goal.text)}</p>${view.projectTree.goal.why ? `<p class="goal-why">${esc(view.projectTree.goal.why)}</p>` : ''}</div>${ctxButton('dp-project', 'Read the full goal and why it matters')}</div>` : ''}
${note ? `<p class="note">${esc(note)}</p>` : ''}

<div class="layout">
  <aside>
    <div class="rail-work">
      <div class="section-title">The work</div>
      ${treeHtml({ view, selected: shown, base })}
    </div>
    ${settings}
  </aside>

  <main id="panel">
    ${main}
  </main>
</div>

<div class="backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <div class="drawer-head">
    <span class="section-title" id="d-kind" style="margin:0"></span>
    <button class="ghost" id="d-close" aria-label="Close">✕</button>
  </div>
  <div class="drawer-body">
    <div id="d-task">
      <p class="statement" id="d-text"></p>
      <p class="stale-note" id="d-review" style="display:none"></p>
      <p class="ctxline" id="d-ctx" hidden>Your assistant reads the approved context for this task. <button type="button" class="linkbtn" id="d-ctx-open">See the context</button></p>
      <div class="section-title">Summary</div>
      <p id="d-summary"></p>
      <div class="section-title">Who wrote it</div>
      <p id="d-who"></p>
      <div id="d-history-wrap" hidden>
        <div class="section-title">History</div>
        <p class="hstatus" id="d-history-status"></p>
        <button type="button" class="linkbtn" id="d-history-earlier" hidden></button>
        <ul class="plain history" id="d-history"></ul>
      </div>
      <div id="d-queue" hidden>
        <div class="section-title" id="d-changes-title">What it would change</div>
        <ul class="plain" id="d-changes"></ul>
        <div id="d-checks-wrap" hidden>
          <div class="section-title">Check against what is already approved</div>
          <ul class="plain" id="d-checks"></ul>
        </div>
        <div class="section-title" id="d-decide-title">Decide</div>
        <p class="approving" id="d-approving" hidden></p>
        <div class="decide" id="d-decide"></div>
      </div>
    </div>
    ${panelsHtml({ view, onDay: today() })}
    ${assistantBlockHtml()}
  </div>
</aside>
<script type="application/json" id="prompts">${JSON.stringify(drawerPrompts({ view, onDay: today() })).replace(/</g, '\\u003c')}</script>`, { wide: true, extraCss: CSS, script: SCRIPT });
};
