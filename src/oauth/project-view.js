import { GithubSession } from '../adapters/github.js';
import { runWithSession } from '../session-context.js';
import { readConfig, readProject, readWorkstream, listTasks, readContributions, listWorkstreamIds } from '../storage.js';
import { listAllWorkstreams } from '../../cli/commands/workstream.core.js';
import { listMembers, memberByEmail } from '../../cli/commands/member.core.js';
import { listPendingReviews, approveReview, rejectReview } from '../../cli/commands/review.core.js';
import { scopeFor, inScope } from '../member-scope.js';
import { resolveTarget } from '../project-level.js';
import { workstreamLocation } from '../views/workstream-location.js';
import { managerKeys, matchesActor } from '../review.js';
import { flaggedInProject, projectRecords } from '../project-records.js';
import { markNeedsReview, restingOn, needsReviewFlags } from '../impact.js';
import { runWithActor } from '../actor.js';
import { today } from '../model.js';
import { kvGet, keys } from './kv.js';
import { githubIdsFor, readPersonalKey, readProjectKeys, pickProjectKey } from './ai-keys.js';
import { managersOf } from '../managers.js';
import { runWithAiKey } from '../ai-context.js';

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

/**
 * Open a project as the person signed in: their credential (or the one the
 * project lends a Google sign-in), a session over the repository, and every
 * identity they have proved.
 *
 * Shared by reading the page and by acting on its review queue, so an approval
 * is made by exactly the person, through exactly the credential, that the page
 * was read with — never a wider one.
 */
async function openProject({ owner, repo, user }) {
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
  return { session, actor, checkRoster };
}

/**
 * What needs the manager's second look, across the whole project (#118 §2).
 *
 * Three groups, each row naming where it lives: broken assumptions with what
 * rests on them, assumptions past their check-by date, and exceptions ending
 * within fourteen days (or already ended while still marked active). Read over
 * every part of the work, which is why only a manager is ever given it.
 *
 * A dependent the manager has already re-confirmed is listed as such rather
 * than left out, so the list for a broken assumption is the whole story.
 */
/** The same day arithmetic `listRecords({ due })` uses for "ending soon". */
const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

function needsReviewSection({ config, workstreams, onDay = today() }) {
  const trees = [{ id: null, tree: readProject() }, ...listWorkstreamIds().map(id => ({ id, tree: readWorkstream(id) }))];
  const where = (id) => workstreamLocation(workstreams, id, config.project);
  const all = [];
  for (const { id, tree } of trees) for (const r of tree?.records || []) all.push({ ...r, ws: id });
  const tasks = [];
  for (const { id, tree } of trees) for (const t of tree?.tasks || []) tasks.push({ ...t, ws: id });
  const flagged = needsReviewFlags(all, { onDay });
  const brief = (r) => ({ id: r.id, key: r.key || null, type: r.type, text: r.text, ws: r.ws, where: where(r.ws) });

  const broken = all.filter(r => r.type === 'assumption' && r.status === 'broken').map(a => {
    const { records, tasks: onTasks } = restingOn(all, a.id, { onDay, tasks });
    return {
      ...brief(a),
      brokenAt: a.brokenAt || null,
      restingOn: records.map(r => ({ ...brief(r), stillFlagged: flagged.has(r.id) })),
      tasks: onTasks.map(t => ({ id: t.id, key: t.key || null, title: t.title, ws: t.ws, where: where(t.ws) })),
    };
  });
  const overdue = all
    .filter(r => r.type === 'assumption' && r.status === 'active' && r.reviewBy && r.reviewBy < onDay)
    .map(r => ({ ...brief(r), reviewBy: r.reviewBy, owner: r.owner?.name || null }));
  const soon = addDays(onDay, 14);
  const ending = all
    .filter(r => r.type === 'exception' && r.status === 'active' && r.expiresAt && r.expiresAt <= soon)
    .map(r => ({ ...brief(r), expiresAt: r.expiresAt, ended: r.expiresAt < onDay }));
  return { broken, overdue, ending };
}

