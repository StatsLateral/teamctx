import { esc, navBar, shell } from './theme.js';

/**
 * Signing in: the screen the product's every "Sign in" leads to, and the one
 * the connector shows when an assistant asks who you are.
 */
export const lendsNothing = (project) => `${project} has not lent GitHub access, which is how `
  + 'somebody without a GitHub account reaches it. Its manager can turn that on from their '
  + 'settings page.';
/**
 * The two ways in, said the same way wherever they are offered.
 *
 * GitHub first, because it is the one the manager needs. Google is always on
 * the page: when it cannot be used it is greyed out with the reason beneath it,
 * because a button that is simply missing looks like a broken deployment and
 * tells nobody what to fix.
 */
export const waysInCards = ({ github, google, googleWhy }) => `
<section class="card">
<h2>Continue with GitHub</h2>
<p class="muted">For the manager, and anyone who works in the repository. Sign in
with the GitHub account that can see it.</p>
<p><a class="btn" href="${github}">Continue with GitHub</a></p>
</section>

<section class="card">
<h2>Continue with Google</h2>
<p class="muted">For anyone invited to the project by email, with no GitHub
account. Sign in with that same address — another one is not recognised.</p>
${google
    ? `<p><a class="btn" href="${google}">Continue with Google</a></p>`
    : `<p><span class="btn off" aria-disabled="true">Continue with Google</span></p>
<p class="muted">${esc(googleWhy || 'Google sign-in is not available here.')}</p>`}
</section>`;
export const choosePage = ({ state, project = null, google = true, lends = true }) => shell('Connect', `
<h1>Connect${project ? ` to ${esc(project)}` : ' to teamctx'}</h1>
<p>Sign in so teamctx knows who you are. It is how your work is attributed, and
what decides which part of the project you see.</p>

${waysInCards({
    github: `/oauth/choose/github?state=${encodeURIComponent(state)}`,
    google: google ? `/oauth/choose/google?state=${encodeURIComponent(state)}` : null,
    googleWhy: lends
      ? 'Google sign-in is not set up on this deployment.'
      : lendsNothing(project || 'This project'),
  })}`);
export const signInPage = ({ returnTo = null, ways = { google: true, why: null } } = {}) => {
  // Carried through the provider and back, so signing in returns somebody to
  // the page that asked for it rather than dropping them on settings.
  const back = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
  return shell('Sign in', `
${navBar({ user: null, current: '/signin' })}
<h1>Sign in</h1>
<p>Sign in so teamctx knows who you are. It is how your work is attributed, and
what decides which part of a project you see.</p>
${waysInCards({
    github: `/settings/signin${back}`,
    google: ways.google ? `/settings/signin/google${back}` : null,
    googleWhy: ways.why,
  })}
<p class="muted">Both reach the same saved keys, and the same projects, when they
carry the same address.</p>
<p class="muted">GitHub will not prompt you again if you have already
authorised teamctx. To sign in as a different account, revoke teamctx under
<a href="https://github.com/settings/applications" target="_blank" rel="noreferrer">GitHub &rarr; Authorized OAuth Apps</a> first.</p>`);
};

/**
 * What somebody sees who opens a connector address in a browser.
 *
 * The address is for pasting into an assistant, which reaches it by POST; a
 * browser's GET has nothing to show. So the page says what it is, shows it to
 * copy, and links to the project page, which is the thing a person can open.
 */
export const connectorAddressPage = ({ address, projectUrl, project }) => shell('Connector address', `
${navBar({ user: null, current: '/signin' })}
<h1>This is a connector address</h1>
<p>It is not a web page, so there is nothing to see here. It is what you paste into your
assistant to connect it to <strong>${esc(project)}</strong>.</p>
<section class="card">
<h2>Paste it into your assistant</h2>
<p class="muted">In Claude, ChatGPT or Copilot, add a <strong>custom connector</strong> and paste this
address. When it asks you to sign in, use the email you were invited with.</p>
<p><code id="addr">${esc(address)}</code></p>
<p><button type="button" class="btn" id="copy">Copy the address</button> <span class="muted" id="copied" role="status"></span></p>
</section>
<section class="card">
<h2>Or look at the project in your browser</h2>
<p class="muted">Sign in with the same email to read the project's goal, work and team.</p>
<p><a class="btn" href="${esc(projectUrl)}">Open the project</a></p>
</section>`, {
  script: `(function(){var b=document.getElementById('copy'),s=document.getElementById('copied'),t=document.getElementById('addr').textContent;
b.addEventListener('click',function(){var done=function(){s.textContent='Copied.'};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){s.textContent='Select the address and copy it.'});}
else{s.textContent='Select the address and copy it.';}});}());`,
});
