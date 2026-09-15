import { createHash, randomBytes } from 'crypto';
import { kvGet, kvSet, kvDelete, keys } from './kv.js';

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

/** Note that the agent was used, so a manager can tell a live job from a dead one. */
export async function touchAgent(token, now = new Date()) {
  const hash = hashToken(token);
  const record = await kvGet(keys.agentToken(hash));
  if (!record) return;
  const at = now.toISOString();
  await kvSet(keys.agentToken(hash), { ...record, lastUsedAt: at });
  const list = (await kvGet(keys.projectAgents(record.owner, record.repo)))?.agents || [];
  await kvSet(keys.projectAgents(record.owner, record.repo), {
    agents: list.map(a => (a.hash === hash ? { ...a, lastUsedAt: at } : a)),
  });
}

/** The agents issued for a project, without their hashes. */
export async function listAgents(owner, repo) {
  const list = (await kvGet(keys.projectAgents(owner, repo)))?.agents || [];
  return list.map(({ hash, ...agent }) => agent);
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
  const key = keys.agentDaily(id, day);
  const used = Number((await kvGet(key))?.count || 0);
  const resetsAt = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_SECONDS * 1000).toISOString();
  if (used >= limit) return { ok: false, used, limit, resetsAt };
  await kvSet(key, { count: used + 1 }, { ttlSeconds: 2 * DAY_SECONDS });
  return { ok: true, used: used + 1, limit, resetsAt };
}
