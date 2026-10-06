import { LABELS } from '../../src/model.js';
import { ask } from '../prompt.js';
import { contributeCore } from './contribute.core.js';
import { isProjectLevel } from '../../src/project-level.js';
import { contradictionLabel, evidenceLabel } from '../../src/contradictions.js';

/**
 * `teamctx contribute`, over the same code the MCP server calls.
 *
 * This used to be a second implementation of `contributeCore` — its own
 * distillation, its own queue write, its own commit — and the two drifted. The
 * terminal never learned about the review policy, and would have kept writing
 * to a workstream the project layer removed. Everything below is presentation.
 */
export function describeOp(op) {
  if (op.type === 'setGoal') return `+ Goal: ${op.text}`;
  if (op.type === 'addRecord') return `+ ${LABELS[op.record?.type] || 'Note:'} ${op.record?.text}`;
  if (op.type === 'addTask') return `+ Task: ${op.title}`;
  if (op.type === 'editRecord') return `~ Edit ${op.id}: ${op.changes?.text ?? '(details)'}`;
  if (op.type === 'editTask') return `~ Retitle ${op.id}: ${op.title}`;
  // Without this it printed "? addEvidence", which tells the person nothing about
  // the one operation in the contribution that most needs their judgement.
  if (op.type === 'addEvidence') return `! ${evidenceLabel(op)}`;
  if (op.type === 'setRecordStatus') return `~ Mark ${op.against?.key || op.id} ${op.status}`;
  if (op.type === 'removeTask') return `- Remove task ${op.id}`;
  return `? ${op.type}`;
}

export async function contributeCommand(text, opts = {}) {
  let r;
  try {
    r = await contributeCore({
      text,
      workstreamId: opts.workstream,
      decision: !!opts.decision,
      apply: !!opts.apply,
      source: opts.source || 'cli',
      // The terminal's one addition: show what was proposed and let the person
      // stop it before anything is written.
      onProposed: async ({ summary, operations, willQueue, contradictions = [] }) => {
        console.log(`\nProposed changes (${operations.length} op${operations.length !== 1 ? 's' : ''}):`);
        console.log(`  Summary: ${summary}`);
        operations.forEach(op => console.log(`  ${describeOp(op)}`));
        contradictions.forEach(c => console.log(`  ${contradictionLabel(c)}`));
        if (opts.autoApprove) return true;
        // `willQueue` is the core's own decision, not a guess from the flags.
        // Under the `additive` policy — what `init` writes now — an add-only
        // contribution lands straight away, and promising a manager review
        // would be telling somebody their work went somewhere it did not.
        const prompt = willQueue
          ? '\nSubmit for manager approval? (y/n)'
          : '\nApply these changes now? (y/n)';
        return (await ask(prompt, 'y')).toLowerCase() === 'y';
      },
    });
  } catch (err) {
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
    return;
  }

  if (r.mode === 'no-op') {
    console.log('No changes to context tree (contribution logged).');
    return;
  }
  if (r.mode === 'discarded') {
    console.log('Changes discarded. Contribution is logged.');
    return;
  }

  const where = isProjectLevel(r.workstream) ? '' : ` [workstream: ${r.workstream}]`;
  if (r.mode === 'queued') {
    console.log(`\n✓ Submitted for approval (id: ${r.id})${where} — committed.${pushNote(r)}`);
    console.log(`  Manager: after \`git pull\`, run \`teamctx review approve ${r.id}\` or \`teamctx review reject ${r.id}\`.`);
    return;
  }

  if (r.rolesRegenerated?.length) {
    console.log(`\n→ Regenerated ${r.rolesRegenerated.length} role file${r.rolesRegenerated.length !== 1 ? 's' : ''}: ${r.rolesRegenerated.join(', ')}`);
  }
  console.log(`\n✓ Applied${where} — committed.${pushNote(r)}`);
  if (r.keys?.length) console.log(`  Updated: ${r.keys.map(x => x.key).join(', ')}`);
  if (r.founding) printFounding(r.digest);
}

/**
 * What the project's context now holds, printed once.
 *
 * This contribution founded it, usually out of a conversation the person is
 * about to leave, and they should see what it became while correcting it is
 * still cheap.
 */
function printFounding(digest) {
  if (!digest) return;
  const { goal, why, settled, workstreams, counts, more } = digest;
  console.log("\nThis is the project's first context. It now holds:\n");
  if (goal) console.log(`  Goal: ${goal}`);
  if (why) console.log(`  Why it matters: ${why}`);
  for (const x of settled) console.log(`  Settled: ${x}`);
  for (const w of workstreams) console.log(`  ${w.number ? `${w.number} ` : ''}${w.name} — ${w.tasks} task${w.tasks === 1 ? '' : 's'}, ${w.records} record${w.records === 1 ? '' : 's'}`);
  const kinds = Object.entries(counts).filter(([k]) => k !== 'tasks').map(([k, n]) => `${n} ${k}`).join(', ');
  if (kinds || counts.tasks) console.log(`\n  In all: ${[kinds, counts.tasks ? `${counts.tasks} task${counts.tasks === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`);
  if (more) console.log('\n  (trimmed — `teamctx context <role>` prints all of it)');
  console.log('\nRead it over: correcting it now is cheaper than later.');
}

function pushNote(r) {
  if (r.pushed) return ' Pushed.';
  if (r.pushError) return ` Push failed (${r.pushError}) — run \`git push\` manually.`;
  return ' Run `git push` to share with your team.';
}
