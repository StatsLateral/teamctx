import { GithubSession } from '../adapters/github.js';
import { runWithSession } from '../session-context.js';
import { readConfig, readProject, readWorkstream, listTasks, readContributions } from '../storage.js';
import { listAllWorkstreams } from '../../cli/commands/workstream.core.js';
import { listMembers, memberByEmail } from '../../cli/commands/member.core.js';
import { listPendingReviews } from '../../cli/commands/review.core.js';
import { scopeFor, inScope } from '../member-scope.js';
import { resolveTarget } from '../project-level.js';
import { workstreamLocation } from '../views/workstream-location.js';
import { managerKeys, matchesActor } from '../review.js';
import { kvGet, keys } from './kv.js';
import { githubIdsFor } from './ai-keys.js';

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

  // Everything this person has proved they are. A sign-in with no GitHub
  // account of its own still reaches a project gated on the GitHub account
  // behind the same verified address.
  if (actor.source !== 'github' && actor.email) {
    actor.keys = (await githubIdsFor(actor.email)).map(id => `github:${id}`);
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
    const onRoster = memberByEmail(config.members, actor.email)
      || (config.members || []).some(m => matchesActor(m.key, actor));
    if (checkRoster && !isManager && !onRoster) {
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

    // The trees themselves, which is what the page exists to show.
    //
    // Only the ones this person may see: an out-of-scope tree must not be in the
    // payload at all, rather than sent and hidden by the page. A reader who opens
    // the network tab is still a reader, and scope that only holds in the markup
    // is not scope.
    const projectTree = readProject();
    const trees = Object.fromEntries(
      workstreams.map(w => [w.id, readWorkstream(w.id) || { id: w.id, name: w.name, records: [], tasks: [] }]),
    );

    const tasks = listTasks({}, undefined)
      .filter(t => inScope(allowed, resolveTarget(t.workstream)))
      .map(t => ({
        id: t.id,
        // The handle a person has in front of them. The payload is built field by
        // field on purpose, so anything not named here never reaches the page —
        // which is also how this was missing, and a link by key reached nothing.
        key: t.key || null,
        title: t.title,
        owner: t.owner || null,
        status: t.status === 'done' ? 'done' : 'open',
        sourceContributionIds: t.sourceContributionIds || [],
        workstream: resolveTarget(t.workstream),
        where: workstreamLocation(workstreams, resolveTarget(t.workstream), config.project),
      }));

    // The queue is the manager's to clear, so only they are shown what is in it.
    const pending = isManager
      ? (await listPendingReviews({})).map(q => ({
        id: q.id,
        author: q.author,
        summary: q.summary,
        createdAt: q.createdAt || null,
        source: q.source || null,
        operations: q.operations || [],
        workstream: resolveTarget(q.workstream),
        where: workstreamLocation(workstreams, resolveTarget(q.workstream), config.project),
      }))
      : null;

    return {
      project: config.project,
      owner,
      repo,
      isManager,
      scopedTo: allowed,
      goal: projectTree.goal?.text || null,
      projectTree,
      trees,
      // Who wrote what, for the source dots and the drawer's names — and only
      // for the statements in the trees above, so nothing travels that the page
      // has no use for.
      contributions: contributionsBehind([projectTree, ...Object.values(trees)]),
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


/**
 * The contributions the given trees point at.
 *
 * Every statement carries the ids of the contributions that touched it, and the
 * page needs two things from each: who wrote it, for the drawer, and what kind
 * of source it was, for the dot. Nothing else — not the text somebody submitted,
 * not the contributions behind trees this reader cannot see.
 */
export function contributionsBehind(trees) {
  const wanted = new Set();
  for (const tree of trees) {
    for (const node of [tree?.goal, ...(tree?.records || []), ...(tree?.tasks || [])].filter(Boolean)) {
      for (const id of node.sourceContributionIds || []) wanted.add(id);
    }
  }
  if (wanted.size === 0) return {};
  return Object.fromEntries(
    readContributions()
      .filter(c => wanted.has(c.id))
      .map(c => [c.id, { id: c.id, author: c.author || null, source: c.source || null }]),
  );
}
