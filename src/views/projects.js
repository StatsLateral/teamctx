import { esc, navBar, shell } from './theme.js';

/**
 * Finding a project, and opening one that is not on the list yet.
 *
 * The list on its own assumed somebody was already on every project they would
 * ever open, which is true of nobody on their first day: the manager sends a
 * connector link, and this page had nowhere to put it. So one box takes whatever
 * they have — the name, that link, the GitHub page, a link to a statement — and
 * the suggestions underneath it are repositories they can already reach.
 *
 * It is a plain form on purpose. Typing filters the suggestions through the
 * browser's own datalist, and a value that is not in the list is still
 * submitted, which is the whole point: the list is capped, and somebody being
 * invited to a project is not on it.
 */
export const projectsPage = ({ user, projects, repos = [], typed = '', error = null }) => {
  const known = new Set(projects.map(p => String(p).toLowerCase()));
  // Only what is not already above. Suggesting a project that is one line up
  // makes the list look like it means something it does not.
  const suggestions = repos
    .map(r => r.fullName)
    .filter(name => name && !known.has(String(name).toLowerCase()));

  return shell('Projects', `
${navBar({ user, current: '/projects' })}
<h1>Your projects</h1>

${error ? `<div class="bad">${esc(error)}</div>` : ''}

<form class="find" method="POST" action="/projects">
  <label for="ref">Open a project</label>
  <input list="ref-list" id="ref" name="ref" value="${esc(typed)}" autocomplete="off" required
         placeholder="owner/repo, or paste the link you were sent"
         aria-describedby="ref-help">
  ${suggestions.length ? `<datalist id="ref-list">
    ${suggestions.map(name => `<option value="${esc(name)}"></option>`).join('')}
  </datalist>` : ''}
  <button type="submit">Open</button>
</form>
<p class="muted" id="ref-help">A connector link, a GitHub link, a link to
something inside the project, or just <code>owner/repo</code> — any of them.
${user.login
    ? 'You can open any project you can read on GitHub.'
    : 'Paste the link your manager sent you. Opening it needs the project to have lent GitHub access and to have your address on it.'}</p>

${projects.length ? `<h2>On your list</h2>
<p class="muted">Where each one stands, without asking your assistant for it.</p>
<ul style="line-height:2;padding-left:1.2rem">
  ${projects.map(slug => `<li><a href="/project/${esc(slug)}">${esc(slug)}</a></li>`).join('')}
</ul>` : `<p class="muted">Nothing on your list yet. A project lands here once you
open it, add a key to it, or lend it GitHub access.</p>`}

${suggestions.length ? `<h2>Repositories you can reach</h2>
<p class="muted">Not teamctx projects yet, necessarily — opening one tells you.
These are also the suggestions in the box above.</p>
<ul class="suggests">
  ${suggestions.slice(0, 40).map(name => `<li><form method="POST" action="/projects">
    <input type="hidden" name="ref" value="${esc(name)}">
    <button type="submit" class="link">${esc(name)}</button>
  </form></li>`).join('')}
</ul>` : ''}`, { extraCss: CSS });
};

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
