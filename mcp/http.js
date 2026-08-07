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
  await session.prefetch();

  await runWithSession(session, async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // The MCP server itself doesn't care about the backend; storage dispatch
    // sees the session in async context and routes reads/writes to it.
    const server = buildServer({ __backend: 'github', ...projectContext });
    await server.connect(transport);

    const body = await readJsonBody(req);
    await transport.handleRequest(req, res, body);
  });
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
