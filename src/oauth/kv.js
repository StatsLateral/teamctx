/**
 * Tiny KV abstraction for the hosted OAuth layer.
 *
 * Talks the Upstash Redis REST protocol over plain `fetch` — which is also
 * exactly what Vercel KV exposes — so we add no npm dependency. Falls back
 * to an in-process Map when no KV is configured, which keeps local dev and
 * the test suite working without any external service.
 *
 * Env vars (either pair works):
 *   KV_REST_API_URL / KV_REST_API_TOKEN            ← Vercel KV
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN ← Upstash direct
 */

function restConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function isPersistent(env = process.env) {
  return restConfig(env) !== null;
}

// --- in-memory fallback -------------------------------------------------

const memory = new Map();          // key -> { value, expiresAt|null }

function memGet(key) {
  const rec = memory.get(key);
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    memory.delete(key);
    return null;
  }
  return rec.value;
}

function memSet(key, value, ttlSeconds) {
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

/** Test helper — wipe the in-memory store between cases. */
export function __resetMemory() {
  memory.clear();
}

// --- REST transport -----------------------------------------------------

async function restCommand(cfg, command) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`kv ${command[0]} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.result;
}

// --- public API ---------------------------------------------------------

/** Read a JSON value. Returns null when absent or expired. */
export async function kvGet(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) return memGet(key);
  const raw = await restCommand(cfg, ['GET', key]);
  if (raw === null || raw === undefined) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return raw; }
}

/** Write a JSON value, optionally with a TTL in seconds. */
export async function kvSet(key, value, { ttlSeconds } = {}, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) return memSet(key, value, ttlSeconds);
  const payload = JSON.stringify(value);
  const cmd = ttlSeconds
    ? ['SET', key, payload, 'EX', String(ttlSeconds)]
    : ['SET', key, payload];
  await restCommand(cfg, cmd);
}

export async function kvDelete(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) { memory.delete(key); return; }
  await restCommand(cfg, ['DEL', key]);
}

/**
 * Delete every key matching a glob pattern, skipping any whose name starts with
 * `excludePrefix`, and return how many were removed.
 *
 * For one-off maintenance only (the legacy-token purge), never a request path:
 * it pages through the whole keyspace. In memory it filters the Map; against
 * Redis it uses SCAN so it never blocks the server the way KEYS would. The
 * exclusion lets the legacy purge match `oauth:token:*` yet keep the live
 * `oauth:token:v2:*` records.
 */
export async function kvScanDelete(pattern, { excludePrefix } = {}, env = process.env) {
  const keep = k => excludePrefix && k.startsWith(excludePrefix);
  const cfg = restConfig(env);
  if (!cfg) {
    const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, m => (m === '*' ? '.*' : '\\' + m)) + '$');
    let n = 0;
    for (const key of [...memory.keys()]) if (re.test(key) && !keep(key)) { memory.delete(key); n++; }
    return n;
  }
  let cursor = '0';
  let removed = 0;
  do {
    const [next, batch] = await restCommand(cfg, ['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']);
    cursor = next;
    const doomed = Array.isArray(batch) ? batch.filter(k => !keep(k)) : [];
    if (doomed.length) {
      await restCommand(cfg, ['DEL', ...doomed]);
      removed += doomed.length;
    }
  } while (cursor !== '0');
  return removed;
}

/**
 * Add one to a counter and return the new count, atomically.
 *
 * A read followed by a write lets two concurrent callers read the same count
 * and both go under a limit. `INCR` is one step in Redis; the expiry is set when
 * the counter is first created, so it lasts from its first use.
 */
export async function kvIncr(key, { ttlSeconds } = {}, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) {
    // In-memory: read and write happen in one synchronous turn.
    const current = Number(memGet(key) || 0) + 1;
    const rec = memory.get(key);
    memory.set(key, { value: current, expiresAt: rec?.expiresAt ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : null) });
    return current;
  }
  const count = Number(await restCommand(cfg, ['INCR', key]));
  if (count === 1 && ttlSeconds) await restCommand(cfg, ['EXPIRE', key, String(ttlSeconds)]);
  return count;
}

/**
 * Read-and-delete. Used for one-shot artefacts (authorization codes,
 * pending-authorization state) so they can't be replayed.
 */
export async function kvTake(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) {
    // In-memory: read and delete happen in one synchronous turn, so no
    // interleaving is possible.
    const value = memGet(key);
    if (value !== null) memory.delete(key);
    return value;
  }
  // GETDEL is a single round trip, so two concurrent exchanges of the same
  // code cannot both see it. Redis < 6.2 lacks the command — fall back to the
  // non-atomic pair rather than failing the request outright.
  let raw;
  try {
    raw = await restCommand(cfg, ['GETDEL', key]);
  } catch {
    const value = await kvGet(key, env);
    if (value !== null) await kvDelete(key, env);
    return value;
  }
  if (raw === null || raw === undefined) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return raw; }
}

// --- key namespaces -----------------------------------------------------
// Kept in one place so the shape of what we persist is easy to audit.

/**
 * The lookup name for a project, case-folded.
 *
 * A project-level entry is written from what the manager types into a form and
 * read from what is in the request URL. GitHub treats those as the same
 * repository whatever the case; a string key does not. So `Acme/Ledger` typed
 * on the settings page stored something `acme/ledger` in a connector URL would
 * never find — and the failure looked like the setting had simply not been
 * saved.
 */
const slug = (owner, repo) => `${String(owner || '').toLowerCase()}/${String(repo || '').toLowerCase()}`;

export const keys = {
  /** DCR-registered OAuth client. Long-lived. */
  client: id => `oauth:client:${id}`,
  /** In-flight /authorize state, consumed by the GitHub callback. 10 min. */
  pending: state => `oauth:pending:${state}`,
  /** Authorization code awaiting exchange at /token. 10 min, one-shot. */
  code: code => `oauth:code:${code}`,
  /**
   * Legacy access/refresh keys, under the raw token. No longer written or read
   * by the provider — kept only so the one-off purge script can find and delete
   * the records left from before hashing. Remove once the purge has run
   * everywhere and the TTLs behind it have expired.
   */
  token: token => `oauth:token:${token}`,
  refresh: token => `oauth:refresh:${token}`,
  /**
   * Access and refresh tokens, keyed by the SHA-256 of the token, never the
   * token itself: a read of the store hands nobody a working credential. The
   * `v2` prefix is a clean break, so a legacy record under the old key can never
   * be read by mistake. Payload carries the project it was issued for and the
   * sign-in family it belongs to.
   */
  tokenV2: hash => `oauth:token:v2:${hash}`,
  refreshV2: hash => `oauth:refresh:v2:${hash}`,
  /**
   * One sign-in's token family: `{ access, refresh, revoked }`, the hashes of
   * its current pair. Revoking any token, or replaying a used refresh token,
   * revokes the whole family. TTL tracks the refresh token.
   */
  tokenFamily: id => `oauth:family:${id}`,
  // A sign-in's revocation marker. Written once by a revoke and never overwritten
  // by a rotation, which is what lets a rotation in flight see it.
  familyRevoked: id => `oauth:family-revoked:${id}`,
  /**
   * Tombstone for a refresh token that has already been rotated away, value is
   * its family id. A later presentation of the same token is replay: it is
   * refused and the family is revoked. TTL tracks the refresh token.
   */
  usedRefresh: hash => `oauth:used:${hash}`,
  /**
   * Everything needed to mint a code once the user approves, stashed while the
   * consent page is shown. One-shot, short-lived: the browser is sent to the
   * page with this token and it is consumed when they decide.
   */
  consentPending: token => `oauth:consent-pending:${token}`,
  /**
   * A standing approval: this signed-in person has let this client, for this
   * redirect origin, in before, so the consent page is skipped next time. Keyed
   * by the hash of the subject so the store never names who approved what.
   */
  consentApproval: (subjectHash, clientId, origin) => `oauth:consent:${subjectHash}:${clientId}:${origin}`,
  /** Per-user AI provider key, set via the settings page. Long-lived. */
  aiKey: githubUserId => `teamctx:aikey:${githubUserId}`,
  /**
   * A key the manager shares with everyone on one project. Most team members
   * never have a provider key of their own — a lot of them never have a GitHub
   * account either, and reach the project only through an agent — so without
   * this the model-backed tools are unusable for all but the person who set the
   * project up. Falls back to, never overrides, a member's own key. Long-lived.
   */
  projectAiKey: (owner, repo) => `teamctx:aikey:project:${slug(owner, repo)}`,
  /** Which projects one user shares a key with, so the settings page can show them. */
  sharedProjects: githubUserId => `teamctx:aikey:shared-by:${githubUserId}`,
  /**
   * A person's own AI key, by verified email. Replaces `aiKey`, which is keyed
   * by GitHub id and so could not be found by the same person signing in with
   * Google. The GitHub-id record is still read as a fallback — see ai-keys.js.
   */
  personalAiKey: email => `teamctx:aikey:email:${String(email).toLowerCase()}`,
  /**
   * The GitHub accounts an address has proved it owns.
   *
   * Written only when GitHub itself hands us a verified primary address for the
   * account signing in, which is the only moment the two can honestly be tied
   * together. Long-lived: it is an identity, not a session.
   */
  githubIdentities: email => `teamctx:ghids:${String(email).toLowerCase()}`,
  /**
   * Every project key added to one project: one per person, by the email of
   * whoever added it. Replaces the single `projectAiKey` record, which let the
   * first person to share block everyone else. A request runs on the primary
   * manager's entry — see ai-keys.js.
   */
  projectAiKeys: (owner, repo) => `teamctx:aikey:project-keys:${slug(owner, repo)}`,
  /** Which projects one person has added a key to, by email, for the settings page. */
  keysAddedBy: email => `teamctx:aikey:added-by:${String(email).toLowerCase()}`,
  /**
   * A GitHub credential the project lends to members who have none of their
   * own. Keyed by the repository it serves and looked up by the owner/repo in
   * the request URL, so it can only ever act on the project it was stored for.
   */
  /**
   * Whether a repository still exists, as last asked of GitHub *on behalf of one
   * person*. Per person because the answer depends on whose token asked: a private
   * repository answers 404 to somebody it will not show it to, and one person's
   * "gone" must never hide the project from a colleague who can see it. Short-lived.
   */
  repoState: (viewer, owner, repo) => `teamctx:repo-state:${String(viewer).toLowerCase()}:${slug(owner, repo)}`,
  projectGhCred: (owner, repo) => `teamctx:ghcred:project:${slug(owner, repo)}`,
  /** Which projects one user lends GitHub access to, for the settings page. */
  lentProjects: githubUserId => `teamctx:ghcred:lent-by:${githubUserId}`,
  /**
   * The same list by address, so somebody who lent access while signed in with
   * GitHub still sees it — and can withdraw it — when they sign in with Google.
   */
  lentByAddress: email => `teamctx:ghcred:lent-by-email:${String(email).toLowerCase()}`,
  /**
   * Projects an address has connected to through the connector with a Google
   * sign-in. A Google account has no repository list, so without this the
   * settings page could offer them nothing to pick.
   */
  connectedProjects: email => `teamctx:connected:${String(email).toLowerCase()}`,
  /**
   * Per-user, per-project settings (display name, active workstream). These are
   * personal, so they deliberately live here rather than in the repo's
   * config.json — see src/prefs.js. Long-lived.
   */
  prefs: (actorKey, owner, repo) => `teamctx:prefs:${actorKey}:${owner}/${repo}`,
  /**
   * An agent token, by the SHA-256 of the token. The token itself is shown to
   * the manager once and never stored, so a read of the store hands nobody a
   * working credential. Long-lived, until revoked.
   */
  agentToken: hash => `teamctx:agent:token:${hash}`,
  /** The agents issued for one project, for listing and revoking. */
  projectAgents: (owner, repo) => `teamctx:agent:project:${slug(owner, repo)}`,
  /** Projects this address has issued an agent for, so the page can list them. */
  agentsIssuedBy: email => `teamctx:agent:issued-by:${String(email).toLowerCase()}`,
  /**
   * An agent's own AI key, set by a manager, and when the provider last rejected
   * it. Kept apart from the token record so nothing that lists agents can carry
   * the key along by accident. Long-lived, until cleared or the agent is revoked.
   */
  agentAiKey: id => `teamctx:agent:aikey:${id}`,
  /**
   * When an agent last made a request. Its own record, so noting it never
   * rewrites the token or the project's list — rewriting those on every request
   * raced a revoke and brought the token back. Long-lived.
   */
  agentLastUsed: id => `teamctx:agent:last-used:${id}`,
  /** How many contributions an agent has sent on one UTC day. 2 days. */
  agentDaily: (id, day) => `teamctx:agent:daily:${id}:${day}`,
  /**
   * A project's Slack incoming webhook (#182), set by a manager in Settings:
   * `{ url, setBy, setAt }`. A credential, so it lives here and never in the
   * repository; the page shows who set it and when, never the URL. Long-lived.
   */
  slackWebhook: (owner, repo) => `teamctx:slack:project:${slug(owner, repo)}`,
  /** Projects this address has set a Slack webhook on, so the page can list them. */
  slackSetBy: email => `teamctx:slack:set-by:${String(email).toLowerCase()}`,
  /** Browser session for the settings page. 1 hour. */
  session: sid => `teamctx:session:${sid}`,
};

export const TTL = {
  pending: 10 * 60,          // 10 min — user is mid-consent
  code: 10 * 60,             // 10 min — RFC 6749 says ≤10 min
  accessToken: 60 * 60,      // 1 hour — Claude refreshes reactively on 401
  client: 30 * 24 * 60 * 60, // 30 days from last use — abandoned DCR clients lapse
  consentApproval: 90 * 24 * 60 * 60, // 90 days — a remembered client approval
  // 30-day idle: each rotation writes a fresh 30-day token, so a connection in
  // use never expires, but one left unused for 30 days does. Shorter than the
  // old 90 days to narrow the window a stolen refresh token is useful for.
  refreshToken: 30 * 24 * 60 * 60,
  session: 60 * 60,
};
