import { listWorkstreamIds, readWorkstream, writeWorkstreamMd } from './storage.js';
import { serializeToMd } from './context.js';

/**
 * Push a changed project tree into every workstream's compiled page.
 *
 * Inheritance is concatenation at compile time, never a copy — but a compiled
 * page is written once and then sits there. So a change at project level landed
 * correctly in `project.json`, and every workstream's page went on showing the
 * project as it was before, which is the version a member actually reads.
 *
 * Cheap on purpose: serializing a tree is string work, no AI call, so a
 * project-level contribution costs the same as it did before plus one pass over
 * the workstreams. Role files are the other half of this and are not refreshed
 * here, because each one is an AI call — a project with eight roles would spend
 * eight of them on every sentence the manager adds. A role file catches up when
 * its own workstream is next contributed to, reflected, or approved into.
 */
export function recompileInheritors({ project, config, contributions = [], teamctxDir } = {}) {
  const named = config?.workstreams || [];
  const ids = listWorkstreamIds(teamctxDir);
  for (const id of ids) {
    const workstream = readWorkstream(id, teamctxDir);
    const name = named.find(w => w.id === id)?.name || workstream.name || id;
    writeWorkstreamMd(
      id,
      serializeToMd(workstream, name, '', contributions, { project }),
      teamctxDir,
    );
  }
  return ids;
}
