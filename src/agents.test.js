import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOLS, agentKey, isAgentActor, actorFromAgent, agentOnRoster, agentOwnsTask,
} from './agents.js';
import { matchesActor } from './review.js';

describe('an agent', () => {
  it('has three tools and cannot be given more at runtime', () => {
    expect([...AGENT_TOOLS]).toEqual(['my_brief', 'contribute', 'task_done']);
    expect(() => { AGENT_TOOLS.push('review_approve'); }).toThrow();
  });

  it('is an identity of its own, with no address or login', () => {
    const actor = actorFromAgent({ id: 'a1', name: 'Nightly report' });
    expect(actor).toEqual({ key: 'agent:a1', name: 'Nightly report', login: null, email: null, source: 'agent' });
    expect(isAgentActor(actor)).toBe(true);
    expect(isAgentActor({ key: 'github:1', source: 'github' })).toBe(false);
  });

  it('matches no manager written the ways a manager is written', () => {
    const actor = actorFromAgent({ id: 'a1', name: 'Nightly report' });
    for (const ref of ['git:maya@example.com', 'github:7', '@maya', 'git:']) {
      expect(matchesActor(ref, actor)).toBe(false);
    }
  });

  it('is found on the roster only by an agent entry with its key', () => {
    const config = { members: [
      { key: 'agent:a1', name: 'Sam' },
      { key: 'agent:a2', name: 'Nightly report', kind: 'agent' },
    ] };
    expect(agentOnRoster(config, 'a1')).toBe(null);
    expect(agentOnRoster(config, 'a2')).toMatchObject({ name: 'Nightly report' });
    expect(agentOnRoster({}, 'a2')).toBe(null);
  });

  it('owns a task by key or by the name it was assigned to', () => {
    const actor = { key: agentKey('a1'), name: 'Nightly report' };
    expect(agentOwnsTask({ ownerKey: 'agent:a1', owner: 'Someone' }, actor)).toBe(true);
    expect(agentOwnsTask({ owner: 'Nightly report' }, actor)).toBe(true);
    expect(agentOwnsTask({ owner: 'Sam', ownerKey: 'git:sam@example.com' }, actor)).toBe(false);
    expect(agentOwnsTask({}, actor)).toBe(false);
  });
});
