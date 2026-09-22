/**
 * An unattended agent on the roster.
 *
 * The roster entry is what holds an agent to its workstreams, so the rules for
 * writing one matter as much as the token's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readProject: vi.fn(() => ({ name: 'Ledger', whys: [{ id: 'w1', text: 'ship it' }] })),
  readWorkstream: vi.fn(() => ({ id: 'w', name: 'W', whys: [{ id: 'x1', text: 'do it' }] })),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));
vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(async () => {}),
  pushContext: vi.fn(async () => {}),
}));
vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'git:maya@example.com', name: 'Maya', email: 'maya@example.com', source: 'google' })),
}));
vi.mock('../../src/prefs.js', () => ({
  resolveDisplayName: vi.fn(async ({ actor }) => actor?.name || 'unknown'),
}));

import { readConfig, writeConfig, readProject } from '../../src/storage.js';
import { resolveActor } from '../../src/actor.js';
import { commitContext } from '../../src/git.js';
import {
  addAgent, removeAgent, addMember, AgentNameTakenError, MemberNotFoundError, MemberNameIsAgentError,
} from './member.core.js';
import { ManagerGateError } from './review.core.js';
import { EmptyContextError } from '../../src/context-gate.js';

const config = (over = {}) => ({
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  autoPush: false,
  workstreams: [{ id: 'pricing', name: 'Pricing' }],
  members: [{ key: 'git:sam@example.com', name: 'Sam', email: 'sam@example.com', login: null }],
  ...over,
});

const written = () => writeConfig.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue(config());
});

describe('adding an agent', () => {
  it('writes an entry marked as an agent, keyed by its id, and commits it', async () => {
    const r = await addAgent({ id: 'a1', name: 'Nightly report', workstreams: ['pricing'] });
    expect(r.agent).toMatchObject({
      key: 'agent:a1', name: 'Nightly report', kind: 'agent', workstreams: ['pricing'], addedBy: 'git:maya@example.com',
    });
    expect(written().members).toHaveLength(2);
    expect(commitContext.mock.calls[0][0]).toBe('agent: add Nightly report by Maya');
  });

  it('carries no address or login, so it can never pass for a person', async () => {
    const { agent } = await addAgent({ id: 'a1', name: 'Nightly report' });
    expect(agent).not.toHaveProperty('email');
    expect(agent).not.toHaveProperty('login');
  });

  it('is project-wide when no workstreams are named', async () => {
    const { agent } = await addAgent({ id: 'a1', name: 'Nightly report' });
    expect(agent).not.toHaveProperty('workstreams');
  });

  it('is refused for anyone but a manager', async () => {
    resolveActor.mockResolvedValueOnce({ key: 'git:sam@example.com', name: 'Sam', email: 'sam@example.com', source: 'google' });
    await expect(addAgent({ id: 'a1', name: 'Nightly report' })).rejects.toBeInstanceOf(ManagerGateError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses a name already on the roster, whatever the case', async () => {
    // Tasks are found by name as well as identity; an agent called Sam would be
    // handed Sam's work.
    await expect(addAgent({ id: 'a1', name: 'sam' })).rejects.toBeInstanceOf(AgentNameTakenError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses a workstream the project does not have', async () => {
    await expect(addAgent({ id: 'a1', name: 'Nightly report', workstreams: ['nope'] })).rejects.toThrow(/no workstream "nope"/);
  });

  it('refuses on a project with nothing written down', async () => {
    readProject.mockReturnValueOnce({ name: 'Ledger', whys: [] });
    await expect(addAgent({ id: 'a1', name: 'Nightly report' })).rejects.toBeInstanceOf(EmptyContextError);
  });

  it('refuses an empty or overlong name', async () => {
    await expect(addAgent({ id: 'a1', name: '  ' })).rejects.toThrow(/needs a name/);
    await expect(addAgent({ id: 'a1', name: 'x'.repeat(61) })).rejects.toThrow(/60 characters/);
  });
});

describe('adding a person beside an agent', () => {
  const withAgent = () => config({ members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent' }] });

  it('refuses a person given the agent\'s name, whatever the case', async () => {
    readConfig.mockReturnValue(withAgent());
    await expect(addMember({ ref: 'dev@example.com', name: 'nightly report' })).rejects.toBeInstanceOf(MemberNameIsAgentError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses a GitHub login that is the agent\'s name', async () => {
    readConfig.mockReturnValue(config({ members: [{ key: 'agent:a1', name: 'nightly', kind: 'agent' }] }));
    await expect(addMember({ ref: 'nightly' })).rejects.toThrow();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('adds anyone else as before', async () => {
    readConfig.mockReturnValue(withAgent());
    await addMember({ ref: 'dev@example.com', name: 'Dev' });
    expect(written().members.map(m => m.name)).toEqual(['Nightly report', 'Dev']);
  });
});

describe('removing an agent', () => {
  it('takes only that agent off the roster', async () => {
    readConfig.mockReturnValue(config({
      members: [
        { key: 'git:sam@example.com', name: 'Sam', email: 'sam@example.com' },
        { key: 'agent:a1', name: 'Nightly report', kind: 'agent' },
      ],
    }));
    await removeAgent({ id: 'a1' });
    expect(written().members.map(m => m.key)).toEqual(['git:sam@example.com']);
    expect(commitContext.mock.calls[0][0]).toBe('agent: remove Nightly report by Maya');
  });

  it('never removes a person, even one whose key looks like the id', async () => {
    readConfig.mockReturnValue(config({ members: [{ key: 'agent:a1', name: 'Sam' }] }));
    await expect(removeAgent({ id: 'a1' })).rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it('is refused for anyone but a manager', async () => {
    readConfig.mockReturnValue(config({ members: [{ key: 'agent:a1', name: 'Nightly report', kind: 'agent' }] }));
    resolveActor.mockResolvedValueOnce({ key: 'git:sam@example.com', name: 'Sam', email: 'sam@example.com', source: 'google' });
    await expect(removeAgent({ id: 'a1' })).rejects.toBeInstanceOf(ManagerGateError);
  });
});
