import {
  readConfig, writeConfig,
  readWorkstream, readWorkstreamMd, deleteWorkstream,
  readProject, readProjectMd, writeProject, writeProjectMd, listWorkstreamIds,
} from './storage.js';
import { LEGACY_MAIN } from './project-level.js';

/**
 * Fold `main` into the project tree.
 *
 * `main` was created at `init` and quietly did two jobs: it was a workstream,
 * and it was where "the project" lived because nothing else could be. Once the
 * project has a tree of its own there is no work left for it, and leaving it
 * would mean two places claiming to be the base.
 *
 * Deliberately session-aware rather than filesystem-only, unlike the workstreams
 * migration it mirrors. That one predates hosted mode and so only ever ran on a
 * clone; a hosted project would have sat unmigrated forever, which is where most
 * projects now are.
 *
 * The test that matters is not that it moves the data. It is that a project
 * whose only workstream was `main` cannot tell this happened: same content, same
 * compiled output, one fewer concept.
 */
export function migrateProjectLayer(teamctxDir) {
  let config;
  try { config = readConfig(teamctxDir); } catch { return false; }
  if (config.projectLayerMigrated) return false;

  // Read before anything is written, so a half-finished run leaves the old
  // shape intact rather than a project tree and a workstream both claiming it.
  const hadMain = listWorkstreamIds(teamctxDir).includes(LEGACY_MAIN)
    || (config.workstreams || []).some(w => w.id === LEGACY_MAIN);
  const main = hadMain ? readWorkstream(LEGACY_MAIN, teamctxDir) : null;
  const mainMd = hadMain ? readWorkstreamMd(LEGACY_MAIN, teamctxDir) : '';

  // A project tree can already exist before this runs. It should not — the
  // migration is what creates one — but a build shipped where a contribution
  // could land at project level on a project that had not migrated yet, and
  // overwriting would destroy exactly the writes somebody made in that window.
  // Merged rather than replaced, existing first, `main` appended by id.
  const existing = readProject(teamctxDir);
  const existingWhys = existing.whys || [];
  const seen = new Set(existingWhys.map(w => w.id));
  const merged = [...existingWhys, ...(main?.whys || []).filter(w => !seen.has(w.id))];

  writeProject({
    // The project's name, not the workstream's. `main` was usually named after
    // the project anyway, but where it was not, the project's own name is the
    // truthful one.
    name: config.project || existing.name || main?.name || '',
    whys: merged,
  }, teamctxDir);

  // Same reasoning: a project.md already there was compiled from a tree that
  // includes writes `main`'s copy never saw.
  if (mainMd && !readProjectMd(teamctxDir)) writeProjectMd(mainMd, teamctxDir);

  writeConfig({
    ...config,
    workstreams: (config.workstreams || []).filter(w => w.id !== LEGACY_MAIN),
    // Unset rather than pointed somewhere else: after this, "no active
    // workstream" is a real state meaning the project itself, and picking an
    // arbitrary surviving workstream would silently move where someone works.
    activeWorkstream: null,
    roles: (config.roles || []).map(r => (
      r.workstream === LEGACY_MAIN ? { ...r, workstream: null } : r
    )),
    projectLayerMigrated: true,
  }, teamctxDir);

  // Last, so everything above is durable before the old copy goes.
  if (hadMain) deleteWorkstream(LEGACY_MAIN, teamctxDir);

  return true;
}
