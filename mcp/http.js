import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { GithubSession } from '../src/adapters/github.js';
import { runWithSession } from '../src/session-context.js';

/**
 * Handle a single MCP HTTP request against a GitHub-backed teamctx project.
 *
 *   1. Build a GithubSession from the request's project context.
 *   2. `await session.prefetch()` — load all `.teamctx/**` into memory.
 *   3. Run the MCP tool inside `runWithSession(session, ...)` so all
 *      storage calls hit the in-memory buffer instead of the filesystem.
 *   4. `session.commit(...)` is called from inside the tool via
 *      `commitContext(msg)` (see src/git.js). One tool call → one commit.
 *
 * projectContext shape: { __backend:'github', owner, repo, ref?, ghToken }
 */
export async function handleMcpHttp(req, res, projectContext) {
  const session = new GithubSession({
    owner: projectContext.owner,
    repo: projectContext.repo,
    ref: projectContext.ref || null,
    ghToken: projectContext.ghToken,
  });

  const body = await readJsonBody(req);
  // Only a tool call reads the project. `initialize`, `tools/list`, `ping` and the
  // notifications depend on nothing in the repository (the tool list differs only
  // for an agent), so they are answered without asking GitHub for anything. A
  // connector can always connect and list its tools; if the person's GitHub access
  // is the problem, the first tool call says so, instead of the whole server
  // looking dead, which is how a client reads a 500 on its first request.
  const messages = Array.isArray(body) ? body : [body];
  if (messages.some(m => m?.method === 'tools/call')) {
    try {
      await session.prefetch();
    } catch (error) {
      return refuseToolCalls(res, messages, explainGithubFailure(error, projectContext));
    }
  }

  await runWithSession(session, async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // The MCP server itself doesn't care about the backend; storage dispatch
    // sees the session in async context and routes reads/writes to it.
    const server = buildServer({ __backend: 'github', ...projectContext });
    await server.connect(transport);

    await transport.handleRequest(req, res, body);
  });
}

/**
 * Why GitHub would not let this person read the project, in words they can act
 * on. Only the status and GitHub's own short message are used, never the token.
 */
export function explainGithubFailure(error, { owner, repo }) {
  const text = String(error?.message || '');
  const status = Number(/→\s*(\d{3})/.exec(text)?.[1]) || null;
  const what = `${owner}/${repo}`;
  if (status === 401) {
    return `GitHub rejected the sign-in teamctx holds for you (it has expired or been revoked), so ${what} could not be read. Disconnect and connect this server again.`;
  }
  if (status === 403) {
    return `GitHub refused access to ${what} for the account you signed in with. If ${owner} is an organization, it may restrict third-party apps or require SAML single sign-on: ask an owner to approve the teamctx OAuth app, or connect again with an account that can read the repository.`;
  }
  if (status === 404) {
    return `${what} was not found, or the account you signed in with cannot see it (GitHub answers 404 for a private repository the account has no access to). Check the repository name, or connect again with an account that can read it.`;
  }
  const detail = /\{"message":"([^"]{1,160})/.exec(text)?.[1];
  return `teamctx could not read ${what} from GitHub${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}. Try again in a moment; if it keeps happening, connect this server again.`;
}

/**
 * Answer a request that needed the project when the project could not be read:
 * a tool call gets a normal tool error carrying the reason, which a client shows
 * the person; anything else in the same request gets a JSON-RPC error; a
 * notification gets nothing.
 */
function refuseToolCalls(res, messages, reason) {
  const replies = messages.filter(m => m && m.id !== undefined && m.method).map(m => (m.method === 'tools/call'
    ? { jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: reason }] } }
    : { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: reason } }));
  if (!replies.length) { res.statusCode = 202; res.end(); return; }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(replies.length === 1 && messages.length === 1 ? replies[0] : replies));
}

async function readJsonBody(req) {
  if (req.body !== undefined) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try { return JSON.parse(raw); }
  catch { return raw; }
}
