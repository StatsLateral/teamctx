import { esc, navBar, shell } from './theme.js';

/**
 * One record's trail (#265): what it said over time, who changed it, who
 * approved it, and the records it replaced or that replaced it.
 *
 * Built for the manager who weeks later asks "what did this say when we started,
 * what changed, and who agreed to it?" — the versions read oldest → newest so
 * the page is the story in order, with the current wording last and marked.
 */

const EXTRA_CSS = `
.rh-head { font-size: .9rem; color: var(--muted, #777); margin: 0 0 .3rem; }
.rh-chain { font-size: .9rem; margin: .2rem 0; }
.rh-chain a { text-decoration: none; }
.ver { border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 8px; padding: .7rem .9rem; margin: 0 0 .7rem; }
.ver.now { border-color: var(--accent, #4a7); border-width: 2px; }
.ver .meta { font-size: .85rem; color: var(--muted, #777); display: flex; flex-wrap: wrap; gap: .3rem .8rem; }
.ver .vtext { margin: .4rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-display); }
.ver .vdetail { margin: .35rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted, #777); }
.rh-foot { font-size: .9rem; color: var(--muted, #777); margin: 1.2rem 0 0; }
`;

const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');
const who = (name) => esc(name || 'someone');

/** A link to another record's trail, when it is one we can point at. */
const chainLink = (owner, repo, rec, label) => {
  if (!rec) return '';
  const text = rec.text ? ` — “${esc(rec.text.slice(0, 80))}”` : '';
  return `<p class="rh-chain">${label} <a href="/project/${esc(owner)}/${esc(repo)}/record/${esc(rec.id)}">${esc(rec.id)}</a>${text}</p>`;
};

export const recordHistoryPage = ({ user, view }) => {
  const { owner, repo, project, trail } = view;
  const versions = trail.versions.map((v, i) => `
<div class="ver${v.current ? ' now' : ''}">
  <div class="meta"><span>Version ${i + 1}${v.current ? ' · current' : ''}</span><span>${esc(day(v.at))}</span><span>by ${who(v.by)}</span></div>
  <p class="vtext">${esc(v.text)}</p>
  ${v.detail ? `<p class="vdetail">${esc(v.detail)}</p>` : ''}
</div>`).join('');

  return shell('Record history', `
${navBar({ user, current: `/project/${owner}/${repo}` })}
<style>${EXTRA_CSS}</style>
<p class="rh-head"><a href="/project/${esc(owner)}/${esc(repo)}">${esc(project || `${owner}/${repo}`)}</a></p>
<h1>${esc(trail.type)} · <span class="muted">${esc(trail.status)}</span></h1>
${chainLink(owner, repo, trail.replaces, 'Replaced')}
${chainLink(owner, repo, trail.replacedBy, 'Replaced by')}

<h2>History</h2>
${versions || '<p class="muted">No versions recorded.</p>'}

<p class="rh-foot">Created ${esc(day(trail.created.at))} by ${who(trail.created.by)}${
  trail.approved ? ` · Approved ${esc(day(trail.approved.at))} by ${who(trail.approved.by)}` : ''}.</p>
`);
};
