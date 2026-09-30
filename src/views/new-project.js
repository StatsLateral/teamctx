import { esc, navBar, shell } from './theme.js';

/** Making a project — and what to do when GitHub says the name is taken. */
export const newProjectPage = ({ user, orgs, projectName = '', orgLogin = '', error = null, suggestion = null, repos = [] }) => shell('New project', `
${navBar({ user, current: '/settings/new-project' })}
<h1>Create a new teamctx project</h1>
<p>Signed in as <strong>${esc(user.login)}</strong>. This creates a new private
GitHub repository and sets it up for teamctx — nothing to install, nothing to
type in a terminal.</p>
${error ? `<div class="bad">${esc(error)}</div>` : ''}
${suggestion ? `<p class="muted"><code>${esc(suggestion)}</code> is free — click to use it:
  <button type="button" class="link" onclick="document.getElementById('projectName').value='${esc(suggestion)}'">use ${esc(suggestion)}</button></p>` : ''}
<form method="POST" action="/settings/new-project">
  <label for="projectName">Project name</label>
  <input id="projectName" name="projectName" placeholder="Q3 GTM Strategy" value="${esc(projectName)}" required>
  <label for="orgLogin">Where should it live?</label>
  <select id="orgLogin" name="orgLogin">
    <option value="" ${orgLogin === '' ? 'selected' : ''}>Your personal account (${esc(user.login)})</option>
    ${orgs.map(o => `<option value="${esc(o.login)}" ${o.login === orgLogin ? 'selected' : ''}>${esc(o.login)}</option>`).join('')}
  </select>
  <p class="muted">The repository is created private. You can change that later from GitHub if you want.</p>
  <button type="submit">Create project</button>
</form>
${repos.length ? `
<h2 style="margin-top:2.5rem">Or use a repository you already have</h2>
<p class="muted">teamctx adds a <code>.teamctx/</code> directory to it and leaves
everything else alone.</p>
<form method="POST" action="/settings/new-project">
  <label for="existingRepo">Repository</label>
  <input list="existing-list" id="existingRepo" name="existingRepo"
         placeholder="Type to search, or paste owner/repo" autocomplete="off" required>
  <datalist id="existing-list">
    ${repos.map(r => `<option value="${esc(r.fullName)}">`).join('')}
  </datalist>
  <label for="existingName">Project name</label>
  <input id="existingName" name="projectName" placeholder="Q3 GTM Strategy" required>
  <button type="submit">Set it up</button>
</form>` : ''}`);

export const newProjectSuccessPage = ({ owner, repo, baseUrl }) => shell('Project created', `
${navBar({ user: null, current: null })}
<h1>Your project is ready</h1>
<p><code>${esc(owner)}/${esc(repo)}</code> was created on GitHub and initialized for teamctx.</p>
<label>Paste this into your AI client as a custom connector</label>
<input readonly value="${esc(baseUrl)}/api/mcp/${esc(owner)}/${esc(repo)}" onclick="this.select()">
<p class="muted">Claude: Settings → Connectors → Add custom connector. Then
approve the GitHub consent screen.</p>

<h2 style="margin-top:2.5rem">Then, in that chat</h2>
<ol style="line-height:1.9;padding-left:1.2rem">
  <li><strong>Tell it what the project is about.</strong> Paste from a
    conversation you have already had, if you have one — it does not need to be
    tidy, and you do not need to learn how teamctx stores it.</li>
  <li><strong>Ask it to turn that into tasks.</strong> It proposes the work; you
    keep what is right.</li>
  <li><strong>Invite whoever is doing it.</strong> By email — they sign in with
    Google, no GitHub account needed.</li>
  <li><strong>Review what comes back.</strong> Their work queues for you rather
    than landing, and you clear it on your own cadence.</li>
</ol>
<p class="muted">That last pair is the loop, not the end of setup: they keep
pulling the current context and sending work back, you keep reviewing.</p>

<p class="actions"><a class="btn" href="/settings">Add your AI key</a>
  <a href="/">Home</a></p>
<p class="muted">The model-backed tools need one. Share it with the project and
your team can use it too.</p>`);

export const newProjectRetryPage = ({ owner, repo, projectName, error }) => shell('Almost there', `
${navBar({ user: null, current: null })}
<h1>The repository was created, but setup didn't finish</h1>
<div class="bad">${esc(error)}</div>
<p><code>${esc(owner)}/${esc(repo)}</code> exists on GitHub. Try again — this
won't create a second repository.</p>
<form method="POST" action="/settings/new-project">
  <input type="hidden" name="repoOwner" value="${esc(owner)}">
  <input type="hidden" name="repoRepo" value="${esc(repo)}">
  <input type="hidden" name="projectName" value="${esc(projectName)}">
  <button type="submit">Try again</button>
</form>`);
