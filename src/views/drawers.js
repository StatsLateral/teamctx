import { esc } from './theme.js';
import { contextGroups } from '../prompts.js';
import { SAMPLE_SOURCES, ISSUES_URL } from './sources-sample.js';
import { CLAUDE_ICON, CHATGPT_ICON, COPILOT_ICON, COPY_ICON } from './assistant-icons.js';

/**
 * The right-hand drawer's bodies for a level of the project, and the assistant
 * block every drawer carries.
 *
 * The project's and a workstream's context are not listed on the page. They are
 * read through the person's assistant, and these panels are the plain-English
 * view of the same thing: wording only, no numbers or ids, grouped under plain
 * headings, with an exception always shown under the rule it bends.
 */

const one = (item, { exceptions = [], note = '' } = {}) => `<li>${esc(item.text)}${note}${
  item.detail ? `<span class="why-line">Why: ${esc(item.detail)}</span>` : ''}${
  item.flag ? `<span class="needs-line">${esc(item.flag)}</span>` : ''}${
  exceptions.length ? `<ul>${exceptions.map(e => `<li class="exc">Allowed: ${esc(e.text)}${
    e.until ? ` <span class="until">(until ${esc(e.until)})</span>` : ''}<span class="why-line">instead of the rule: ${esc(item.text)}</span></li>`).join('')}</ul>` : ''}</li>`;

function groupsHtml(groups) {
  const parts = [];
  if (groups.decided.length) parts.push(`<div class="cgroup"><h3>We decided</h3><ul>${groups.decided.map(d => one(d)).join('')}</ul></div>`);
  if (groups.rules.length) parts.push(`<div class="cgroup"><h3>Rules</h3><ul>${groups.rules.map(r => one(r, { exceptions: r.exceptions })).join('')}</ul></div>`);
  if (groups.assuming.length) parts.push(`<div class="cgroup"><h3>We're assuming</h3><ul>${groups.assuming.map(a => one(a, {
    note: a.checkBy ? ` <span class="until">(check by ${esc(a.checkBy)})</span>` : '' })).join('')}</ul></div>`);
  return parts.length ? parts.join('') : null;
}

/** The project's drawer body: the goal and why in full, then its own context. */
function projectPanel(view, onDay) {
  const goal = view.projectTree?.goal;
  const groups = groupsHtml(contextGroups(view.projectTree?.records, onDay));
  return `<section class="dpanel" id="dp-project" data-scope="project" data-title="Project · Summary and context" hidden>
    ${goal?.text ? `<p class="statement">${esc(goal.text)}</p>${goal.why ? `<p class="why-full">${esc(goal.why)}</p>` : ''}` : '<p class="muted">No goal yet.</p>'}
    <div class="section-title">Project context</div>
    ${groups || '<p class="muted">Nothing has been decided at the project level yet.</p>'}
  </section>`;
}

function workstreamPanel(view, w, onDay) {
  const groups = groupsHtml(contextGroups(view.trees?.[w.id]?.records, onDay));
  return `<section class="dpanel" id="dp-ws-${esc(w.id)}" data-scope="ws:${esc(w.id)}" data-title="Workstream ${esc(w.number ?? '')}" hidden>
    <p class="statement">${esc(w.name)}</p>
    <p class="tasknote" data-for="tasks" hidden>Your assistant will look at what this part of the work already has and suggest tasks for you to choose from. Nothing is added until you say so. Pick your assistant below.</p>
    <div class="section-title">Context for this part of the work</div>
    ${groups || '<p class="muted">Nothing has been decided for this part of the work yet.</p>'}
    <p class="muted">The project context also applies.</p>
  </section>`;
}

/**
 * What a person or agent reaches, in words. The parts the reader may see are named;
 * any beyond them are counted, never named.
 */
function reachOf(on, view) {
  if (!on?.length) return null;
  const names = new Map((view.workstreams || []).map(w => [w.id, w.name]));
  const seen = on.filter(id => names.has(id)).map(id => names.get(id));
  const hidden = on.length - seen.length;
  return [...seen, ...(hidden ? [`${hidden} more you cannot see`] : [])].join(', ');
}

const card = (chip, line) => `<div class="pcard">${chip}<p class="pline">${line}</p></div>`;

