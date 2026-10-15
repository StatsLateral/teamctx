import { GithubSession } from '../adapters/github.js';
import { runWithSession } from '../session-context.js';
import { readConfig, readProject, readWorkstream, listTasks, readContributions, readApprovals, listRejected, listQueue, listOutputs, listChanges, readSourceRefs } from '../storage.js';
import { outputStates, outputsForReader } from '../outputs.js';
import { visibleSources } from '../sources.js';
import { taskHistory, touchesTask } from '../task-history.js';
import { listAllWorkstreams } from '../../cli/commands/workstream.core.js';
import { listMembers, memberByEmail } from '../../cli/commands/member.core.js';
import { listPendingReviews } from '../../cli/commands/review.core.js';
import { scopeFor, inScope } from '../member-scope.js';
import { resolveTarget } from '../project-level.js';
import { ancestorsOf } from '../model.js';
import { changesReaching, lastActivity, changedSummary, labelFor } from '../changes.js';
import { workstreamLocation } from '../views/workstream-location.js';
import { managerKeys, matchesActor } from '../review.js';
import { flaggedInProject, projectRecords } from '../project-records.js';
import { markNeedsReview, restingOn } from '../impact.js';
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

/**
 * Open a project as somebody, and run `body` inside it.
 *
 * Every page that reads a project starts the same way: a credential, the
 * repository, who this person has proved they are, and the checks that decide
 * whether they may look at all. Kept in one place so a new page cannot skip one.
 */
async function openProject({ owner, repo, user }, body) {
  const { ghToken, actor, checkRoster } = await accessFor({ owner, repo, user });
  const session = new GithubSession({ owner, repo, ghToken });
  try {
    await session.prefetch();
  } catch (e) {
    // GitHub refusing the credential itself is not "could not be read": nothing
    // is wrong with the project, and the person looking can do something about
    // it. Raw GitHub JSON told a team member nothing — least of all that the one
    // who can fix it is the manager, not them.
    if (/→ 401\b/.test(e.message)) {
      throw new ProjectViewError(checkRoster
        ? `${owner}/${repo} is shared through GitHub access its manager lent, and GitHub no longer accepts it. `
          + 'Nothing is wrong with your account. Ask the manager to lend the access again from teamctx Settings.'
        : 'GitHub no longer accepts your sign-in. Sign out and sign in again.');
    }
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
    return body({ config, actor, isManager, allowed });
  });
}

