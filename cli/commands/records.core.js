import { readConfig, readProject, readWorkstream } from '../../src/storage.js';
import { isActive, numberWorkstreams, workstreamTree, today } from '../../src/model.js';
import { inScope } from '../../src/member-scope.js';

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