/** The team: people, agents, and people outside the team, each in a list of their own. */
function teamPanel(view) {
  const people = view.members || [];
  const regular = people.filter(m => !m.external);
  const external = people.filter(m => m.external);
  const agents = view.agents || [];
  const group = (title, items) => (items.length ? `<h3 class="tg">${title} · ${items.length}</h3>${items.join('')}` : '');
  const reach = (m) => { const r = reachOf(m.on, view); return r ? `Reaches ${esc(r)}` : 'Whole project'; };

  const team = regular.map(m => card(
    `<span class="chip">👤 ${esc(m.name)}</span>`,
    m.manager ? `Manager · ${m.on ? `reaches ${esc(reachOf(m.on, view))}` : 'whole project'}` : reach(m),
  ));
  const outside = external.map(m => card(`<span class="chip ext">🤝 ${esc(m.name)} · external</span>`, reach(m)));
  const bots = agents.map(a => {
    const r = reachOf(a.on, view);
    const added = a.addedAt ? `Added ${esc(a.addedAt)} · ${r ? `reaches ${esc(r)}` : 'whole project'}` : (r ? `Reaches ${esc(r)}` : 'Whole project');
    return card(`<span class="chip agent">🤖 ${esc(a.name)}</span>`, added);
  });

  const how = view.isManager
    ? '<p class="pnote">To add someone, or list them as external, tell your assistant: "Add Dana to this project", "Make Dana external".</p>'
    : '';
  return `<section class="dpanel" id="dp-team" data-scope="project" data-title="My Team" data-noassist hidden>
    ${group('Team members', team) || '<p class="muted">Nobody is on the roster yet.</p>'}
    ${group('Agents', bots)}
    ${group('External talent', outside)}
    ${how}
  </section>`;
}

/**
 * The connected sources, as a preview. It is sample data and says so first:
 * connectors are on the roadmap and open for anyone to build.
 */
function sourcesPanel() {
  const groups = SAMPLE_SOURCES.map(src => `<div class="srcgroup">
      <h3 class="tg"><span class="mark" aria-hidden="true">${esc(src.mark)}</span>${esc(src.name)} · ${src.items.length}</h3>
      <p class="muted">${esc(src.about)}</p>
      <ul class="srcitems">${src.items.map(it => `<li><strong>${esc(it.title)}</strong>
        <span class="m">${esc(it.meta)} · on ${it.tasks.map(t => `<span class="chip">${esc(t)}</span>`).join(' ')} · ${it.context} context item${it.context === 1 ? '' : 's'}</span></li>`).join('')}</ul>
    </div>`).join('');
  return `<section class="dpanel" id="dp-sources" data-scope="project" data-title="Connected sources" data-noassist hidden>
    <p class="notice"><strong>On the roadmap.</strong> Connecting your tools to teamctx is not built yet, and everything below is sample data showing where it is headed. Each connector is an open issue, and contributions are welcome: <a href="${ISSUES_URL}" target="_blank" rel="noopener">pick one up on GitHub</a>.</p>
    <p class="statement">What the project can draw on</p>
    <p class="muted">teamctx keeps links and short summaries, never copies of your files. Each app stays where it is; when a page changes, the summary here is refreshed. Detail is handled by your assistant or an agent, not shown here.</p>
    ${groups}
  </section>`;
}

/** One panel for the project and one for each workstream the reader can see, then the team and the sources. */
export function panelsHtml({ view, onDay }) {
  return [projectPanel(view, onDay), ...(view.workstreams || []).map(w => workstreamPanel(view, w, onDay)), teamPanel(view), sourcesPanel()].join('\n');
}

const button = (go, label, title, icon) => `<button type="button" class="chatico" data-go="${go}" aria-label="${esc(label)}" title="${esc(title)}">${icon}</button>`;

/**
 * Open in Claude, ChatGPT or Copilot, or copy the prompt: one compact row, every
 * control a real button with its own name. What each does is `assistantPlan`.
 */
export function assistantBlockHtml() {
  return `<section class="assist" id="d-assist" aria-label="Work on this in your assistant">
    <div class="section-title" id="d-assist-title">Ask in your assistant</div>
    <div class="amode" id="d-amode" role="radiogroup" aria-label="How your assistant gets the context">
      <label><input type="radio" name="amode" value="connected" checked> Assistant is connected to teamctx</label>
      <label><input type="radio" name="amode" value="paste"> Paste the context in</label>
    </div>
    <div class="chatrow">
      <span class="chatcap">Open in</span>
      ${button('claude', 'Open in Claude', 'Open in Claude', CLAUDE_ICON)}
      ${button('chatgpt', 'Open in ChatGPT', 'Open in ChatGPT', CHATGPT_ICON)}
      ${button('copilot', 'Copy the prompt, then open Copilot', 'Copy the prompt, then open Copilot', COPILOT_ICON)}
      <span class="chatdiv" aria-hidden="true"></span>
      ${button('copy', 'Copy full prompt', 'Copy the full prompt (works in any chatbot)', COPY_ICON)}
    </div>
    <p class="chatnote">Copilot cannot be prefilled by link, so its icon copies the prompt first.</p>
    <details class="peek">
      <summary>See the prompt first</summary>
      <pre id="d-prompt"></pre>
    </details>
    <p class="toast" id="toast" role="status" aria-live="polite"></p>
  </section>`;
}