export async function readProjectView({ owner, repo, user }) {
  return openProject({ owner, repo, user }, async ({ config, actor, isManager, allowed }) => {
    const members = listMembers({}).filter(m => m.kind !== 'agent');
    const agents = listMembers({}).filter(m => m.kind === 'agent');
    const everyPart = await listAllWorkstreams({});
    const workstreams = everyPart
      .filter(w => inScope(allowed, w.id))
      .map(w => ({ ...w, members: membersOn(members, w.id).map(m => m.name) }));
    // Only how many parts the reader cannot see, never which. A prompt says "1
    // part you cannot see" so what is missing is never mistaken for what is absent.
    const hiddenParts = everyPart.length - workstreams.length;

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

    // A task's history (#143), from the contribution log, the approval and
    // rejection files, the queue and the task's status log. What was turned
    // down and what is waiting are the manager's to see, as the queue is; and
    // a name nobody on this roster answers to is shown as "someone".
    const contributionLog = Object.fromEntries(readContributions().map(c => [c.id, c]));
    const approvals = readApprovals();
    const rejected = isManager ? listRejected() : [];
    const queued = isManager ? await listPendingReviews({}) : [];
    const managerSet = new Set(managerKeys(config));
    const rosterKeys = new Set([...members, ...agents].map(m => m.key).filter(Boolean));
    const visible = new Set([...members, ...agents].map(m => m.name).filter(Boolean));
    const vouched = (who, key) => { if (who && key && (managerSet.has(key) || rosterKeys.has(key))) visible.add(who); };
    for (const a of Object.values(approvals)) vouched(a.approvedBy?.name, a.approvedBy?.key);
    for (const r of rejected) vouched(r.rejectedBy, r.rejectedByKey);
    const allTasks = listTasks({}, undefined);
    for (const t of allTasks) {
      vouched(t.addedBy?.name, t.addedBy?.key);
      for (const e of t.statusLog || []) vouched(e.by?.name, e.by?.key);
    }
    const agentNames = new Set(agents.map(a => a.name));
    const historyOf = (task, pending = []) => taskHistory({
      task, contributions: contributionLog, approvals, rejected, queue: queued, pending,
      canSee: (name) => isManager || visible.has(name), isAgent: (name) => agentNames.has(name),
    });

    // What has been produced on each task (#197). Every output on a task the
    // reader can see is theirs to see, so this follows the same scope filter as
    // the task itself. Where each stands is worked out from the queue and the
    // approvals: only the ids on waiting items are read here, so a member sees
    // their own work as waiting without seeing anybody's queue. The reason a
    // submission was turned down is read for everyone but handed on only to its
    // author and the manager (see outputsForReader).
    const waitingOutputs = new Set(listQueue().flatMap(q => (Array.isArray(q.outputs) ? q.outputs : [])));
    const everyRejection = listRejected();
    const actorKeys = [actor.key, ...(actor.keys || [])];
    // A task file is the repository's, so an id that is not a plain one has no
    // outputs rather than taking the page down.
    const savedOn = (task) => { try { return listOutputs(task.id); } catch { return []; } };
    const outputsOn = (task, saved) => outputsForReader({
      outputs: outputStates(saved, { approvals, waiting: waitingOutputs }),
      rejected: everyRejection.filter(r => r?.forTask === task.id),
      actorKeys, isManager, canSee: (name) => visible.has(name),
      assigned: (!!task.ownerKey && actorKeys.includes(task.ownerKey))
        || (config.members || []).some(m => m?.key && actorKeys.includes(m.key) && !!task.owner && m.name === task.owner),
    });

    // The log is read once and indexed in memory: on hosted storage every read
    // is a request, so reading it per task would be one per row.
    const allChanges = listChanges({});
    const tasks = allTasks
      .filter(t => inScope(allowed, resolveTarget(t.workstream)))
      .map(t => {
        const saved = savedOn(t);
        return {
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
          history: historyOf(t),
          outputs: outputsOn(t, saved),
          // Only the project, the ancestors, the own part and changes touching
          // this task: a sibling part's changes are not this reader's to see.
          changedSince: (() => {
            // In progress means not done: an accepted task's own accepted work
            // would otherwise flag it for good.
            if (t.status === 'done') return null;
            const since = lastActivity({ outputs: saved, task: t });
            if (!since) return null;
            const ws = resolveTarget(t.workstream);
            const trees = [null, ...(ws ? [...ancestorsOf(config, ws), ws] : [])];
            const found = changesReaching({ entries: allChanges, trees, since });
            return found.changes.length ? changedSummary(found, labelFor(config)) : null;
          })(),
        };
      });

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
        records: restingOn(everything, a.id).records.map(r => ({ id: r.id, type: r.type, text: r.text })),
      }));
    const pending = isManager
      ? queued.map(q => ({
        id: q.id,
        // The number it is known by while it waits, if its workstream gave it one.
        number: q.number || null,
        author: q.author,
        summary: q.summary,
        createdAt: q.createdAt || null,
        source: q.source || null,
        operations: q.operations || [],
        // Work submitted for a task: the outputs in full, which the manager is
        // asked about, rather than a line describing them.
        ...(q.forTask ? { forTask: q.forTask, submittedOutputs: q.submittedOutputs || [] } : {}),
        reachLines: q.reachLines || [],
        contradictions: Array.isArray(q.contradictions) ? q.contradictions : [],
        impact: impactOf(q.operations),
        workstream: resolveTarget(q.workstream),
        where: workstreamLocation(workstreams, resolveTarget(q.workstream), config.project),
        // A change to a task shows that task's whole history, this submission at
        // the end; anything else is not approved yet, and this is all there is.
        history: (() => {
          const task = allTasks.find(t => touchesTask(q, t.id));
          return task ? historyOf(task) : historyOf(null, [q]);
        })(),
      }))
      : null;

    // What the project was drawn from (#168), for the Connected sources drawer.
    // A feed counts once its contribution is approved, as the queue is the
    // manager's: a member sees nothing of what is still waiting or was turned
    // down, and a manager sees what is waiting, marked as such. Only feeds in
    // this reader's parts are kept, and what is shown of a reference comes from
    // those alone. A name is shown as the roster has it for the key that wrote
    // it, so a name somebody typed for themselves is not taken at its word.
    const waitingIds = new Set(queued.map(q => q.id));
    const nameByKey = new Map([...members, ...agents].filter(m => m.key).map(m => [m.key, m.name]));
    const whoBrought = (by) => (!by ? null
      : nameByKey.get(by.key) || (managerSet.has(by.key) ? by.name : 'someone'));
    const connectedSources = () => visibleSources(readSourceRefs(), {
      canSee: ws => inScope(allowed, resolveTarget(ws)),
      counts: f => Boolean(approvals[f.contribution]) || waitingIds.has(f.contribution),
    }).map(r => ({
      id: r.id,
      connector: typeof r.connector === 'string' ? r.connector : 'other',
      title: String(r.title || ''),
      link: typeof r.link === 'string' && /^https?:\/\//i.test(r.link) ? r.link : null,
      summary: String(r.summary || ''),
      lastReadAt: r.lastReadAt || null,
      by: whoBrought(r.by),
      feeds: r.feeds.map(f => ({
        where: workstreamLocation(workstreams, resolveTarget(f.workstream), config.project),
        task: f.task ? (allTasks.find(t => t.id === f.task)?.key || null) : null,
        ...(waitingIds.has(f.contribution) && !approvals[f.contribution] ? { waiting: true } : {}),
      })),
    }));

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
      hiddenParts,
      members: members.map(m => ({
        name: m.name,
        email: m.email || null,
        on: m.workstreams?.length ? m.workstreams : null,
        // How the team page groups them: set by a manager, absent for a regular member.
        external: m.external === true,
        manager: managerKeys(config).some(k => matchesActor(k, { key: m.key, email: m.email, login: m.login })),
      })),
      agents: agents.map(a => ({
        name: a.name,
        on: a.workstreams?.length ? a.workstreams : null,
        addedAt: a.addedAt || null,
      })),
      tasks: {
        open: tasks.filter(t => t.status === 'open'),
        done: tasks.filter(t => t.status === 'done'),
      },
      pending,
      // What the project was drawn from (#168), for the Connected sources
      // drawer: only references that feed a part of the work this reader can
      // see, each with only those feeds. Built field by field, so nothing else
      // in the record reaches the page.
      sources: connectedSources(),
    };
  });
}


