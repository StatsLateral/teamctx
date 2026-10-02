import { esc } from './theme.js';

/** Small form pieces the settings and new-project pages share. */
/**
 * Pick a project rather than spell one.
 *
 * Falls back to a text field when the listing failed or is empty — a dropdown
 * with nothing in it is worse than the field it replaced.
 */
export const PROVIDER_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };
export const providerLabel = id => PROVIDER_LABELS[id] || id || 'Anthropic';

export const providerSelect = (id, name) => `<label for="${id}">Provider</label>
  <select id="${id}" name="${name}">
    ${Object.entries(PROVIDER_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
  </select>`;

export const projectPicker = (id, repos, { name = 'project', value = '' } = {}) => (repos.length
  // A `select` only jumps to the first letter, so finding one repo among
  // dozens means scrolling. A datalist narrows the list as you type, and still
  // accepts a name that is not in it — which matters, since the listing is
  // capped and can miss one. How much of the name a browser will match is the
  // browser's business, so whatever uses this should also be able to search
  // server-side; see the projects page.
  ? `<input list="${id}-list" id="${id}" name="${name}" value="${esc(value)}"
           placeholder="Type to search, or paste owner/repo" autocomplete="off" required>
     <datalist id="${id}-list">
       ${repos.map(r => `<option value="${esc(r.fullName)}"></option>`).join('')}
     </datalist>`
  : `<input id="${id}" name="${name}" value="${esc(value)}" placeholder="owner/repo" required>`);
