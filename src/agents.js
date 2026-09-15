/**
 * What an unattended agent is, and what it may do.
 *
 * An agent reaches the hosted connector with a token a manager issued — see
 * src/oauth/agent-tokens.js. These are the rules that hold whatever surface it
 * arrives through. See docs/proposals/agent-tokens.md.
 */

/**
 * The only tools an agent sees or can call: read what it is assigned, send work
 * back, close what it finished.
 *
 * Everything else is left out on purpose. The AI-spending tools would spend the
 * primary manager's key with nobody watching; the planning tools decide what the
 * work is, which stays with people; and the review, member and config tools
 * would let an agent change who can do what.
 */
export const AGENT_TOOLS = Object.freeze(['my_brief', 'contribute', 'task_done']);

export const agentKey = id => `agent:${id}`;

export const isAgentActor = actor => actor?.source === 'agent'
  || String(actor?.key || '').startsWith('agent:');

/** The actor for an agent token's record. Never carries an address or a login. */
export function actorFromAgent(record) {
  if (!record?.id || !record?.name) return null;
  return { key: agentKey(record.id), name: record.name, login: null, email: null, source: 'agent' };
}

/**
 * The agent's roster entry, or null.
 *
 * The roster is what holds an agent to its workstreams. A token whose entry is
 * gone has no scope to be held to — and no scope reads as the whole project — so
 * a missing entry refuses the agent rather than widening it.
 */
export function agentOnRoster(config, id) {
  const key = agentKey(id);
  return (config?.members || []).find(m => m.kind === 'agent' && m.key === key) || null;
}

/**
 * Is this task the agent's own?
 *
 * By key, or by the name a manager assigned it to — which is why an agent's name
 * cannot be one already on the roster.
 */
export function agentOwnsTask(task, actor) {
  if (!task || !actor) return false;
  return (!!task.ownerKey && task.ownerKey === actor.key)
    || (!!task.owner && task.owner === actor.name);
}

export class AgentRefusedError extends Error {
  constructor(message, code = 'AGENT_REFUSED') {
    super(message);
    this.name = 'AgentRefusedError';
    this.code = code;
  }
}
