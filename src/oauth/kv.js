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

import { randomBytes } from 'crypto';
import { seal, open, isEnvelope, loadSecretKeys, activeKid } from './secret-box.js';

function restConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

// --- secrets at rest ----------------------------------------------------
// Keys whose value is a credential and must be encrypted before it leaves the
// process. A table-driven test checks every secret-bearing key builder matches
// one of these, so a new one cannot quietly store plaintext.
export const SECRET_PREFIXES = [
  'teamctx:aikey:',          // personal, project and shared AI provider keys
  'teamctx:agent:aikey:',    // an agent's AI key
  'teamctx:ghcred:project:', // a GitHub credential a project lends
  'teamctx:slack:project:',  // a Slack incoming-webhook URL
  'teamctx:connector:token:',// a per-user cloud-connector OAuth token
  'oauth:token:',            // access-token payloads (carry the GitHub token)
  'oauth:refresh:',          // refresh-token payloads
  'oauth:code:',             // authorization-code records (the GitHub branch carries the token)
  'oauth:consent-pending:',  // a sign-in held at the consent page (its code record carries the token)
  'teamctx:session:',        // web sessions (carry the GitHub token)
];

export function isSecretKey(key) {
  return SECRET_PREFIXES.some(p => String(key).startsWith(p));
}

/**
 * True when a usable encryption key is configured: an active kid that is present
 * in the key set. On a persistent deployment without one, writing a secret is
 * refused, so the startup check and the settings page use this to warn.
 */
export function secretsConfigured(env = process.env) {
  try {
    const kid = activeKid(env);
    return !!kid && !!loadSecretKeys(env)[kid];
  } catch {
    return false;   // malformed TEAMCTX_SECRET_KEYS counts as not configured
  }
}

// In dev and test there is no KV and no configured key: use a per-process
// ephemeral key so secrets still round-trip without any setup. A real
// (persistent) deployment with no key configured refuses to write — never
// plaintext.
let ephemeral = null;
function writeConfig(env = process.env) {
  const keys = loadSecretKeys(env);
  const kid = activeKid(env);
  if (kid && keys[kid]) return { keys, kid };
  if (restConfig(env)) return null;                 // persistent + no key → caller refuses
  if (!ephemeral) ephemeral = { keys: { dev: randomBytes(32) }, kid: 'dev' };
  return ephemeral;
}
function readKeys(env = process.env) {
  const keys = loadSecretKeys(env);
  if (Object.keys(keys).length) return keys;
  if (ephemeral && !restConfig(env)) return ephemeral.keys;
  return keys;
}

/** Decode a value read for a secret key: decrypt an envelope, flag legacy plaintext, drop on failure. */
function decodeSecret(key, value, env) {
  if (value === null || value === undefined || !isSecretKey(key)) return { value, legacy: false };
  if (isEnvelope(value)) {
    try { return { value: open(value, key, { keys: readKeys(env) }), legacy: false }; }
    catch (e) {
      // Wrong/removed key or tampered record: treat as absent, name the key never the value.
      console.warn(`teamctx: could not decrypt the secret at ${key}: ${e.message}`);
      return { value: null, legacy: false };
    }
  }
  return { value, legacy: true };   // a pre-encryption plaintext record
}

/** Test helper — forget the per-process ephemeral key. */
export function __resetSecrets() { ephemeral = null; }

/** Test helpers — reach the store beneath the secret layer, and dump it. */
export async function __rawSet(key, value, opts = {}, env = process.env) { return rawSet(key, value, opts, env); }
export async function __rawGet(key, env = process.env) { return rawGet(key, env); }
export function __dumpMemory() { return JSON.stringify([...memory.entries()]); }

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

/** Read a JSON value from the store, with no secret handling. */
async function rawGet(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) return memGet(key);
  const raw = await restCommand(cfg, ['GET', key]);
  if (raw === null || raw === undefined) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return raw; }
}

/** Write a JSON value to the store, with no secret handling. */
async function rawSet(key, value, { ttlSeconds } = {}, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) return memSet(key, value, ttlSeconds);
  const payload = JSON.stringify(value);
  const cmd = ttlSeconds
    ? ['SET', key, payload, 'EX', String(ttlSeconds)]
    : ['SET', key, payload];
  await restCommand(cfg, cmd);
}

/**
 * Remaining time-to-live in whole seconds, or null when the key has no expiry
 * or is gone. Used to carry a record's TTL across a re-write so a lazy upgrade
 * does not turn an expiring secret (an access token, a session) into a
 * permanent one.
 */
async function rawTtl(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) {
    const rec = memory.get(key);
    if (!rec || !rec.expiresAt) return null;
    const ms = rec.expiresAt - Date.now();
    return ms > 0 ? Math.ceil(ms / 1000) : null;
  }
  const pttl = await restCommand(cfg, ['PTTL', key]); // ms; -1 no expiry, -2 missing
  return (typeof pttl === 'number' && pttl > 0) ? Math.ceil(pttl / 1000) : null;
}

