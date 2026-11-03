import { readProject, readConfig, readWorkstream, listWorkstreamIds, readContributions, listTasks } from '../../src/storage.js';
import { resolveActor } from '../../src/actor.js';
import { resolveActiveWorkstream, resolveIdentity } from '../../src/prefs.js';
import { isProjectLevel } from '../../src/project-level.js';
import { contextFreshness, freshnessLine } from '../../src/freshness.js';

export async function statusCommand() {
  const config = readConfig();
  const actor = await resolveActor({ config });
  const identity = await resolveIdentity({ actor, config });
  const activeWorkstream = await resolveActiveWorkstream({ actor, config });
  const contributions = readContributions();

  const wsIds = [...new Set([
    ...(config.workstreams || []).map(w => w.id),
    ...listWorkstreamIds(),
  ])].sort();
  const workstreams = wsIds.map(id => ({ id, tree: readWorkstream(id) }));
  // The project's own records count: a project with no workstreams is a normal
  // shape, and reporting none for one that has plenty would be a lie.
  const project = readProject();
  const active = (t) => (t.records || []).filter(r => r.status === 'active').length;
  const totalRecords = active(project) + workstreams.reduce((n, w) => n + active(w.tree), 0);
  const allTasks = listTasks({});
  const openTasks = allTasks.filter(t => t.status === 'open').length;
  const doneTasks = allTasks.filter(t => t.status === 'done').length;
  const countOf = (type) => [project, ...workstreams.map(w => w.tree)].reduce((n, t) => n + (t.records || []).filter(r => r.type === type && r.status === 'active').length, 0);
  const decisionCount = countOf('decision');
  const compiledTasks = allTasks.filter(t => t.compiledAt).length;

  console.log(`\n${config.project} — teamctx status\n`);
  // A name you set yourself needs no explanation; say where any other came from.
  const fromWhere = ['override', 'config'].includes(identity.source) ? '' : ` (${identity.source})`;
  console.log(`  You:          ${identity.name}${fromWhere}`);
  console.log(`  Model:        ${config.model}`);
  console.log(`  Provider:     ${config.provider || 'anthropic'}`);
  console.log(`  Auto-push:    ${config.autoPush ? 'on' : 'off'}`);
  console.log(`  Goal:         ${project.goal?.text || '(none yet)'}`);
  console.log(`  Records:      ${totalRecords} across ${workstreams.length} workstream${workstreams.length !== 1 ? 's' : ''}`);
  if (workstreams.length > 1) {
    workstreams.forEach(w => {
      const mark = w.id === activeWorkstream ? ' (active)' : '';
      console.log(`    - ${w.id.padEnd(20)} ${(w.tree.records || []).length} records${mark}`);
    });
  }
  console.log(`  Contributions: ${contributions.length} total`);
  console.log(`  Decisions:    ${decisionCount} active`);
  console.log(`  Tasks:        ${openTasks} open, ${doneTasks} done${compiledTasks ? ` (${compiledTasks} compiled)` : ''}`);
  const fresh = freshnessLine(contextFreshness());
  if (fresh) console.log(`  Freshness:    ${fresh}`);
  console.log(`\nRoles (${config.roles.length}):`);

  if (config.roles.length === 0) {
    console.log('  None yet. Run `teamctx role add`.');
  } else {
    config.roles.forEach(r => {
      const url = config.deployUrl ? `${config.deployUrl}/context/${r.slug}` : `[deploy-url]/context/${r.slug}`;
      const wsLabel = isProjectLevel(r.workstream) ? '' : ` [${r.workstream}]`;
      console.log(`  ${r.slug.padEnd(20)} ${r.name}${wsLabel}`);
      console.log(`  ${''.padEnd(20)} ${url}`);
    });
  }
  console.log();
}
