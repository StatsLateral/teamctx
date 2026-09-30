import { esc, navBar, shell } from './theme.js';

/** Somewhere for a first-time visitor to land. */
export const homePage = ({ user, projects = [] }) => shell('teamctx', `
${navBar({ user, current: '/' })}
<h1>teamctx</h1>
<p>Version control for the context behind your team's work: <strong>why</strong>
you decided something, <strong>what</strong> that requires, and <strong>how</strong>
it gets done. Kept in your own git repository, and handed to each person's AI
assistant as the slice their role needs. Nothing to install. Nobody has to learn
a new tool.</p>

<h2 style="font-size:1rem;margin-top:2rem">How it works</h2>
<ol style="line-height:1.9;padding-left:1.2rem">
  <li><strong>Sign in with GitHub.</strong> Only the person setting the project
    up needs an account.</li>
  <li><strong>Point it at a project.</strong> Create a new private repository,
    or use one you already have.</li>
  <li><strong>Add your AI key.</strong> One key. Share it with the project and
    your team can use it too.</li>
  <li><strong>Connect your assistant.</strong> Paste one URL into Claude,
    ChatGPT or whatever you use.</li>
  <li><strong>Invite your team.</strong> They sign in with Google and start
    working — no GitHub account needed.</li>
</ol>

<p>From there it is a loop, not a setup wizard: your team pulls the current
context and their tasks, sends work back, and you review it on your own
cadence.</p>

<p class="actions">
  <a class="btn" href="${!user ? '/signin' : user.id ? '/settings/new-project' : '/settings'}">${!user ? 'Start here' : user.id ? 'Create a new project' : 'Settings'}</a>
</p>
${user ? '' : '<p class="muted">Signing in creates nothing on its own — you choose the project on the next screen.</p>'}
${user && projects.length ? `
<h2 style="font-size:1rem;margin-top:2rem">Your projects</h2>
<p class="muted">Keys and access are set per project, all from one page.</p>
<ul style="line-height:1.9;padding-left:1.2rem">
  ${projects.map(p => `<li><code>${esc(p)}</code></li>`).join('')}
</ul>` : ''}
${user ? `<p class="muted" style="margin-top:2rem">Signed in as <strong>${esc(user.login || user.email || '')}</strong>.</p>` : ''}`);
