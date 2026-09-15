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
 *
 * A request that brings a key can also be given `fallback`: a resolver the key
 * moves to if the provider rejects the one it brought. Only an agent's request
 * has one — an agent's own key is set by a manager, and a manager would rather
 * the job ran on the project key than stopped. A person's own key never falls
 * back, because spending somebody else's key without asking is not a fix.
 */
const store = new AsyncLocalStorage();

export function runWithAiKey(apiKey, fn, provider = null, resolve = null, { fallback = null, onFallback = null } = {}) {
  return store.run({ apiKey, provider, resolve, resolved: undefined, fallback, onFallback }, fn);
}

/**
 * Did the provider refuse this key, rather than the request?
 *
 * Revoked, invalid, out of credit, over quota: a key in any of those states
 * will fail every call until somebody acts, so moving to another key is right.
 * A rate limit or an outage passes on its own, and moving the call would spend
 * somebody else's key for nothing.
 */
export function keyWasRejected(err) {
  const status = Number(err?.status ?? err?.statusCode);
  if (status === 401 || status === 403) return true;
  const text = [err?.message, err?.code, err?.type, err?.error?.type, err?.error?.error?.type, err?.error?.code]
    .filter(Boolean).join(' ').toLowerCase();
  return /insufficient_quota|credit balance|billing|api key not valid|invalid api key|invalid x-api-key|api_key_invalid|permission_denied|authentication_error/
    .test(text);
}

/**
 * Move this request off the key it brought, onto its fallback.
 *
 * Once per request: if the fallback is rejected too, that is the answer. Returns
 * whether it moved, so the caller knows whether a retry means anything.
 */
export function fallBackFromOwnKey() {
  const s = store.getStore();
  if (!s || !s.apiKey || !s.fallback) return false;
  s.apiKey = null;
  s.provider = null;
  s.resolve = s.fallback;
  s.resolved = undefined;
  s.fallback = null;
  try { s.onFallback?.(); } catch { /* recording the failure must not fail the call */ }
  return true;
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
