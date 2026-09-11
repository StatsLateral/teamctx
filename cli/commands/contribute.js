import { ask } from '../prompt.js';
import { contributeCore } from './contribute.core.js';
import { isProjectLevel } from '../../src/project-level.js';

/**
 * `teamctx contribute`, over the same code the MCP server calls.
 *
 * This used to be a second implementation of `contributeCore` — its own
 * distillation, its own queue write, its own commit — and the two drifted. The
 * terminal never learned about the review policy, and would have kept writing
 * to a workstream the project layer removed. Everything below is presentation.
 */
function describe(op) {
  if (op.type === 'addWhy') return `+ Why: ${op.text}`;
  if (op.type === 'addWhat') return `+ What: ${op.text}`;
  if (op.type === 'addHow') return `+ How: ${op.text}`;
  if (op.type === 'editStatement') return `~ Edit: ${op.text}`;
  return `- Delete: ${op.id}`;
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
      onProposed: async ({ summary, operations, willQueue }) => {
        console.log(`\nProposed changes (${operations.length} op${operations.length !== 1 ? 's' : ''}):`);
        console.log(`  Summary: ${summary}`);
        operations.forEach(op => console.log(`  ${describe(op)}`));
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
}

function pushNote(r) {
  if (r.pushed) return ' Pushed.';
  if (r.pushError) return ` Push failed (${r.pushError}) — run \`git push\` manually.`;
  return ' Run `git push` to share with your team.';
}
