import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request AI key store.
 *
 * On the local CLI, keys come from `.env.local` / `process.env` — this
 * store stays empty and callers fall back to `process.env.ANTHROPIC_API_KEY`.
 *
 * On the hosted MCP, each request may carry its own caller-supplied key via
 * URL / header. `runWithAiKey` puts the caller's key into an AsyncLocalStorage
 * context so `getRequestAiKey()` returns it for anything the request runs,
 * without ever mutating `process.env` (safe for concurrent requests).
 *
 * A request with no key of its own can be given `resolve` instead: a function
 * that works the key out the first time a model is actually called. The project
 * key a request falls back to depends on who the primary manager is, which is in
 * the project's config — and that config is only in hand once the request's
 * session has loaded it. Resolving lazily means no extra fetch, and no work at
 * all for the many tool calls that never reach a model.
 */
const store = new AsyncLocalStorage();

export function runWithAiKey(apiKey, fn, provider = null, resolve = null) {
  return store.run({ apiKey, provider, resolve, resolved: undefined }, fn);
}

function current() {
  const s = store.getStore();
  if (!s) return null;
  if (s.apiKey) return { apiKey: s.apiKey, provider: s.provider };
  if (!s.resolve) return null;
  if (s.resolved === undefined) {
    // Once per request. A resolver that throws leaves the caller with no key,
    // which surfaces as the ordinary "no key configured" message rather than an
    // error about something the caller never asked for.
    try { s.resolved = s.resolve() || null; } catch { s.resolved = null; }
  }
  return s.resolved;
}

export function getRequestAiKey() {
  return current()?.apiKey || null;
}

/**
 * The provider the caller's key belongs to, when known. A key is useless
 * against the wrong provider, so this has to travel with it rather than being
 * read from the project's shared config.
 */
export function getRequestAiProvider() {
  return current()?.provider || null;
}
