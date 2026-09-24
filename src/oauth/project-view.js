import { GithubSession } from '../adapters/github.js';
import { runWithSession } from '../session-context.js';
import { readConfig, readProject, listTasks } from '../storage.js';
import { listAllWorkstreams } from '../../cli/commands/workstream.core.js';
import { listMembers, memberByEmail } from '../../cli/commands/member.core.js';
import { listPendingReviews } from '../../cli/commands/review.core.js';
import { scopeFor, inScope } from '../member-scope.js';
import { resolveTarget, targetLabel } from '../project-level.js';
import { managerKeys, matchesActor } from '../review.js';
import { kvGet, keys } from './kv.js';

/**
 * Where a project stands, for somebody who would rather look than ask.
 *
 * Everything here is already in the repository; the only interface to it was a
 * conversation, which asks a non-technical manager to know what to ask for. So
 * this reads the same files the tools read and hands back the three answers
 * people actually want — what the parts of the work are and who is on them, what
 * is open and who has it, and what is waiting on the manager.
 *
 * Read-only, deliberately: approving and editing already have a place, and a
 * second way to write would be a second thing to keep honest.
 */

export class ProjectViewError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PROJECT_VIEW_DENIED';
  }
}

/**
 * The credential and identity to read a project with.
 *
 * A GitHub sign-in reads with its own token, as everything else on this server
 * does. A Google sign-in has none, so it reads through the credential the
 * project lends — and only once the roster confirms the address, which is the
 * same check the connector makes.
 */
async function accessFor({ owner, repo, user }) {
  if (user.token) {
    return {
      ghToken: user.token,
      actor: {
        key: `github:${user.id}`,
        name: user.name || user.login,
        login: user.login || null,
        email: user.email ? String(user.email).toLowerCase() : null,
        source: 'github',
      },
    };
  }
  if (!user.email) throw new ProjectViewError('Your sign-in did not come with a verified email address.');
  const lent = await kvGet(keys.projectGhCred(owner, repo));
  if (!lent?.token) {
    throw new ProjectViewError(
      `${owner}/${repo} has not lent GitHub access, so it cannot be read on behalf of a Google sign-in. `
      + 'Its manager can turn that on from the settings page.');
  }
  // The roster check happens once the project is open, against the config this
  // page reads anyway — the connector's own check, without a second fetch.
  return {
    ghToken: lent.token,
    actor: {
      key: `git:${String(user.email).toLowerCase()}`,
      name: user.name,
      login: null,
      email: String(user.email).toLowerCase(),
      source: 'google',
    },
    checkRoster: true,
  };
}

/** Who is on each part of the work. A member with no workstreams is on all of them. */
function membersOn(members, id) {
  return members.filter(m => !m.workstreams?.length || m.workstreams.includes(id));
}

export async function readProjectView({ owner, repo, user }) {
  const { ghToken, actor, checkRoster } = await accessFor({ owner, repo, user });
  const session = new GithubSession({ owner, repo, ghToken });
  try {
    await session.prefetch();
  } catch (e) {
    throw new ProjectViewError(`${owner}/${repo} could not be read: ${e.message}`);
  }

  return runWithSession(session, async () => {
    const config = readConfig();
    // Matched against the gate itself, never `canApprove`: that answers yes to
    // everyone on a project with no gate, and matches a legacy display-name gate
    // against a name the caller chose for themselves — and this answer decides
    // whether the roster check below runs at all.
    const isManager = managerKeys(config).some(k => matchesActor(k, actor));
    // A sign-in with no GitHub account of its own reads through the credential
    // the project lends, so the roster is what stands in front of it. Without
    // this, any Google account anywhere could read any project that lends one.
    if (checkRoster && !isManager && !memberByEmail(config.members, actor.email)) {
      throw new ProjectViewError(
        `${actor.email} is not on the ${owner}/${repo} roster. `
        + 'Ask the manager to add that exact address, or sign in with the one they invited.');
    }
    const allowed = scopeFor(config, actor, { isManager });

    const members = listMembers({}).filter(m => m.kind !== 'agent');
    const agents = listMembers({}).filter(m => m.kind === 'agent');
    const workstreams = (await listAllWorkstreams({}))
      .filter(w => inScope(allowed, w.id))
      .map(w => ({ ...w, members: membersOn(members, w.id).map(m => m.name) }));

    const tasks = listTasks({}, undefined)
      .filter(t => inScope(allowed, resolveTarget(t.workstream)))
      .map(t => ({
        id: t.id,
        title: t.title,
        owner: t.owner || null,
        status: t.status === 'done' ? 'done' : 'open',
        where: targetLabel(resolveTarget(t.workstream), config.project),
      }));

    // The queue is the manager's to clear, so only they are shown what is in it.
    const pending = isManager
      ? (await listPendingReviews({})).map(q => ({
        id: q.id,
        author: q.author,
        summary: q.summary,
        createdAt: q.createdAt || null,
        where: targetLabel(resolveTarget(q.workstream), config.project),
      }))
      : null;

    return {
      project: config.project,
      owner,
      repo,
      isManager,
      scopedTo: allowed,
      projectWhys: (readProject().whys || []).length,
      workstreams,
      members: members.map(m => ({
        name: m.name,
        email: m.email || null,
        on: m.workstreams?.length ? m.workstreams : null,
      })),
      agents: agents.map(a => ({ name: a.name, on: a.workstreams?.length ? a.workstreams : null })),
      tasks: {
        open: tasks.filter(t => t.status === 'open'),
        done: tasks.filter(t => t.status === 'done'),
      },
      pending,
    };
  });
}

