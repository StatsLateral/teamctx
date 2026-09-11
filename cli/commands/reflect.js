import { ask } from '../prompt.js';
import { readConfig, readContributions } from '../../src/storage.js';
import { serializeToMd } from '../../src/context.js';
import { reflectWorkstream } from './reflect.core.js';
import { isProjectLevel, targetLabel } from '../../src/project-level.js';

/**
 * `teamctx reflect`, over the same code the MCP server calls.
 *
 * This was a second implementation, and the two had already diverged: only this
 * one preserved provenance through a rewrite. Sharing the path is what stops
 * that happening again — everything below is presentation and the y/n.
 */
export async function reflectCommand(opts = {}) {
  const config = readConfig();
  let r;
  try {
    r = await reflectWorkstream({
      workstreamId: opts.workstream,
      onProposed: async ({ updated, targetId }) => {
        const name = targetLabel(targetId, config.project);
        console.log(`\n→ Reviewing ${isProjectLevel(targetId) ? 'the project' : `workstream "${targetId}"`} (${name})...\n`);
        console.log('Proposed reflected context:\n');
        console.log(serializeToMd(updated, name, '', readContributions()));
        return (await ask('Apply this reflection? (y/n)', 'y')).toLowerCase() === 'y';
      },
    });
  } catch (err) {
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
    return;
  }

  if (!r.applied) { console.log('Reflection discarded.'); return; }
  if (r.rolesRegenerated.length) {
    console.log(`\n→ Regenerated ${r.rolesRegenerated.length} role file${r.rolesRegenerated.length !== 1 ? 's' : ''}: ${r.rolesRegenerated.join(', ')}`);
  }
  if (r.pushError) console.log(`Push failed (${r.pushError}) — run \`git push\` manually.`);
  console.log('\n✓ Context reflected and committed.');
}
