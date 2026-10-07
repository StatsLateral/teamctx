/**
 * What each assistant button does, as a decision the page script and the tests
 * both run.
 *
 * Two prompts exist for everything on the page. The short one asks an assistant
 * that is connected to teamctx to fetch the approved context itself, so no
 * context travels in a URL and it is always the latest the person may see. The
 * full one carries the context inline, for an assistant that is not connected.
 *
 *   Claude   `claude.ai/new?q=` prefills the input. Connected mode sends the short
 *            prompt in the link; paste mode copies the full prompt (too long for a
 *            URL, which Claude caps) and opens an empty chat to paste it into.
 *   ChatGPT  `chatgpt.com/?q=` likewise.
 *   Copilot  cannot be prefilled by link, so it always copies first, then opens.
 *   Copy     always the full prompt: it works in any chatbot.
 *
 * Only the assistants' own query formats are used, and the link carries only
 * teamctx's own text, never page or user content beyond what the person sees.
 * `assistantPlan` is self-contained on purpose: the page script is built from
 * its source, so the browser and the tests run the same function.
 *
 * Returns `{ copy?, open?, toast? }`: text to put on the clipboard first, the
 * address to open, and what to tell the person.
 */
export const assistantPlan = (kind, mode, prompts) => {
  const paste = mode === 'paste';
  const text = paste ? prompts.full : prompts.short;
  if (kind === 'claude') {
    return paste
      ? { copy: prompts.full, open: 'https://claude.ai/new', toast: 'Prompt copied. Paste it into Claude.' }
      : { open: `https://claude.ai/new?q=${encodeURIComponent(prompts.short)}` };
  }
  if (kind === 'chatgpt') {
    return paste
      ? { copy: prompts.full, open: 'https://chatgpt.com/', toast: 'Prompt copied. Paste it into ChatGPT.' }
      : { open: `https://chatgpt.com/?q=${encodeURIComponent(prompts.short)}` };
  }
  if (kind === 'copilot') {
    return { copy: text, open: 'https://copilot.microsoft.com/', toast: 'Prompt copied. Paste it into Copilot.' };
  }
  return { copy: prompts.full, toast: 'Prompt copied.' };
};
