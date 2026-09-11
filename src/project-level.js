/**
 * "The project itself" as a target, distinct from any workstream.
 *
 * A workstream used to be the only thing you could point at, and `main` was the
 * one you got by default — which made it the project in practice while being a
 * workstream in the data. Nothing could tell the two roles apart, so nothing
 * could inherit from one into the other.
 *
 * Project level is represented as `null` rather than a reserved string. A
 * sentinel id would recreate exactly what `main` was: a value that looks like a
 * workstream everywhere it is passed, and is not one.
 */
export const PROJECT_LEVEL = null;

/**
 * The id `main` carried before this existed.
 *
 * Kept as a name rather than scattered literals because every remaining mention
 * is a place that has to resolve to project level, and they are easier to find
 * and remove when they are all spelled the same way.
 */
export const LEGACY_MAIN = 'main';

/**
 * Is this target the project rather than a workstream?
 *
 * `main` counts, so a stored preference, a saved config or a `--workstream main`
 * typed from memory keeps working after migration instead of failing to resolve.
 */
export function isProjectLevel(id) {
  if (id === null || id === undefined || id === '') return true;
  return String(id).trim() === LEGACY_MAIN;
}

/** Normalise any of the ways project level arrives into the one value. */
export function resolveTarget(id) {
  return isProjectLevel(id) ? PROJECT_LEVEL : String(id).trim();
}

/** What to call it in a sentence a person reads. */
export function targetLabel(id, projectName) {
  return isProjectLevel(id) ? (projectName || 'the project') : id;
}
