import { esc } from './theme.js';
import { contextGroups } from '../prompts.js';
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
    <div class="section-title">Context for this part of the work</div>
    ${groups || '<p class="muted">Nothing has been decided for this part of the work yet.</p>'}
    <p class="muted">The project context also applies.</p>
  </section>`;
}

/** One panel for the project and one for each workstream the reader can see. */
export function panelsHtml({ view, onDay }) {
  return [projectPanel(view, onDay), ...(view.workstreams || []).map(w => workstreamPanel(view, w, onDay))].join('\n');
}

const button = (go, label, title, icon) => `<button type="button" class="chatico" data-go="${go}" aria-label="${esc(label)}" title="${esc(title)}">${icon}</button>`;

/**
 * Open in Claude, ChatGPT or Copilot, or copy the prompt: one compact row, every
 * control a real button with its own name. What each does is `assistantPlan`.
 */
export function assistantBlockHtml() {
  return `<section class="assist" aria-label="Work on this in your assistant">
    <div class="section-title">Ask in your assistant</div>
    <div class="amode" role="radiogroup" aria-label="How your assistant gets the context">
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
