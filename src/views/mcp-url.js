/**
 * The address somebody pastes into their assistant to connect it to a project.
 *
 * It is an address, not a credential: the connector still signs the caller in
 * and applies their scope, so showing it grants nothing. Built the way the
 * agent-token screen builds it, from the allowlisted base URL for the request.
 */

/** `https://host/api/mcp/<owner>/<repo>`, each part encoded. */
export function mcpUrl({ origin, owner, repo }) {
  return `${origin}/api/mcp/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * `host/…/<owner>/<repo>`: what fits in a narrow column. A person copies this
 * rather than reads it, so the middle is dropped; the full address is what the
 * copy button copies and what the tooltip shows.
 */
export function shortMcpUrl({ origin, owner, repo }) {
  return `${new URL(origin).host}/…/${owner}/${repo}`;
}
