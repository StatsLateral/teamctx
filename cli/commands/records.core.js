import { readConfig, readProject, readWorkstream, readContributions, readApprovals } from '../../src/storage.js';
import { isActive, numberWorkstreams, workstreamTree, today } from '../../src/model.js';
import { inScope } from '../../src/member-scope.js';
import { recordTrail } from '../../src/record-history.js';

/**
 * Reading governed records — rules, decisions, assumptions, exceptions, open
 * questions, risks and reasons — across the parts of the work a caller may see.
 *
 * Scope is applied by never reading an out-of-scope workstream at all, so a
 * record outside it cannot appear in a result by any filter.
 */

export class RecordNotFoundError extends Error {
  constructor(id) {
    super(`no record "${id}" on this project`);
    this.code = 'RECORD_NOT_FOUND';
  }
}

function visibleTrees(teamctxDir, config, scope) {
  const ids = [];
  const walk = (nodes) => nodes.forEach(n => { ids.push(n.id); walk(n.children); });
  walk(workstreamTree(config));
  return [
    { id: null, tree: readProject(teamctxDir) },
    ...ids.filter(id => inScope(scope, id)).map(id => ({ id, tree: readWorkstream(id, teamctxDir) })),
  ];
}

const addDays = (day, n) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);

export function listRecords({
  teamctxDir, scope = null, type, status, workstream, owner, due, onDay = today(),
} = {}) {
  const config = readConfig(teamctxDir);
  const numbers = numberWorkstreams(config);
  const soon = addDays(onDay, 14);
  return visibleTrees(teamctxDir, config, scope).flatMap(({ id, tree }) => (tree.records || [])
    .filter(r => (status ? r.status === status : isActive(r, onDay)))
    .filter(r => !type || r.type === type)
    .filter(r => workstream === undefined || id === workstream)
    .filter(r => !owner || r.owner?.name === owner || r.owner?.key === owner)
    .filter(r => !due
      || (r.type === 'assumption' && !!r.reviewBy && r.reviewBy <= onDay)
      || (r.type === 'exception' && !!r.expiresAt && r.expiresAt <= soon))
    .map(r => ({ ...r, workstream: id, number: id ? numbers.get(id) || null : null })));
}

export function getRecord({ teamctxDir, scope = null, id } = {}) {
  const config = readConfig(teamctxDir);
  for (const { id: ws, tree } of visibleTrees(teamctxDir, config, scope)) {
    const r = (tree.records || []).find(x => x.id === id);
    if (r) return { ...r, workstream: ws, number: ws ? numberWorkstreams(config).get(ws) || null : null };
  }
  throw new RecordNotFoundError(id);
}

/**
 * A record's trail (#265): its versions oldest → newest, who changed and
 * approved it, and the records it replaced or that replaced it. Reads only the
 * parts of the work the caller may see, and `canSee` decides whose names it may
 * show — a name it may not comes back as "someone", never guessed.
 */
export function recordTrailFor({ teamctxDir, scope = null, id, canSee = () => true } = {}) {
  const config = readConfig(teamctxDir);
  let record = null;
  const records = [];
  for (const { tree } of visibleTrees(teamctxDir, config, scope)) {
    for (const r of (tree.records || [])) {
      records.push(r);
      if (r.id === id) record = r;
    }
  }
  if (!record) throw new RecordNotFoundError(id);
  const contributions = Object.fromEntries(readContributions(teamctxDir).map(c => [c.id, c]));
  const approvals = readApprovals(teamctxDir);
  return recordTrail({ record, records, contributions, approvals, canSee });
}