/**
 * Approve or reject a queued contribution from the page (#118 §1).
 *
 * The same `approveReview` and `rejectReview` the CLI and the assistant use, run
 * as the signed-in person inside their own session — so the manager gate is the
 * one those already apply, and a non-manager gets the refusal they would get
 * anywhere else. Nothing is decided here that is not decided there.
 */
export async function actOnReview({ owner, repo, user, id, action, replaces = [], reason = '' }) {
  const { session, actor } = await openProject({ owner, repo, user });
  const act = () => runWithSession(session, () => runWithActor(actor, async () => {
    if (action === 'reject') return rejectReview({ id, reason: reason || undefined });
    return approveReview({ id, ...(replaces.length ? { replaces } : {}) });
  }));
  if (action === 'reject') return act();

  // Approving refreshes the role briefs for that part of the work, which is an
  // AI call — the same one approving from an assistant makes. The key is chosen
  // the way the connector chooses it: the approver's own first, then the key
  // the project's primary manager shared. Only a part with roles spends it.
  // Viewing the page still never calls AI; see the proposal for why acting on
  // it is different.
  const own = await readPersonalKey({ email: user.email, githubId: user.id }).catch(() => null);
  const projectKeys = await readProjectKeys(owner, repo).catch(() => null);
  const shared = () => runWithSession(session, () => {
    const picked = pickProjectKey({ projectKeys, primaryKey: managersOf(readConfig()).primary });
    return picked ? { apiKey: picked.apiKey, provider: picked.provider } : null;
  });
  return runWithAiKey(own?.apiKey || null, act, own?.provider || null, own?.apiKey ? null : shared);
}

export async function readProjectView({ owner, repo, user }) {
  const { session, actor, checkRoster } = await openProject({ owner, repo, user });

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
    //
    // What rests on a broken assumption is worked out over every record in the
    // project, including parts of the work this reader is not on — a decision
    // here can rest on an assumption there. Only the mark crosses that line: it
    // is written onto the records being sent, so no set of ids from elsewhere
    // travels with the payload, and the broken assumption's own words never do.
    const flagged = flaggedInProject(undefined);
    const marked = (tree) => ({ ...tree, records: markNeedsReview(tree?.records, flagged) });
    const projectTree = marked(readProject());
    const trees = Object.fromEntries(
      workstreams.map(w => [w.id, marked(readWorkstream(w.id) || { id: w.id, name: w.name, records: [], tasks: [] })]),
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
    // What a queued break would take with it, so the manager reads the impact
    // beside the evidence instead of after approving. Worked out over every
    // record, because what rests on an assumption may sit in any part of the
    // work — and only for a manager, who may see all of it; the queue is theirs.
    const everything = isManager ? projectRecords(undefined) : [];
    // A queue item is somebody else's file until proven otherwise: a list that
    // is not a list must not take the page down.
    const impactOf = (operations) => (Array.isArray(operations) ? operations : [])
      .filter(o => o?.type === 'setRecordStatus' && o.status === 'broken')
      .map(o => everything.find(r => r.id === o.id))
      .filter(r => r?.type === 'assumption')
      .map(a => ({
        id: a.id,
        text: a.text,
        records: restingOn(everything, a.id).records.map(r => ({ id: r.id, key: r.key || null, type: r.type, text: r.text })),
      }));
    const pending = isManager
      ? (await listPendingReviews({})).map(q => ({
        id: q.id,
        author: q.author,
        summary: q.summary,
        createdAt: q.createdAt || null,
        source: q.source || null,
        operations: q.operations || [],
        contradictions: q.contradictions || [],
        impact: impactOf(q.operations),
        workstream: resolveTarget(q.workstream),
        where: workstreamLocation(workstreams, resolveTarget(q.workstream), config.project),
      }))
      : null;

    return {
      project: config.project,
      owner,
      repo,
      isManager,
      // Read across every part of the work, so a manager's alone — a member's
      // page data has nothing from outside their parts.
      needsReview: isManager ? needsReviewSection({ config, workstreams }) : null,
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
