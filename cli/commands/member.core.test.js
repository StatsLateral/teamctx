import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  // Non-empty by default: nobody can be added to a project with nothing in it,
  // so every other test here would be testing the gate instead of itself.
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
  resolveActor: vi.fn(async () => ({ key: 'github:44', name: 'Maya', login: 'mayab', source: 'github' })),
}));
vi.mock('../../src/prefs.js', () => ({
  resolveDisplayName: vi.fn(async ({ actor }) => actor?.name || 'unknown'),
}));

import { readConfig, writeConfig, readProject, readWorkstream } from '../../src/storage.js';
import { resolveActor } from '../../src/actor.js';
import { commitContext } from '../../src/git.js';
import {
  listMembers, addMember, removeMember, setMemberWorkstreams, parseMemberRef, noreplyEmail,
  MemberNotFoundError, MemberExistsError, InviteNeedsLoginError,
} from './member.core.js';
import { ManagerGateError } from './review.core.js';
import { EmptyContextError } from '../../src/context-gate.js';

const MANAGER = { key: 'github:44', name: 'Maya', login: 'mayab', source: 'github' };
const OTHER = { key: 'github:99', name: 'Sam', login: 'samq', source: 'github' };

const config = (over = {}) => ({
  project: 'Ledger', managerKey: 'github:44', autoPush: false, members: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  readConfig.mockReturnValue(config());
});

describe('parseMemberRef', () => {
  it('tells a handle from an email by shape', () => {
    expect(parseMemberRef('priyar')).toEqual({ login: 'priyar', email: null });
    expect(parseMemberRef('priya@example.com')).toEqual({ login: null, email: 'priya@example.com' });
  });

  it('accepts the @handle people actually type', () => {
    expect(parseMemberRef('@priyar').login).toBe('priyar');
  });

  it('rejects something that is neither', () => {
    expect(() => parseMemberRef('not a name')).toThrow(/neither a GitHub username nor an email/);
    expect(() => parseMemberRef('')).toThrow(/required/);
  });

  it('rejects a handle GitHub would not issue', () => {
    // Leading/trailing and doubled hyphens are not valid logins; letting them
    // through means an invite that fails at the API with a worse message.
    for (const bad of ['-priya', 'priya-', 'pri--ya']) {
      expect(() => parseMemberRef(bad), bad).toThrow();
    }
  });
});

describe('noreplyEmail', () => {
  it('uses the id+login form GitHub issues, so commits attribute correctly', () => {
    expect(noreplyEmail({ key: 'github:1001', login: 'priyar' }))
      .toBe('1001+priyar@users.noreply.github.com');
  });

  it('falls back to login-only when there is no id', () => {
    expect(noreplyEmail({ key: 'github:priyar', login: 'priyar' }))
      .toBe('priyar@users.noreply.github.com');
  });

  it('is null with no login — there is nothing to attribute to', () => {
    expect(noreplyEmail({ key: 'git:a@b.com', login: null })).toBe(null);
    expect(noreplyEmail({})).toBe(null);
  });
});

