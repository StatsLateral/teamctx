import { navBar, shell } from './theme.js';

/** Something went wrong, said without a stack trace. */
export const errorPage = (message) => shell('Error', `
${navBar({ user: null, current: null })}
<h1>Something went wrong</h1>
<p>${String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
<p class="muted">Nothing was changed. <a href="/">Back to the start</a>.</p>`);
