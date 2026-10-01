import { esc, navBar, shell } from './theme.js';
import { projectPicker } from './form-bits.js';

/**
 * Finding a project, and opening one that is not on the list yet.
 *
 * The list on its own assumed somebody was already on every project they would
 * ever open, which is true of nobody on their first day: the manager sends a
 * connector link, and this page had nowhere to put it.
 *
 * One box takes whatever they have — the name, that link, the repository on
 * GitHub, a link to a statement inside it. It is the same box as the settings
 * page's, deliberately: one way to name a project across the app.
 *
 * Typing anything that is not a reference searches instead, server-side, over
 * every repository they can reach. That is there because how much of a name a
 * browser's datalist will match is the browser's business — several match only
 * the start of it, so typing a repository's own name found nothing while the
 * owner's name found everything. A search we run ourselves matches either.
 *
 * There is deliberately no listing of every repository somebody can reach.
 * There were hundreds of them, and a page that opens with hundreds of lines of
 * things you did not ask about is a page you stop reading.
 */
export const projectsPage = ({
  user, projects, repos = [], typed = '', error = null, query = null, matches = [],
}) => shell('Projects', `
${navBar({ user, current: '/projects' })}
<h1>Your projects</h1>

${error ? `<div class="bad">${esc(error)}</div>` : ''}

<form class="find" method="POST" action="/projects">
  <label for="ref">Open a project</label>
  ${projectPicker('ref', repos, { name: 'ref', value: typed })}
  <button type="submit">Open</button>
</form>
<p class="muted" id="ref-help">A connector link, a GitHub link, a link to
something inside the project, or just <code>owner/repo</code> — any of them.
${user.login
    ? 'Type part of a name on its own to search the repositories you can reach.'
    : 'Paste the link your manager sent you. Opening it needs the project to have lent GitHub access and to have your address on it.'}</p>

${query ? (matches.length ? `<h2>Matching "${esc(query)}"</h2>
<ul class="suggests">
  ${matches.map(name => `<li><form method="POST" action="/projects">
    <input type="hidden" name="ref" value="${esc(name)}">
    <button type="submit" class="link">${esc(name)}</button>
  </form></li>`).join('')}
</ul>` : `<p class="muted">Nothing you can reach matches "${esc(query)}".
${user.login ? 'If somebody sent you a link to a project, paste that instead.' : ''}</p>`) : ''}

${projects.length ? `<h2>On your list</h2>
<p class="muted">Where each one stands, without asking your assistant for it.</p>
<ul style="line-height:2;padding-left:1.2rem">
  ${projects.map(slug => `<li><a href="/project/${esc(slug)}">${esc(slug)}</a></li>`).join('')}
</ul>` : `<p class="muted">Nothing on your list yet. A project lands here once you
open it, add a key to it, or lend it GitHub access.</p>`}`, { extraCss: CSS });

const CSS = `
.find{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.6rem;margin:1.2rem 0 .4rem}
.find label{display:block;width:100%;margin:0 0 .3rem;font-size:.85rem;color:var(--soft)}
.find input{flex:1 1 22rem;margin:0}
.find button{margin:0}
.suggests{list-style:none;padding:0;margin:.6rem 0 0;display:flex;flex-wrap:wrap;gap:.4rem}
.suggests form{margin:0}
.suggests button{font-family:var(--font-mono);font-size:.8rem;padding:.3rem .6rem;
  border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);cursor:pointer}
.suggests button:hover{border-color:var(--accent);color:var(--accent)}`;
