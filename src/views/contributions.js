import { esc, navBar, shell } from './theme.js';

/**
 * Everything the project has been sent, newest first.
 *
 * One flat list, grouped one of two ways: by day, or by who sent it. Groups run
 * newest first as well — a day by its date, a person by their latest
 * contribution — so the top of the page is always the most recent thing that
 * happened, whichever way it is cut.
 */

const EXTRA_CSS = `
.seg { display: inline-flex; border: 1px solid var(--border, rgba(127,127,127,.35)); border-radius: 8px; overflow: hidden; margin: .4rem 0 1rem; }
.seg a { padding: .35rem .9rem; text-decoration: none; font-size: .92rem; }
.seg a[aria-current="true"] { font-weight: 600; background: rgba(127,127,127,.16); }
.cgroup h2 { font-size: 1rem; margin: 1.6rem 0 .5rem; }
.cgroup .n { font-weight: 400; }
.citem { border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 8px; padding: .6rem .8rem; margin: 0 0 .5rem; }
.citem .meta { font-size: .85rem; display: flex; flex-wrap: wrap; gap: .3rem .8rem; }
.citem p { margin: .4rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.st { font-weight: 600; }
`;

const LIMIT = 240;

const whenOf = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};
const dayOf = (iso) => (whenOf(iso) ? whenOf(iso).toISOString().slice(0, 10) : 'Undated');
const timeOf = (iso) => (whenOf(iso) ? `${whenOf(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');

/** Newest first, whichever way it is grouped. `by` is 'date' or 'person'. */
export function groupContributions(list, by) {
  const newest = [...list].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const groups = new Map();
  for (const c of newest) {
    const key = by === 'person' ? c.author : dayOf(c.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  // Insertion order is already newest first: each group opened with its latest item.
  return [...groups].map(([title, items]) => ({ title, items }));
}

const item = (c, by) => {
  const long = c.text.length > LIMIT;
  const body = long
    ? `<details><summary>${esc(c.text.slice(0, LIMIT))}…</summary><p>${esc(c.text)}</p></details>`
    : `<p>${esc(c.text)}</p>`;
  return `<div class="citem"><div class="meta muted">
    ${by === 'person' ? `<span>${esc(timeOf(c.at))}</span>` : `<strong>${esc(c.author)}</strong><span>${esc(timeOf(c.at).slice(11))}</span>`}
    <span>${esc(c.where)}</span><span class="st">${esc(c.status)}</span></div>${body}</div>`;
};

export const contributionsPage = ({ user, view, by = 'date' }) => {
  const group = by === 'person' ? 'person' : 'date';
  const base = `/project/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}`;
  const groups = groupContributions(view.contributions, group);
  const tab = (value, label) => `<a href="${base}/contributions?group=${value}"${group === value ? ' aria-current="true"' : ''}>${label}</a>`;
  return shell('All contributions', `
${navBar({ user, current: '/projects' })}
<p class="crumb"><a href="${base}">← ${esc(view.project || `${view.owner}/${view.repo}`)}</a></p>
<h1>All contributions</h1>
<p class="muted">Everything sent to this project, latest first. ${view.contributions.length} in all.</p>
<div class="seg" role="group" aria-label="Group by">${tab('date', 'By date')}${tab('person', 'By contributor')}</div>
${groups.length ? groups.map(g => `<section class="cgroup"><h2>${esc(g.title)} <span class="n muted">· ${g.items.length}</span></h2>${g.items.map(c => item(c, group)).join('')}</section>`).join('')
    : '<p class="muted">Nothing has been contributed yet.</p>'}`, { extraCss: EXTRA_CSS });
};
