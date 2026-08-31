import { execFile } from 'child_process';
import { promisify } from 'util';
import { readConfig, writeConfig } from '../../src/storage.js';
import { commitContext, pushContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName } from '../../src/prefs.js';
import { assertManager } from './review.core.js';

const execFileAsync = promisify(execFile);

/**
 * Who is on this project.
 *
 * A teamctx project has a manager and, implicitly, anyone holding a clone — it
 * has never known who the team is. That leaves contributions attributed to
 * whatever `git config user.name` happens to say, and task owners as free text
 * where "Priya" and "priya" are two people.
 *
 * A member record reuses the actor key from src/actor.js rather than inventing
 * an identity scheme, so a member joins up with the contributions they have
 * already made and with the authorKey grouping `teamctx stats` counts by.
 *
 * Members are project-wide, not per-workstream. Workstreams are a view over one
 * context tree in one repo: anyone who can read the repo reads every
 * workstream, so per-workstream membership would be a label enforcing nothing.
 */

export class MemberNotFoundError extends Error {
  constructor(ref) {
    super(`no member "${ref}" on this project`);
    this.code = 'MEMBER_NOT_FOUND';
  }
}

export class MemberExistsError extends Error {
  constructor(member) {
    super(`${member.login || member.email || member.name} is already a member`);
    this.code = 'MEMBER_EXISTS';
    this.member = member;
  }
}

export class InviteNeedsLoginError extends Error {
  constructor() {
    super('inviting a collaborator needs a GitHub username — an email address cannot be invited');
    this.code = 'INVITE_NEEDS_LOGIN';
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * A GitHub handle or an email, told apart by shape.
 *
 * Only the handle form can ever be invited to the repository — GitHub's
 * collaborator endpoint takes a username and nothing else.
 */
export function parseMemberRef(ref) {
  const s = String(ref ?? '').trim().replace(/^@/, '');
  if (!s) throw new Error('a GitHub username or email address is required');
  if (EMAIL.test(s)) return { email: s, login: null };
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s)) {
    throw new Error(`"${ref}" is neither a GitHub username nor an email address`);
  }
  return { email: null, login: s };
}

export function listMembers({ teamctxDir } = {}) {
  return readConfig(teamctxDir).members || [];
}

/** Match on any of the things a person might be called. */
function findMember(members, ref) {
  const s = String(ref ?? '').trim().replace(/^@/, '').toLowerCase();
  return members.find(m => [m.key, m.login, m.email, m.name]
    .some(v => v && String(v).toLowerCase() === s));
}

/**
 * Attribute a commit to a GitHub account without exposing a private address.
 *
 * `<id>+<login>@users.noreply.github.com` is the form GitHub itself issues, and
 * it is what makes a commit show up against the right profile. Without an id
 * the login-only form still attributes; without a login there is nothing to
 * attribute to and the caller falls back to the actor's own email.
 */
/**
 * The roster entry for a verified email address, or null.
 *
 * This is the gate in front of the project's shared GitHub credential, so it
 * takes an address Google has already vouched for and nothing else. Matching on
 * a claimed address would make the roster decorative: anyone could name someone
 * else's invite and be handed the project's write access.
 *
 * Matched case-insensitively because email addresses are, and because the
 * manager types the invite by hand.
 */
