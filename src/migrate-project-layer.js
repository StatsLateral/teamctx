import {
  readConfig, writeConfig,
  readWorkstream, readWorkstreamMd, deleteWorkstream,
  readProject, readProjectMd, writeProject, writeProjectMd, listWorkstreamIds,
  readContributions,
} from './storage.js';
import { LEGACY_MAIN } from './project-level.js';
import { serializeToMd } from './context.js';
import { recompileInheritors } from './recompile.js';

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

/** What is already there, then what `main` adds — never a duplicate id. */
function mergeById(existing, incoming) {
  const kept = Array.isArray(existing) ? existing : [];
  const seen = new Set(kept.map(x => x.id));
  return [...kept, ...(Array.isArray(incoming) ? incoming : []).filter(x => !seen.has(x.id))];
}

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
  const merged = mergeById(existing.whys, main?.whys);
  // Tasks live inside the tree file, so `main`'s went with it when it was
  // deleted — every open task on a project that had never split, gone at the
  // moment of upgrade. They keep their own `workstream: "main"`, which already
  // reads as project level everywhere, so nothing about them is rewritten.
  const tasks = mergeById(existing.tasks, main?.tasks);

  const projectTree = {
    // The project's name, not the workstream's. `main` was usually named after
    // the project anyway, but where it was not, the project's own name is the
    // truthful one.
    name: config.project || existing.name || main?.name || '',
    whys: merged,
    ...(tasks.length ? { tasks } : {}),
  };
  writeProject(projectTree, teamctxDir);

  // Compiled from the tree just written, not copied from `main`'s markdown.
  // Copying was wrong in both directions: where a project page already existed
  // it was kept while `main`'s whys were merged in underneath it, so the page
  // and the tree disagreed; and where it did not, the copy described only
  // `main`'s half. Rendering is deterministic, so this always matches.
  const contributions = readContributions(teamctxDir);
  if (mainMd || merged.length || readProjectMd(teamctxDir)) {
    writeProjectMd(serializeToMd(projectTree, projectTree.name, '', contributions), teamctxDir);
  }

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

  // And after it, so `main` is not among them: a workstream that survives the
  // migration starts inheriting the project tree, and its compiled page would
  // otherwise show no inherited section until something happened to rewrite it.
  recompileInheritors({
    project: projectTree,
    config: { ...config, workstreams: (config.workstreams || []).filter(w => w.id !== LEGACY_MAIN) },
    contributions,
    teamctxDir,
  });

  return true;
}
