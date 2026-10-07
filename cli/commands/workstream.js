import { ask } from '../prompt.js';
import { readConfig } from '../../src/storage.js';
import { resolveTarget, targetLabel } from '../../src/project-level.js';
import { UnknownWorkstreamError } from './role.core.js';
import {
  listAllWorkstreams, useWorkstream, proposeStructure, addWorkstream, WorkstreamParentError,
} from './workstream.core.js';

function cliError(err) {
  if (err instanceof UnknownWorkstreamError || err instanceof WorkstreamParentError || err?.code === 'MANAGER_GATE') {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function workstreamListCommand() {
  const config = readConfig();
  const workstreams = await listAllWorkstreams();
  if (workstreams.length === 0) {
    console.log('No workstreams yet. Add one with `teamctx workstream add <name>`.\n');
    return;
  }
  console.log(`\nWorkstreams for "${config.project}":\n`);
  workstreams.forEach(w => {
    const marker = w.isActive ? '*' : ' ';
    const indent = '  '.repeat(w.depth || 0);
    console.log(`  ${marker} ${indent}${w.number || '-'} ${w.name}  (id: ${w.id})`);
    console.log(`      ${indent}${w.recordCount} records · ${w.taskCount} tasks · roles: ${w.roles.length ? w.roles.join(', ') : '(none)'}`);
  });
  console.log('\n  * = active workstream (target of `contribute` when --workstream is omitted)\n');
}

export async function workstreamAddCommand(name, opts = {}) {
  try {
    const r = await addWorkstream({ name, parent: opts.under || null });
    console.log(`\n✓ Added ${r.workstream.number} "${r.workstream.name}" (id: ${r.workstream.id})${opts.under ? ` under ${opts.under}` : ''}.`);
    console.log('  Anyone put on it reaches every part below it.\n');
  } catch (err) { cliError(err); }
}

export async function workstreamUseCommand(id) {
  let result;
  try { result = await useWorkstream({ id }); }
  catch (err) { cliError(err); return; }
  console.log(result.activeWorkstream
    ? `✓ Your active workstream is now "${result.activeWorkstream}". (Personal setting — not committed.)`
    : '✓ You are working on the project itself, not on one workstream. (Personal setting — not committed.)');
}

/**
 * `teamctx workstream propose` — how this project might be organised.
 *
 * Prints a draft and stops. Nothing is applied: add the parts you want with
 * `teamctx workstream add`.
 */
export async function workstreamProposeCommand() {
  let r;
  try { r = await proposeStructure(); }
  catch (err) { cliError(err); return; }

  if (!r.workstreams.length) {
    console.log(`\n${r.why || 'This project does not need more than one part yet — that is a fine shape for it.'}\n`);
    return;
  }
  console.log(`\nHow ${r.project} might be organised — a draft, nothing has changed.\n`);
  if (r.goal) console.log(`Goal: ${r.goal}`);
  if (r.why) console.log(`  Why it matters: ${r.why}`);
  console.log('');
  r.workstreams.forEach((w, i) => {
    console.log(`${i + 1}. ${w.name}${w.parent ? ` (under ${w.parent})` : ''}`);
    if (w.rationale) console.log(`   Why together: ${w.rationale}`);
    console.log(`   People: ${w.membership.means}${w.membership.rationale ? ` — ${w.membership.rationale}` : ''}`);
    w.records.forEach(x => console.log(`   - ${x.text}`));
    w.tasks.forEach(t => console.log(`   - Task: ${t}`));
    console.log('');
  });
  if (r.questions.length) {
    console.log('Open questions:');
    r.questions.forEach(q => console.log(`   - ${q}`));
    console.log('');
  }
  console.log('Add the parts you want with `teamctx workstream add <name> [--under <id>]`.\n');
}
