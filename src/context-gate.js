import { readProject, readWorkstream, listWorkstreamIds } from './storage.js';

/**
 * Nobody is brought onto an empty project.
 *
 * A manager can invite somebody the moment a project exists. That person
 * connects, their assistant pulls their brief, and the brief says "No context
 * yet" — the worst first impression the product can make, and one sentence of
 * work away from not happening, because the manager is right there in the
 * conversation when they ask.
 *
 * After the project layer a member reads two trees: the project's context with
 * their own workstream's beneath it. Either half being empty produces a brief
 * that does not stand up, so both are checked — and only both, because a
 * project-wide member inherits the whole project and has no second half.
 *
 * This is a guardrail against a manager moving fast, not a wall. Anyone holding
 * a clone can write a roster entry into config.json by hand, and saying so is
 * worth more than implying a boundary that is not there — the same honesty the
 * workstream scope in src/member-scope.js states about itself.
 */

export class EmptyContextError extends Error {
  constructor(message, { scope, workstream } = {}) {
    super(message);
    this.code = 'EMPTY_CONTEXT';
    /** 'project' or 'workstream' — which half was empty. */
    this.scope = scope;
    /** The workstream id, when that was the empty half. */
    this.workstream = workstream || null;
  }
}

/**
 * Enough to read on a first day: one Why.
 *
 * Not a What and not a How. A Why is the smallest thing a person can open and
 * understand on its own, and asking for more would make this an opinion about
 * how much detail is enough rather than a check that anything is there.
 */
function hasContext(tree) {
  return (tree?.whys || []).length > 0;
}

function workstreamName(config, id) {
  return (config?.workstreams || []).find(w => w.id === id)?.name || id;
}

/**
 * Refuse to put someone somewhere they would arrive to nothing.
 *
 * `scope` is the member's workstreams — `null` for a project-wide member, who
 * is checked against the project alone.
 *
 * The whole call fails when any one workstream is empty. Adding somebody to the
 * others and reporting it would leave them scoped to less than the manager
 * asked for, and nobody finds out until that person cannot see something they
 * were supposed to.
 */
export function assertJoinableContext({ config, scope, who, teamctxDir } = {}) {
  const name = who || 'them';

  if (!hasContext(readProject(teamctxDir))) {
    throw new EmptyContextError(
      `This project has nothing written down yet. Tell me what it's about and `
      + `I'll add it, then we can bring ${name} on.`,
      { scope: 'project' },
    );
  }

  for (const id of scope || []) {
    if (hasContext(readWorkstream(id, teamctxDir))) continue;
    throw new EmptyContextError(
      `"${workstreamName(config, id)}" has nothing written down yet. Tell me what `
      + `that part of the work involves and I'll add it, then we can put ${name} on it.`,
      { scope: 'workstream', workstream: id },
    );
  }
}

/**
 * Does this project hold nothing at all yet?
 *
 * The project's own tree and every workstream's, the same sum `get_status`
 * reports as `totalWhys`. One tree being empty says nothing: a new workstream on
 * a running project starts empty and is not the project starting.
 */
export function projectIsEmpty(teamctxDir) {
  if (hasContext(readProject(teamctxDir))) return false;
  for (const id of listWorkstreamIds(teamctxDir)) {
    if (hasContext(readWorkstream(id, teamctxDir))) return false;
  }
  return true;
}
