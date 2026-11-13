/**
 * Making a failed connect diagnosable (#285).
 *
 * Connecting teamctx from Claude is the step every new member goes through, and
 * when it fails it fails silently: the OAuth endpoints come from the MCP SDK's
 * `mcpAuthRouter`, so a `/token` 400 (a stale code → `invalid_grant`, a bad
 * client → `invalid_client`) goes back to the client with nothing on the server
 * to explain it. This gives every failed OAuth or MCP request one log line with
 * the reason and a short id, and hands that id back to the client so a stuck
 * member can quote it.
 *
 * The one rule: **never log a secret.** Not the token, the authorization code,
 * the client secret, an email or any header value — only the response's own
 * error *code* (`invalid_grant`, `unauthorized`, …), which the SDK and our own
 * handlers already chose to send the client, plus the HTTP status and the step.
 */
import { randomBytes } from 'node:crypto';

/**
 * A short, random id for one request. Tied to nothing personal — it exists only
 * to join the line a member sees to the line in the log. `req_` + 10 hex.
 */
export function newRequestId() {
  return `req_${randomBytes(5).toString('hex')}`;
}

/**
 * One line for a failed connect, or nothing when it did not fail.
 *
 * `code` is the machine error code from the response body (never free text that
 * might carry input back), and is omitted when there was none. A 2xx/3xx logs
 * nothing: a healthy handshake — including the spec's 405 on `GET /api/mcp` — is
 * not a failure and must not look like one in the log.
 */
export function logConnectFailure({ step, status, code = null, requestId }) {
  if (!Number.isInteger(status) || status < 400) return;
  console.warn(
    `connect: ${step} failed (${status}${code ? ` ${code}` : ''})`
    + (requestId ? ` [${requestId}]` : ''),
  );
}

/**
 * The error code from an OAuth/JSON error body, if it looks like one. Only the
 * `error` field (a code such as `invalid_grant`) is read — never
 * `error_description`, which is the one place input could be echoed back.
 */
export function errorCodeOf(body) {
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    return body.error.slice(0, 64);
  }
  return null;
}
