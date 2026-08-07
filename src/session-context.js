import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request GitHub session store.
 *
 * Local (CLI) mode: this store stays empty; callers fall back to the
 * filesystem storage path.
 *
 * Hosted (MCP over HTTP) mode: the HTTP handler creates a GithubSession,
 * prefetches all .teamctx/** files, and runs the tool handler inside
 * `runWithSession(session, fn)`. Any storage call inside `fn` (or anything
 * it awaits) sees the session via `getCurrentSession()` and dispatches to
 * the in-memory session buffer instead of the filesystem.
 */
const store = new AsyncLocalStorage();

export function runWithSession(session, fn) {
  return store.run({ session }, fn);
}

export function getCurrentSession() {
  return store.getStore()?.session || null;
}
