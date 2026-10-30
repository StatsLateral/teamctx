import { navBar, shell } from './theme.js';

/**
 * Something went wrong, said without a stack trace. `user` is whoever is signed
 * in, when the page knows: without it the bar offered "Sign in" to somebody who
 * already was.
 */
export const errorPage = (message, { user = null } = {}) => shell('Error', `
${navBar({ user, current: null })}
<h1>Something went wrong</h1>
<p>${String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
<p class="muted">Nothing was changed. <a href="/">Back to the start</a>.</p>`);