describe('the manager gate', () => {
  it('lets the manager add someone', async () => {
    const r = await addMember({ ref: 'priyar', actor: MANAGER });
    expect(r.member.login).toBe('priyar');
    expect(writeConfig).toHaveBeenCalled();
  });

  it('refuses anyone else, and writes nothing', async () => {
    // The roster is who the manager says is on the team. If a non-manager
    // could edit it, adding yourself would be the way past every other gate.
    await expect(addMember({ ref: 'priyar', actor: OTHER })).rejects.toThrow(ManagerGateError);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(commitContext).not.toHaveBeenCalled();
  });

  it('refuses a non-manager removal too', async () => {
    readConfig.mockReturnValue(config({ members: [{ key: 'github:1', name: 'Priya', login: 'priyar' }] }));
    await expect(removeMember({ ref: 'priyar', actor: OTHER })).rejects.toThrow(ManagerGateError);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});

describe('adding', () => {
  it('records who added them and when', async () => {
    const r = await addMember({ ref: 'priyar', actor: MANAGER });
    expect(r.member.addedBy).toBe('github:44');
    expect(r.member.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keys a member the same way the actor system does', async () => {
    // Sharing the key is what joins a member up with the contributions they
    // have already made, and with the authorKey grouping stats counts by.
    expect((await addMember({ ref: 'priyar', actor: MANAGER })).member.key).toBe('github:priyar');
    expect((await addMember({ ref: 'p@example.com', actor: MANAGER })).member.key).toBe('git:p@example.com');
  });

  it('takes a display name when the handle is not the name', async () => {
    const r = await addMember({ ref: 'priyar', name: 'Priya Raman', actor: MANAGER });
    expect(r.member.name).toBe('Priya Raman');
  });

  it('refuses a duplicate rather than adding a second row', async () => {
    readConfig.mockReturnValue(config({ members: [{ key: 'github:1', name: 'Priya', login: 'priyar' }] }));
    await expect(addMember({ ref: 'priyar', actor: MANAGER })).rejects.toThrow(MemberExistsError);
    await expect(addMember({ ref: '@PriyaR', actor: MANAGER })).rejects.toThrow(MemberExistsError);
  });

  it('attributes the commit to whoever made it', async () => {
    // The whole point of the author field: a write made on one credential is
    // still recorded against the person who made it.
    await addMember({ ref: 'priyar', actor: MANAGER });
    const [, opts] = commitContext.mock.calls[0];
    expect(opts.author).toEqual({ name: 'Maya', email: '44+mayab@users.noreply.github.com' });
  });
});

describe('inviting', () => {
  it('refuses to invite an email address', async () => {
    // GitHub's collaborator endpoint takes a username and nothing else, so
    // this cannot work and should say so rather than fail inside the API call.
    await expect(addMember({
      ref: 'priya@example.com', invite: true, owner: 'o', repo: 'r', actor: MANAGER,
    })).rejects.toThrow(InviteNeedsLoginError);
  });

  it('still adds the member when the invite fails', async () => {
    // Rolling back a roster entry because GitHub was unavailable would be the
    // wrong trade — the manager's intent was recorded either way.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({ message: 'Must have admin rights' }),
    }));
    const r = await addMember({
      ref: 'priyar', invite: true, owner: 'o', repo: 'r', ghToken: 'gho_x', actor: MANAGER,
    });
    expect(r.member.login).toBe('priyar');
    expect(r.invite.error).toMatch(/admin rights/);
    expect(writeConfig).toHaveBeenCalled();
  });

  it('reports an existing collaborator as access, not as a new invite', async () => {
    // 204 means they already had access; calling that "invited" would tell the
    // manager to expect an acceptance that will never come.
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 204 }));
    const r = await addMember({
      ref: 'priyar', invite: true, owner: 'o', repo: 'r', ghToken: 'gho_x', actor: MANAGER,
    });
    expect(r.invite).toEqual({ invited: false, alreadyCollaborator: true });
  });

  it('sends the requested permission level', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }));
    await addMember({
      ref: 'priyar', invite: true, permission: 'pull', owner: 'o', repo: 'r', ghToken: 'gho_x', actor: MANAGER,
    });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/collaborators/priyar');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ permission: 'pull' });
  });

  it('does not touch GitHub when invite was not asked for', async () => {
    globalThis.fetch = vi.fn();
    await addMember({ ref: 'priyar', actor: MANAGER });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('removing', () => {
  const withPriya = () => readConfig.mockReturnValue(
    config({ members: [{ key: 'github:1', name: 'Priya', login: 'priyar', email: null }] }));

  it('finds a member by any of the things they are called', async () => {
    for (const ref of ['priyar', '@priyar', 'Priya', 'github:1']) {
      withPriya();
      const r = await removeMember({ ref, actor: MANAGER });
      expect(r.member.login, ref).toBe('priyar');
    }
  });

  it('says the removal did not revoke GitHub access', async () => {
    // A manager who believes this withdrew access is wrong, and would find out
    // the expensive way.
    withPriya();
    expect((await removeMember({ ref: 'priyar', actor: MANAGER })).stillHasRepoAccess).toBe(true);
  });

  it('errors on someone who is not on the roster', async () => {
    await expect(removeMember({ ref: 'nobody', actor: MANAGER })).rejects.toThrow(MemberNotFoundError);
  });
});

describe('listMembers', () => {
  it('is empty rather than undefined on a project that has none', () => {
    readConfig.mockReturnValue({ project: 'Ledger' });
    expect(listMembers({})).toEqual([]);
  });
});

describe('scoping a member to workstreams', () => {
  const withWorkstreams = (over = {}) => config({
    workstreams: [{ id: 'main', name: 'Main' }, { id: 'engineering', name: 'Engineering' }],
    ...over,
  });

  beforeEach(() => readConfig.mockReturnValue(withWorkstreams()));

  it('records the scope on the roster entry', async () => {
    const r = await addMember({ ref: 'ravi', workstreams: ['engineering'] });
    expect(r.member.workstreams).toEqual(['engineering']);
    expect(writeConfig.mock.calls[0][0].members[0].workstreams).toEqual(['engineering']);
  });

  it('leaves the field off entirely for a project-wide member', async () => {
    // So a roster written before scopes existed and one written after are the
    // same shape, and "no scope" never has to be told from "empty scope".
    const r = await addMember({ ref: 'ravi' });
    expect('workstreams' in r.member).toBe(false);
  });

  it('refuses a workstream the project does not have', async () => {
    // Silent and expensive otherwise: a typo produces a member scoped to
    // nothing, who can reach nothing, with no message saying why.
    await expect(addMember({ ref: 'ravi', workstreams: ['enginering'] }))
      .rejects.toThrow(/no workstream "enginering"/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('names what the project does have when it refuses', async () => {
    const err = await addMember({ ref: 'ravi', workstreams: ['nope'] }).catch(e => e);
    expect(err.message).toContain('main');
    expect(err.message).toContain('engineering');
  });

  it('treats an empty list as project-wide rather than as nothing', async () => {
    const r = await addMember({ ref: 'ravi', workstreams: [] });
    expect('workstreams' in r.member).toBe(false);
  });

  it('accepts a single id without an array', async () => {
    const r = await addMember({ ref: 'ravi', workstreams: 'engineering' });
    expect(r.member.workstreams).toEqual(['engineering']);
  });
});

describe('changing a member\'s scope afterwards', () => {
  const scoped = { key: 'github:ravi', name: 'Ravi', login: 'ravi', email: null, workstreams: ['engineering'] };
  const withRoster = () => config({
    workstreams: [{ id: 'main', name: 'Main' }, { id: 'engineering', name: 'Engineering' }],
    members: [scoped],
  });

  beforeEach(() => {
    // `clearAllMocks` clears calls but keeps implementations, so an earlier
    // test's non-manager actor would otherwise leak into the rest of these.
    resolveActor.mockResolvedValue(MANAGER);
    readConfig.mockReturnValue(withRoster());
  });

  it('widens a scope', async () => {
    const r = await setMemberWorkstreams({ ref: 'ravi', workstreams: ['main', 'engineering'] });
    expect(r.member.workstreams).toEqual(['main', 'engineering']);
  });

  it('clears it back to project-wide when given nothing', async () => {
    const r = await setMemberWorkstreams({ ref: 'ravi' });
    expect('workstreams' in r.member).toBe(false);
    expect(r.workstreams).toBe(null);
  });

  it('refuses somebody who is not the manager', async () => {
    // Scope decides what a member can read, so a member who can widen their own
    // is not scoped at all.
    resolveActor.mockResolvedValue(OTHER);
    await expect(setMemberWorkstreams({ ref: 'ravi', workstreams: ['main'] }))
      .rejects.toThrow(ManagerGateError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses an unknown member', async () => {
    await expect(setMemberWorkstreams({ ref: 'nobody', workstreams: ['main'] }))
      .rejects.toThrow(MemberNotFoundError);
  });

  it('refuses an unknown workstream', async () => {
    await expect(setMemberWorkstreams({ ref: 'ravi', workstreams: ['nope'] }))
      .rejects.toThrow(/no workstream "nope"/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('records what changed in the commit', async () => {
    await setMemberWorkstreams({ ref: 'ravi', workstreams: ['main'] });
    expect(commitContext.mock.calls[0][0]).toMatch(/scope Ravi to main/);
  });

  it('says so when the scope is cleared', async () => {
    await setMemberWorkstreams({ ref: 'ravi' });
    expect(commitContext.mock.calls[0][0]).toMatch(/the whole project/);
  });
});

describe('nobody is brought onto an empty project', () => {
  const EMPTY = { name: 'Ledger', whys: [] };
  const FULL = { name: 'Ledger', whys: [{ id: 'w1', text: 'ship it' }] };

  it('refuses `member add` while the project has nothing in it', async () => {
    readProject.mockReturnValue(EMPTY);
    await expect(addMember({ ref: 'priyar', actor: MANAGER })).rejects.toThrow(EmptyContextError);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('refuses before the repository invite is attempted', async () => {
    // Inviting somebody to a repo and then refusing to put them on the roster
    // is worse than either succeeding or failing cleanly.
    readProject.mockReturnValue(EMPTY);
    globalThis.fetch = vi.fn();
    await expect(addMember({
      ref: 'priyar', invite: true, owner: 'o', repo: 'r', ghToken: 'gho_x', actor: MANAGER,
    })).rejects.toThrow(EmptyContextError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the workstream they would join has nothing of its own', async () => {
    readConfig.mockReturnValue(config({ workstreams: [{ id: 'docs', name: 'Documentation' }] }));
    readProject.mockReturnValue(FULL);
    readWorkstream.mockReturnValue({ id: 'docs', name: 'Documentation', whys: [] });
    await expect(addMember({ ref: 'priyar', workstreams: ['docs'], actor: MANAGER }))
      .rejects.toThrow(/"Documentation" has nothing written down/);
  });

  it('allows a project-wide member once the project has something', async () => {
    readProject.mockReturnValue(FULL);
    const r = await addMember({ ref: 'priyar', actor: MANAGER });
    expect(r.member.name).toBe('priyar');
  });

  it('gates `member scope` the same way', async () => {
    readConfig.mockReturnValue(config({
      members: [{ key: 'github:7', name: 'Ravi', login: 'ravi' }],
      workstreams: [{ id: 'docs', name: 'Documentation' }],
    }));
    readWorkstream.mockReturnValue({ id: 'docs', name: 'Documentation', whys: [] });
    await expect(setMemberWorkstreams({ ref: 'ravi', workstreams: ['docs'], actor: MANAGER }))
      .rejects.toThrow(/"Documentation" has nothing written down/);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it('lets a scope be cleared back to the whole project', async () => {
    // Widening reaches only the project tree, which is already checked.
    readConfig.mockReturnValue(config({
      members: [{ key: 'github:7', name: 'Ravi', login: 'ravi', workstreams: ['docs'] }],
      workstreams: [{ id: 'docs', name: 'Documentation' }],
    }));
    readWorkstream.mockReturnValue({ id: 'docs', name: 'Documentation', whys: [] });
    const r = await setMemberWorkstreams({ ref: 'ravi', actor: MANAGER });
    expect(r.workstreams).toBe(null);
  });

  it('names the person being added, not the manager', async () => {
    readProject.mockReturnValue(EMPTY);
    await expect(addMember({ ref: 'priyar', name: 'Priya R', actor: MANAGER }))
      .rejects.toThrow(/bring Priya R on/);
  });

  it('still refuses an unknown workstream before mentioning context', async () => {
    // A typo is the likelier mistake, and sending the manager to write context
    // for a workstream that does not exist would be a worse answer.
    readConfig.mockReturnValue(config({ workstreams: [{ id: 'docs', name: 'Documentation' }] }));
    readProject.mockReturnValue(EMPTY);
    await expect(addMember({ ref: 'priyar', workstreams: ['finance'], actor: MANAGER }))
      .rejects.toThrow(/no workstream "finance"/);
  });
});
