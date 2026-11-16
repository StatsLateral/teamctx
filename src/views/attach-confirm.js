import { navBar, shell, esc } from './theme.js';

/**
 * The upload looked like it held a secret (#252). Rather than a dead-end error,
 * the page says what was found and offers an explicit "attach anyway". The file
 * bytes are not kept on the server across the refusal, so the person re-chooses
 * the file and ticks the box; the form then posts with the override set. The
 * title and note they already typed ride along as hidden fields so they are not
 * retyped.
 */
export const attachConfirmPage = ({ owner, repo, taskId, findings = [], title = '', note = '', user = null }) => {
  const back = `/project/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?task=${encodeURIComponent(taskId)}`;
  const action = `/project/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/task/${encodeURIComponent(taskId)}/attach`;
  const list = findings
    .map(f => `<li>line ${f.line}: looks like a <strong>${esc(f.rule)}</strong> (<code>${esc(f.match)}</code>)</li>`)
    .join('');
  return shell('Possible secret in this file', `
${navBar({ user, current: null })}
<h1>This file looks like it contains a secret</h1>
<p>It was <strong>not</strong> attached. A file that is committed stays in the
repository's history even after the task or output is removed, so teamctx
stopped it here.</p>
<ul>${list}</ul>
<p>If this is real, <strong>rotate the credential</strong> — that is the real fix,
since anyone who has pulled the repository already has it.</p>
<p>If it is a false positive, choose the file again, tick the box and attach.</p>
<form method="POST" action="${action}" enctype="multipart/form-data" class="attachform">
  <input type="hidden" name="allow_secrets" value="1">
  <input type="hidden" name="title" value="${esc(title)}">
  <input type="hidden" name="note" value="${esc(note)}">
  <input type="file" name="file" required>
  <label style="display:block;margin:8px 0">
    <input type="checkbox" name="confirm_secret" required> I have checked these and want to attach anyway
  </label>
  <div class="attachrow">
    <button type="submit" class="attachbtn">Attach anyway</button>
    <a href="${back}" class="hint">Cancel</a>
  </div>
</form>`);
};