/**
 * Every contribution the project has received, newest first, and where each stands.
 *
 * What the page groups and shows is a flat list; this settles the one thing a
 * list from the log cannot say on its own, which is what became of each — taken
 * into the shared context, turned down, or still waiting for the manager.
 *
 * The manager's alone. The log holds what people typed, across every part of the
 * work, and the queue and the turned-down items are already the manager's to see;
 * a page listing all of it for anybody else would be a way round that.
 */
export async function readContributionsView({ owner, repo, user }) {
  return openProject({ owner, repo, user }, async ({ config, isManager }) => {
    if (!isManager) throw new ProjectViewError('Only the manager of this project can see all of its contributions.');
    const parts = await listAllWorkstreams({});
    const approvals = readApprovals();
    const rejected = new Set(listRejected().map(r => r.id));
    const waiting = new Set((await listPendingReviews({})).map(q => q.id));
    const status = (c) => (approvals[c.id] ? 'taken in'
      : rejected.has(c.id) ? 'turned down'
        : waiting.has(c.id) ? 'waiting' : 'logged');
    const contributions = readContributions()
      .map(c => ({
        id: c.id,
        at: c.ts || null,
        author: c.author || 'Unknown',
        text: String(c.text || ''),
        source: c.source || null,
        where: workstreamLocation(parts, resolveTarget(c.workstream), config.project),
        status: status(c),
      }))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return { project: config.project, owner, repo, contributions };
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