export function memberByEmail(members, email) {
  const wanted = String(email ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return (members || []).find(m => String(m.email ?? '').toLowerCase() === wanted) || null;
}

export function noreplyEmail({ key, login } = {}) {
  if (!login) return null;
  const id = /^github:(\d+)$/.exec(key || '')?.[1];
  return id
    ? `${id}+${login}@users.noreply.github.com`
    : `${login}@users.noreply.github.com`;
}

async function commitAndPush(config, message, projectDir, actor) {
  await commitContext(message, {
    ...(projectDir ? { cwd: projectDir } : {}),
    ...(actor ? { author: { name: actor.name, email: noreplyEmail(actor) } } : {}),
  });
  if (!config.autoPush) return { committed: true, pushed: false };
  try {
    await pushContext(projectDir ? { cwd: projectDir } : undefined);
    return { committed: true, pushed: true };
  } catch (err) {
    return { committed: true, pushed: false, pushError: err.message?.split('\n')[0] || 'push failed' };
  }
}

/**
 * Invite someone to the repository.
 *
 * Separate from adding them to the roster on purpose: inviting a person to a
 * GitHub repository is a bigger act than noting them on a list, and it fails
 * for reasons that have nothing to do with teamctx — no `gh`, a token without
 * `repo`, not an admin of the repo. The caller keeps the roster entry either
 * way; rolling one back because GitHub was unavailable would be the wrong
 * trade.
 */
export async function inviteCollaborator({
  login, owner, repo, permission = 'push', projectDir, ghToken,
} = {}) {
  if (!login) throw new InviteNeedsLoginError();
  if (!owner || !repo) throw new Error('the repository owner and name are required to invite');

  const path = `repos/${owner}/${repo}/collaborators/${login}`;

  // Hosted: the caller's OAuth token already carries `repo`, which is what the
  // collaborator endpoint needs.
  if (ghToken) {
    const res = await globalThis.fetch(`https://api.github.com/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permission }),
    });
    // 201 creates an invitation; 204 means they already had access.
    if (res.status === 204) return { invited: false, alreadyCollaborator: true };
    if (res.ok) return { invited: true, alreadyCollaborator: false };
    const body = await res.json().catch(() => ({}));
    throw new Error(`github: ${body.message || `could not invite ${login} (${res.status})`}`);
  }

  // Local: `gh` is already a dependency of `teamctx setup`, and a normal
  // `gh auth login` yields the `repo` scope this needs.
  try {
    const { stdout } = await execFileAsync('gh', [
      'api', '-X', 'PUT', path, '-f', `permission=${permission}`,
    ], projectDir ? { cwd: projectDir } : undefined);
    // A 204 prints nothing; an invitation comes back as JSON.
    return { invited: stdout.trim().length > 0, alreadyCollaborator: stdout.trim().length === 0 };
  } catch (err) {
    const detail = (err.stderr || err.message || '').split('\n').find(l => l.trim()) || 'gh failed';
    throw new Error(`gh: ${detail.trim()}`);
  }
}

export async function addMember({
  ref, name, invite = false, permission = 'push',
  owner, repo, ghToken, teamctxDir, projectDir, actor,
} = {}) {
  const config = readConfig(teamctxDir);
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  const displayName = await resolveDisplayName({ actor: resolved, config, teamctxDir });
  assertManager(config, { actor: resolved, displayName });

  const { login, email } = parseMemberRef(ref);
  const members = config.members || [];
  const existing = findMember(members, login || email);
  if (existing) throw new MemberExistsError(existing);

  const member = {
    // Without a GitHub id the login is still stable enough to group by; it is
    // upgraded to github:<id> the first time that person acts.
    key: login ? `github:${login}` : `git:${email}`,
    name: name || login || email,
    login,
    email,
    addedBy: resolved.key,
    addedAt: new Date().toISOString().slice(0, 10),
  };

  // Invite first: if it is going to fail loudly, better before the roster
  // records something the manager may not want.
  let inviteResult = null;
  if (invite) {
    try {
      inviteResult = await inviteCollaborator({
        login, owner, repo, permission, projectDir, ghToken,
      });
    } catch (err) {
      if (err instanceof InviteNeedsLoginError) throw err;
      inviteResult = { invited: false, error: err.message };
    }
  }

  writeConfig({ ...config, members: [...members, member] }, teamctxDir);
  const git = await commitAndPush(config, `member: add ${member.name} by ${displayName}`, projectDir, resolved);
  return { member, invite: inviteResult, ...git };
}

/**
 * Take someone off the roster.
 *
 * Deliberately does not touch repository access. Conflating the two would make
 * a bookkeeping command destructive, and revoking a collaborator is a decision
 * that belongs on GitHub where it can be seen.
 */
export async function removeMember({ ref, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  const displayName = await resolveDisplayName({ actor: resolved, config, teamctxDir });
  assertManager(config, { actor: resolved, displayName });

  const members = config.members || [];
  const member = findMember(members, ref);
  if (!member) throw new MemberNotFoundError(ref);

  writeConfig({ ...config, members: members.filter(m => m !== member) }, teamctxDir);
  const git = await commitAndPush(config, `member: remove ${member.name} by ${displayName}`, projectDir, resolved);
  return { member, stillHasRepoAccess: !!member.login, ...git };
}