/**
 * Read a JSON value. Returns null when absent or expired. A secret key is
 * decrypted; a legacy plaintext secret is read and lazily re-written encrypted.
 */
export async function kvGet(key, env = process.env) {
  const raw = await rawGet(key, env);
  const { value, legacy } = decodeSecret(key, raw, env);
  if (legacy) {
    const cfg = writeConfig(env);
    if (cfg) {
      try {
        // Keep whatever life the plaintext record had left, so upgrading an
        // access token or a session in place does not make it immortal.
        const ttlSeconds = await rawTtl(key, env);
        await rawSet(key, seal(value, key, cfg), ttlSeconds ? { ttlSeconds } : {}, env);
      } catch { /* best effort upgrade */ }
    }
  }
  return value;
}

/**
 * Write a JSON value, optionally with a TTL. A secret key is encrypted first;
 * with no key configured on a real deployment the write is refused rather than
 * stored in the clear.
 */
export async function kvSet(key, value, opts = {}, env = process.env) {
  if (!isSecretKey(key)) return rawSet(key, value, opts, env);
  const cfg = writeConfig(env);
  if (!cfg) {
    throw new Error(`Refusing to store a secret at ${key} with no encryption key configured. `
      + 'Set TEAMCTX_SECRET_KEYS and TEAMCTX_SECRET_KEY_ACTIVE.');
  }
  return rawSet(key, seal(value, key, cfg), opts, env);
}

/** Explicit secret write/read, for callers that want to be unmistakable. Same behaviour as kvSet/kvGet on a secret key. */
export const kvSetSecret = kvSet;
export const kvGetSecret = kvGet;

export async function kvDelete(key, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) { memory.delete(key); return; }
  await restCommand(cfg, ['DEL', key]);
}

/**
 * Every key matching a glob pattern. For one-off maintenance scripts only
 * (encrypting and rotating secrets), never a request path: it pages the whole
 * keyspace. In memory it filters the Map; against Redis it uses SCAN.
 */
export async function kvScanKeys(pattern, env = process.env) {
  const cfg = restConfig(env);
  if (!cfg) {
    const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, m => (m === '*' ? '.*' : '\\' + m)) + '$');
    return [...memory.keys()].filter(k => re.test(k));
  }
  const found = [];
  let cursor = '0';
  do {
    const [next, batch] = await restCommand(cfg, ['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']);
    cursor = next;
    if (Array.isArray(batch)) found.push(...batch);
  } while (cursor !== '0');
  return found;
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
  let raw;
  if (!cfg) {
    // In-memory: read and delete happen in one synchronous turn, so no
    // interleaving is possible.
    raw = memGet(key);
    if (raw !== null) memory.delete(key);
  } else {
    // GETDEL is a single round trip, so two concurrent exchanges of the same
    // code cannot both see it. Redis < 6.2 lacks the command — fall back to the
    // non-atomic pair rather than failing the request outright.
    try {
      const got = await restCommand(cfg, ['GETDEL', key]);
      if (got === null || got === undefined) raw = null;
      else { try { raw = typeof got === 'string' ? JSON.parse(got) : got; } catch { raw = got; } }
    } catch {
      // kvGet decrypts a secret already, so return its value straight.
      const value = await kvGet(key, env);
      if (value !== null) await kvDelete(key, env);
      return value;
    }
  }
  // A one-shot secret (a refresh-token payload) is decrypted here too; no lazy
  // upgrade, since it is being deleted.
  return decodeSecret(key, raw, env).value;
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
  /**
   * A person's cloud-connector OAuth token (Google Drive, Dropbox, M365), by
   * verified email and provider: `{ provider, accessToken, refreshToken,
   * expiresAt, account, connectedAt }`. A credential, so it is encrypted at rest
   * and lives here — never in the repository or `.env.local`. The primary
   * manager's is a project's fallback reader; see connectors.js. Long-lived.
   */
  connectorToken: (email, provider) => `teamctx:connector:token:${String(email).toLowerCase()}:${provider}`,
  /** Which providers one person has connected, for the settings page (not a secret). */
  connectorIndex: email => `teamctx:connector:index:${String(email).toLowerCase()}`,
  /**
   * Which people shared which connection with a project: `{ shares: { <email>:
   * [provider, …] } }`. A pointer, never a token — the credential stays in the
   * owner's `connectorToken` and is read from there. Only the primary manager's
   * share is used as a project's fallback reader; see connectors.js. Not a secret.
   */
  projectConnectors: (owner, repo) => `teamctx:connector:project-shares:${slug(owner, repo)}`,
  /** The projects one person shared a connection with, for the settings page (not a secret). */
  connectorsSharedBy: email => `teamctx:connector:shared-by:${String(email).toLowerCase()}`,
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
