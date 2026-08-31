import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
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

import { readConfig, writeConfig } from '../../src/storage.js';
import { commitContext } from '../../src/git.js';
import {
  listMembers, addMember, removeMember, parseMemberRef, noreplyEmail,
  MemberNotFoundError, MemberExistsError, InviteNeedsLoginError,
} from './member.core.js';
import { ManagerGateError } from './review.core.js';

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
