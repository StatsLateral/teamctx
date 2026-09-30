import { esc, navBar, shell } from './theme.js';

/** One page, three answers: what the parts are, what is open, what is waiting. */
/** One page, three answers: what the parts are, what is open, what is waiting. */
export const projectPage = ({ user, view }) => shell(view.project || 'Project', `
${navBar({ user, current: '/projects' })}
<p><a href="/projects">← All projects</a></p>
<h1>${esc(view.project || `${view.owner}/${view.repo}`)}</h1>
<p class="muted"><code>${esc(view.owner)}/${esc(view.repo)}</code> ·
${view.isManager ? 'you manage this project' : 'you are on this project'}${view.scopedTo ? ` · you see ${view.scopedTo.map(esc).join(', ')}` : ''}</p>

<div class="cols">
<section class="card">
<h2>The work</h2>
${view.workstreams.length ? `<table>
  <tr><th>Part</th><th>Who is on it</th><th>Goals</th></tr>
  ${view.workstreams.map(w => `<tr>
    <td>${esc(w.name)}</td>
    <td class="muted">${w.members.length ? w.members.map(esc).join(', ') : '—'}</td>
    <td class="muted">${w.whyCount}</td>
  </tr>`).join('')}
</table>` : `<p class="muted">This project has not been split into parts. Its context
holds ${view.projectWhys} goal${view.projectWhys === 1 ? '' : 's'}.</p>`}
${view.members.length ? `<p class="muted" style="margin-top:1rem">On the project:
${view.members.map(m => esc(m.name)).join(', ')}${view.agents.length ? `, and ${view.agents.map(a => esc(a.name)).join(', ')} (agents)` : ''}.</p>` : ''}
</section>

<section class="card">
<h2>Open tasks</h2>
${view.tasks.open.length ? `<table>
  <tr><th>Task</th><th>Who has it</th><th>Where</th></tr>
  ${view.tasks.open.map(t => `<tr>
    <td>${esc(t.title)}</td>
    <td class="muted">${t.owner ? esc(t.owner) : 'nobody yet'}</td>
    <td class="muted">${esc(t.where)}</td>
  </tr>`).join('')}
</table>` : '<p class="muted">Nothing open.</p>'}
${view.tasks.done.length ? `<p class="muted" style="margin-top:1rem">${view.tasks.done.length}
task${view.tasks.done.length === 1 ? '' : 's'} already done.</p>` : ''}
</section>

${view.pending ? `<section class="card">
<h2>Waiting on you</h2>
${view.pending.length ? `<p class="muted">Work your team has sent for review. Approve or reject it from your assistant, or with <code>teamctx review</code>.</p>
<table>
  <tr><th>From</th><th>What</th><th>Where</th></tr>
  ${view.pending.map(q => `<tr>
    <td>${esc(q.author)}</td>
    <td>${esc(q.summary || '(no summary)')}</td>
    <td class="muted">${esc(q.where)}</td>
  </tr>`).join('')}
</table>` : '<p class="muted">Nothing is waiting for review.</p>'}
</section>` : ''}
</div>`, { wide: true });

/**
 * The one screen somebody sees while connecting their AI client.
 *
 * Both ways in used to sit side by side under one question, with the difference
 * between them in small print underneath — so the manager, who needs GitHub,
 * had to read a footnote to find that out. Each choice now says who it is for
 * where it is made, and Google is not offered at all on a project that lends no
 * GitHub access, because it could only end in a refusal.
 */
