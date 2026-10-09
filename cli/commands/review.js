import { listPendingReviews, approveReview, rejectReview, ManagerGateError, QueueItemNotFoundError } from './review.core.js';
import { contradictionLabel, evidenceLabel, ContradictionResolutionError } from '../../src/contradictions.js';

export async function reviewListCommand() {
  const queue = await listPendingReviews();
  if (queue.length === 0) {
    console.log('\nNo pending contributions.\n');
    return;
  }

  console.log(`\n${queue.length} pending contribution${queue.length !== 1 ? 's' : ''}:\n`);
  const header = ['ID', 'Author', 'Created', 'Ops', 'Summary'];
  const rows = queue.map(p => [
    p.id,
    p.author || '-',
    p.createdAt || '-',
    String((p.operations || []).length),
    (p.summary || '').slice(0, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(fmt(r)));
  for (const item of queue) {
    for (const conflict of item.contradictions || []) console.log(`\n${item.id}: ${contradictionLabel(conflict)}`);
    for (const op of (item.operations || []).filter(o => o?.type === 'addEvidence')) console.log(`\n${item.id}: ${evidenceLabel(op)}`);
  }
  console.log('');
}

function handleCliError(err) {
  if (err instanceof ManagerGateError || err instanceof QueueItemNotFoundError || err instanceof ContradictionResolutionError) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function reviewApproveCommand(id, opts = {}) {
  let result;
  try { result = await approveReview({ id, ...(opts.replaces?.length ? { replaces: opts.replaces } : {}) }); }
  catch (err) { handleCliError(err); return; }

  if (result.rolesRegenerated.length > 0) {
    console.log(`→ Regenerating ${result.rolesRegenerated.length} role file${result.rolesRegenerated.length !== 1 ? 's' : ''}...`);
    result.rolesRegenerated.forEach(slug => process.stdout.write(`  ✓ ${slug}.md\n`));
  }

  if (result.pushed) {
    console.log('\n✓ Approved, committed, and pushed.');
  } else if (result.pushError) {
    console.log(`\n✓ Approved and committed. Push failed (${result.pushError}) — run \`git push\` manually.`);
  } else {
    console.log('\n✓ Approved and committed. Run `git push` to share with your team.');
  }
  if (result.task) printAccepted(result);
}

/**
 * After accepting work for a task (#144): the task is done, and what the AI
 * suggests might follow, each with the command that adds it. Nothing is added
 * until one of those is run.
 */
export function acceptedLines({ task, nextSteps = [], alreadyDone = false }) {
  // A title came from a model reading somebody's submitted work, and these lines
  // are meant to be pasted into a shell. Single quotes, so nothing in it can run.
  const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const which = task.key || task.id;
  if (alreadyDone) return [`  Task ${which} was already done: this work is recorded, and nothing else changed.`, ''];
  const lines = [`  Task ${which} is marked done. Nothing was published or sent.`];
  if (!nextSteps.length) return [...lines, '  No follow-on tasks suggested.', ''];
  lines.push('', '  Suggested by AI as next steps. Nothing is added until you add one:');
  for (const s of nextSteps) {
    lines.push(`  - ${s.title}${s.owner ? ` (${s.owner})` : ''}`);
    lines.push(`      teamctx task add ${sq(s.title)} --workstream ${sq(task.workstream)} --suggested-after ${sq(which)}${s.owner ? ` --owner ${sq(s.owner)}` : ''}`);
  }
  return [...lines, ''];
}

function printAccepted(result) {
  for (const line of acceptedLines(result)) console.log(line);
}

export async function reviewRejectCommand(id, opts) {
  let result;
  try { result = await rejectReview({ id, reason: opts?.reason }); }
  catch (err) { handleCliError(err); return; }

  const reasonNote = result.reason ? ` (reason: ${result.reason})` : '';
  if (result.pushed) {
    console.log(`\n✓ Rejected contribution ${result.id}${reasonNote}. Archived, committed, and pushed.\n`);
  } else if (result.pushError) {
    console.log(`\n✓ Rejected contribution ${result.id}${reasonNote}. Archived and committed. Push failed (${result.pushError}) — run \`git push\` manually.\n`);
  } else {
    console.log(`\n✓ Rejected contribution ${result.id}${reasonNote}. Archived to .teamctx/rejected/ and committed. Run \`git push\` to share with your team.\n`);
  }
}
