/**
 * The project's records in one list, and which of them owe a second look.
 *
 * `src/impact.js` is deliberately free of storage: it answers questions about a
 * list of records and can be tested without a repository. This is the two lines
 * of wiring that read that list, in one place rather than at each read path.
 *
 * In one place because the wrong version of those two lines is silent. A brief
 * is rendered from the project plus the reader's own chain, so a caller that
 * gathered records from what it already had would miss a decision resting on an
 * assumption recorded in another part of the work — and show that decision as
 * sound. Nothing would fail; a reader would simply be told the wrong thing with
 * no hedge on it.
 */
import { readTree, listWorkstreamIds } from './storage.js';
import { allProjectRecords, flaggedIds } from './impact.js';
import { today } from './model.js';

/** Every record in the project, the project's own tree included. */
export function projectRecords(teamctxDir) {
  return allProjectRecords({
    readTree: (id) => readTree(id, teamctxDir),
    workstreamIds: listWorkstreamIds(teamctxDir),
  });
}

/**
 * The ids of records resting on an assumption that broke.
 *
 * Handed to `renderBrief` as `flagged`. A set, not the map: a brief says a
 * second look is owed and never names the assumption, which may sit in a part of
 * the work this reader is not on.
 */
export function flaggedInProject(teamctxDir, { onDay = today() } = {}) {
  return flaggedIds(projectRecords(teamctxDir), { onDay });
}
