import { createHash, randomBytes } from 'crypto';
import { kvGet, kvSet, kvDelete, kvIncr, keys } from './kv.js';

/**
 * Tokens for unattended agents on the hosted connector.
 *
 * A person's sign-in expires and belongs to that person; a job that runs every
 * morning needs neither. A manager issues one of these per agent, per project,
 * and it lasts until revoked. See docs/proposals/agent-tokens.md.
 *
 * Only the hash is stored. The token is shown to the manager once, so a read of
 * the store — a leaked backup, a debugging session — yields nothing that works.
 */

/** Recognisable at a glance, and told apart from an OAuth token before any lookup. */
export const AGENT_TOKEN_PREFIX = 'tctx_agent_';

/** Contributions an agent may send in one UTC day. Each spends an AI call. */
export const DAILY_CONTRIBUTION_LIMIT = 20;

const DAY_SECONDS = 24 * 60 * 60;

export const hashToken = token => createHash('sha256').update(String(token)).digest('hex');

export const isAgentToken = token => String(token || '').startsWith(AGENT_TOKEN_PREFIX);

const sameProject = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * Issue a token for one agent on one project.
 *
 * Returns the token alongside the stored record. The caller shows it once and
 * keeps nothing; there is no way to read it back afterwards.
 */
export async function createAgentToken({ owner, repo, id, name, issuedBy, now = new Date() } = {}) {
  if (!owner || !repo) throw new Error('an agent token needs a project');
  if (!id || !name) throw new Error('an agent token needs the agent\'s id and name');
  if (!issuedBy) throw new Error('an agent token records who issued it');

  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const hash = hashToken(token);
  const record = {
    id, name, owner, repo,
    issuedBy: String(issuedBy).toLowerCase(),
    createdAt: now.toISOString(),
    lastUsedAt: null,
    dailyLimit: DAILY_CONTRIBUTION_LIMIT,
  };
  await kvSet(keys.agentToken(hash), record);

  const list = (await kvGet(keys.projectAgents(owner, repo)))?.agents || [];
  await kvSet(keys.projectAgents(owner, repo), { agents: [...list, { ...record, hash }] });

  const issued = (await kvGet(keys.agentsIssuedBy(issuedBy)))?.projects || [];
  const slug = `${owner}/${repo}`;
  if (!issued.some(p => sameProject(p, slug))) {
    await kvSet(keys.agentsIssuedBy(issuedBy), { projects: [...issued, slug] });
  }
  return { token, record };
}

/**
 * The agent a token belongs to, if it is still valid for this project.
 *
 * A token for another project is refused rather than followed: a URL names one
 * repository, and a token that worked against any of them would make the URL a
 * formality.
 */
export async function verifyAgentToken(token, { owner, repo } = {}) {
  if (!isAgentToken(token)) return null;
  const record = await kvGet(keys.agentToken(hashToken(token)));
  if (!record) return null;
  if (owner && repo && !(sameProject(record.owner, owner) && sameProject(record.repo, repo))) return null;
  return record;
}

/**
 * Note that the agent was used, so a manager can tell a live job from a dead one.
 *
 * A single write to a record of its own. It used to read and rewrite the token
 * record and the project's list, and a request that overlapped a revoke wrote
 * the token back; one that overlapped a new agent wrote the list without it.
 */
export async function touchAgent(id, now = new Date()) {
  if (!id) return;
  await kvSet(keys.agentLastUsed(id), { at: now.toISOString() });
}

/** The agents issued for a project, without their hashes. */
export async function listAgents(owner, repo) {
  const list = (await kvGet(keys.projectAgents(owner, repo)))?.agents || [];
  return Promise.all(list.map(async ({ hash, ...agent }) => ({
    ...agent,
    lastUsedAt: (await kvGet(keys.agentLastUsed(agent.id)))?.at || agent.lastUsedAt || null,
  })));
}

/** Projects an address has issued agents for. */
export async function projectsWithAgentsBy(email) {
  if (!email) return [];
  return (await kvGet(keys.agentsIssuedBy(email)))?.projects || [];
}

/**
 * Revoke an agent. The token stops working on its next request.
 *
 * Returns the revoked agent, or null when the project has no agent by that id.
 */
export async function revokeAgent({ owner, repo, id } = {}) {
  const list = (await kvGet(keys.projectAgents(owner, repo)))?.agents || [];
  const found = list.find(a => a.id === id);
  if (!found) return null;
  await kvDelete(keys.agentToken(found.hash));
  await kvDelete(keys.agentAiKey(id));
  await kvDelete(keys.agentLastUsed(id));
  await kvSet(keys.projectAgents(owner, repo), { agents: list.filter(a => a !== found) });
  const { hash, ...agent } = found;
  return agent;
}

/**
 * Count one contribution against the agent's daily limit.
 *
 * Checked before the contribution is distilled, because distilling is the AI
 * call the limit exists to bound. The day is UTC, so the reset is the same
 * moment wherever the job runs.
 */
export async function takeDailyContribution({ id, limit = DAILY_CONTRIBUTION_LIMIT, now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10);
  const resetsAt = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_SECONDS * 1000).toISOString();
  // Counted atomically. Reading the count and writing it back let parallel
  // calls each see room under the limit and all go through.
  const used = await kvIncr(keys.agentDaily(id, day), { ttlSeconds: 2 * DAY_SECONDS });
  if (used > limit) return { ok: false, used: limit, limit, resetsAt };
  return { ok: true, used, limit, resetsAt };
}

/**
 * Give an agent its own AI key, replacing any it had.
 *
 * Optional: an agent without one runs on the primary manager's project key. A
 * new key clears any earlier failure, since the failure was about the old one.
 */
export async function setAgentKey({ id, provider = 'anthropic', apiKey, setBy, now = new Date() } = {}) {
  if (!id) throw new Error("an agent key needs the agent's id");
  if (!apiKey) throw new Error('there is no key to set');
  await kvSet(keys.agentAiKey(id), {
    provider, apiKey, setBy: setBy ? String(setBy).toLowerCase() : null, setAt: now.toISOString(), failedAt: null,
  });
}

/** Put the agent back on the project key. */
export async function clearAgentKey(id) {
  await kvDelete(keys.agentAiKey(id));
}

/** The agent's own key, for the request that runs on it. Never for display. */
export async function readAgentKey(id) {
  const record = await kvGet(keys.agentAiKey(id));
  return record?.apiKey ? record : null;
}

/** What a manager is shown about an agent's key: never the key itself. */
export async function agentKeyStatus(id) {
  const record = await readAgentKey(id);
  if (!record) return null;
  const { apiKey, ...status } = record;
  return status;
}

/** The provider rejected the agent's own key; the call moved to the project key. */
export async function markAgentKeyFailed(id, now = new Date()) {
  const record = await readAgentKey(id);
  if (!record) return;
  await kvSet(keys.agentAiKey(id), { ...record, failedAt: now.toISOString() });
}
