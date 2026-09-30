import { projectPicker, providerLabel, providerSelect } from './form-bits.js';
import { esc, navBar, shell } from './theme.js';

/**
 * The settings page: keys, the projects they are shared with, lent access and
 * agents. Moved here whole from the routes file — see src/views/theme.js.
 */
export const settingsPage = ({
  user, hasKey, saved, error, confirmRemove = null, shared = [], lent = [], repos = [], agents = [], newAgent = null,
}) => shell('Settings', `
${navBar({ user, current: '/settings' })}
<h1>Settings</h1>
${saved ? '<div class="ok">Saved.</div>' : ''}
${error ? `<div class="bad">${esc(error)}</div>` : ''}
${confirmRemove ? `<div class="bad">
<p><strong>${esc(confirmRemove)} runs on this key.</strong> You are its primary manager, so
anyone on it without a key of their own will lose the model as soon as it is removed.
To stop paying without that, hand the primary role to someone else first.</p>
<form method="POST" action="/settings/unshare" style="margin:.35rem 0">
  <input type="hidden" name="project" value="${esc(confirmRemove)}">
  <input type="hidden" name="confirm" value="1">
  <button type="submit">Remove it anyway</button>
  <a href="/settings">Keep it</a>
</form>
</div>` : ''}
${newAgent ? `<div class="ok">
<p><strong>${esc(newAgent.name)} can now reach ${esc(newAgent.project)}.</strong> Copy its
token now — it is not shown again, and it is not stored anywhere it can be read back.</p>
<label for="newAgentToken">Token</label>
<input id="newAgentToken" type="text" readonly value="${esc(newAgent.token)}" onfocus="this.select()">
<label for="newAgentUrl">Connector URL</label>
<input id="newAgentUrl" type="text" readonly value="${esc(newAgent.url)}" onfocus="this.select()">
<p class="muted">Send requests to the URL with <code>Authorization: Bearer &lt;token&gt;</code>.</p>
</div>` : ''}

<div class="cols">
<section class="card">
<h2>Your AI key</h2>
<p class="muted">Used only by the tools that call a model. Stored against your
email address, so it is yours whether you sign in with GitHub or Google. Never
written to your repo.</p>
<form method="POST" action="/settings">
  <label for="provider">Provider</label>
  <select id="provider" name="provider">
    <option value="anthropic">Anthropic</option>
    <option value="openai">OpenAI</option>
    <option value="gemini">Google Gemini</option>
  </select>
  <label for="apiKey">API key${hasKey ? ' (a key is already saved — entering one replaces it)' : ''}</label>
  <input id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" required>
  <button type="submit">Save</button>
</form>

</section>

<section class="card">
<h2>Add a key to a project</h2>
<p class="muted">Open to anyone on the project. The project runs on its primary
manager's key for anyone who has no key of their own, never overriding someone's
own. Yours is used while you are its primary manager, and you pay for what the
project spends while it is.</p>
${shared.length ? `<p class="muted">You have added a key to:</p>${shared.map(slug => `
<form method="POST" action="/settings/unshare" style="margin:.35rem 0">
  <input type="hidden" name="project" value="${esc(slug)}">
  <code>${esc(slug)}</code>
  <button type="submit" class="link">Remove my key</button>
</form>`).join('')}` : ''}
<form method="POST" action="/settings/share">
  <label for="project">Project</label>
  ${projectPicker('project', repos)}
${hasKey ? `
  <label style="font-weight:400;margin-top:1rem">
    <input type="checkbox" name="useMyKey" value="1" checked
           onchange="document.getElementById('shareKeyFields').hidden = this.checked"
           style="width:auto;margin-right:.4rem">
    Share the key I already saved above
  </label>
  <p class="muted">A provider shows a key once. If you no longer have it to hand,
  this is the way to share it.</p>` : ''}
  <div id="shareKeyFields"${hasKey ? ' hidden' : ''}>
    <label for="shareProvider">Provider</label>
    <select id="shareProvider" name="provider">
      <option value="anthropic">Anthropic</option>
      <option value="openai">OpenAI</option>
      <option value="gemini">Google Gemini</option>
    </select>
    <label for="shareKey">API key to share</label>
    <input id="shareKey" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…">
  </div>
  <button type="submit">Add to project</button>
</form>

</section>

<section class="card">
<h2>Let members join without GitHub</h2>
<p class="muted">Lets people on the roster sign in with Google instead of GitHub,
using the email you invited. Their work is committed under their own name and
still comes to you for review. Roster only, this repository only.</p>
${lent.length ? `<p class="muted">Lending access to:</p>${lent.map(slug => `
<form method="POST" action="/settings/unlend" style="margin:.35rem 0">
  <input type="hidden" name="project" value="${esc(slug)}">
  <code>${esc(slug)}</code>
  <button type="submit" class="link">Stop lending</button>
</form>`).join('')}` : ''}
${user.id ? `<form method="POST" action="/settings/lend">
  <label for="lendProject">Project</label>
  ${projectPicker('lendProject', repos)}
  <button type="submit">Lend GitHub access</button>
</form>` : `<p class="muted">Lending GitHub access needs a GitHub sign-in: it hands the
project a GitHub credential, which a Google sign-in does not have.</p>`}
</section>

<section class="card">
<h2>Agents</h2>
<p class="muted">A token for a job that runs with nobody present. An agent can read
what it is assigned, send work for review, and close its own tasks — nothing else.
Its work always waits for a manager's approval, it sends at most 20 contributions a
day, and it reads through the GitHub access the project lends. It runs on its own AI
key if you give it one, and on the project key otherwise. Managers only.</p>
${agents.map(group => `<p class="muted"><code>${esc(group.project)}</code></p>${group.agents.map(a => `
<div style="margin:.5rem 0 .9rem">
  ${esc(a.name)} <span class="muted">— issued by ${esc(a.issuedBy)} on ${esc(String(a.createdAt).slice(0, 10))},
  ${a.lastUsedAt ? `last used ${esc(String(a.lastUsedAt).slice(0, 10))}` : 'never used'}</span>
  <div class="muted">Runs on ${a.key
    ? `its own ${esc(providerLabel(a.key.provider))} key, set by ${esc(a.key.setBy || 'a manager')} on ${esc(String(a.key.setAt).slice(0, 10))}`
    : 'the project key'}.</div>
  ${a.key?.failedAt ? `<div class="bad">${esc(providerLabel(a.key.provider))} rejected its own key on
  ${esc(String(a.key.failedAt).slice(0, 10))}, so it ran on the project key. Replace the key, or put it on the project key.</div>` : ''}
  <details>
    <summary class="muted">${a.key ? 'Change its key' : 'Give it its own key'}</summary>
    <form method="POST" action="/settings/agents/key">
      <input type="hidden" name="project" value="${esc(group.project)}">
      <input type="hidden" name="id" value="${esc(a.id)}">
      ${providerSelect(`agentKeyProvider-${esc(a.id)}`, 'provider')}
      <label for="agentKey-${esc(a.id)}">API key</label>
      <input id="agentKey-${esc(a.id)}" name="apiKey" type="password" autocomplete="off" required>
      <button type="submit">Save key</button>
    </form>
    ${a.key ? `<form method="POST" action="/settings/agents/key">
      <input type="hidden" name="project" value="${esc(group.project)}">
      <input type="hidden" name="id" value="${esc(a.id)}">
      <input type="hidden" name="clear" value="1">
      <button type="submit" class="link">Put it on the project key</button>
    </form>` : ''}
  </details>
  <form method="POST" action="/settings/agents/revoke" style="margin:.2rem 0">
    <input type="hidden" name="project" value="${esc(group.project)}">
    <input type="hidden" name="id" value="${esc(a.id)}">
    <button type="submit" class="link">Revoke</button>
  </form>
</div>`).join('')}`).join('')}
<form method="POST" action="/settings/agents">
  <label for="agentProject">Project</label>
  ${projectPicker('agentProject', repos)}
  <label for="agentName">Name</label>
  <input id="agentName" name="agentName" placeholder="Nightly report" maxlength="60" required>
  <label for="agentWorkstreams">Workstreams (optional)</label>
  <input id="agentWorkstreams" name="agentWorkstreams" placeholder="pricing, onboarding — leave empty for the whole project">
  <p class="muted">Give it work by assigning tasks to this name.</p>
  ${providerSelect('agentProvider', 'agentProvider')}
  <label for="agentApiKey">Its own AI key (optional)</label>
  <input id="agentApiKey" name="agentApiKey" type="password" autocomplete="off" placeholder="Leave empty to run on the project key">
  <p class="muted">If the provider ever rejects it, the agent runs on the project key and this page says so.</p>
  <button type="submit">Create agent</button>
</form>
</section>
</div>`, { wide: true });
