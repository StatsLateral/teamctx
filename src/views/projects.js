import { esc, navBar, shell } from './theme.js';

/** The projects somebody can open. */
export const projectsPage = ({ user, projects }) => shell('Projects', `
${navBar({ user, current: '/projects' })}
<h1>Your projects</h1>
${projects.length ? `<p class="muted">Where each one stands, without asking your assistant for it.</p>
<ul style="line-height:2;padding-left:1.2rem">
  ${projects.map(slug => `<li><a href="/project/${esc(slug)}">${esc(slug)}</a></li>`).join('')}
</ul>` : `<p class="muted">Nothing here yet. A project appears once you connect to it,
add a key to it, or lend it GitHub access.</p>`}`);
