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

export const projectPicker = (id, repos) => (repos.length
  // A `select` only jumps to the first letter, so finding one repo among
  // dozens means scrolling. A datalist filters on any part of what you type,
  // and still accepts a name that is not in the list — which matters, since the
  // listing is capped and can miss one.
  ? `<input list="${id}-list" id="${id}" name="project" placeholder="Type to search, or paste owner/repo"
           autocomplete="off" required>
     <datalist id="${id}-list">
       ${repos.map(r => `<option value="${esc(r.fullName)}">`).join('')}
     </datalist>`
  : `<input id="${id}" name="project" placeholder="owner/repo" required>`);
