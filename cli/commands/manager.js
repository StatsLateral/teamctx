import { ask } from '../prompt.js';
import { readConfig } from '../../src/storage.js';
import {
  listManagers, addManager, removeManager, transferManager, ManagerChangeError,
} from './manager.core.js';
import { ManagerGateError } from './review.core.js';

/** Presentation only — every operation lives in manager.core.js. */

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

/**
 * Say what the terminal cannot check, and ask before going on.
 *
 * Reached when the project records no deployment. That does not mean nobody
 * uses it through the connector — a project created on the web before its
 * deployment was recorded looks exactly the same from here — so this says what
 * it cannot see rather than claiming there is nothing to see. A project that
 * does record one is refused by the core instead.
 */
async function confirm(what, opts) {
  console.log(`\n${what}`);
  console.log('\nFrom a clone, teamctx cannot check:');
  console.log('  - that the new manager has a working AI key of their own');
  console.log('  - whether anyone reaches the project through GitHub access this person lent');
  console.log('\nIt also cannot tell whether anyone uses this project through the teamctx connector.');
  console.log('If they do, this change can leave them without a model or without access. Make it');
  console.log('through the connector instead, where both are checked.\n');

  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    fail('this changes who manages the project. Re-run with --yes to confirm when there is no terminal to ask.');
  }
  return (await ask('Go ahead? (y/n)', 'n')).toLowerCase() === 'y';
}

async function run(what, opts, change) {
  const config = readConfig();
  // A deployed project is refused by the core with the reason and the way
  // forward. Asking first and refusing after would waste the answer.
  if (!config.deployUrl && !(await confirm(what, opts))) {
    console.log('\nNothing changed.\n');
    return null;
  }
  try {
    return await change();
  } catch (err) {
    if (err instanceof ManagerChangeError || err instanceof ManagerGateError) fail(err.message);
    throw err;
  }
}

function printManagers(r) {
  console.log(`  Primary:     ${r.primary ? (r.primary.email || r.primary.key) : '(none)'}`);
  console.log(`  Co-managers: ${r.coManagers.length ? r.coManagers.map(m => m.email || m.key).join(', ') : '(none)'}`);
}

export async function managerListCommand() {
  console.log('');
  printManagers(listManagers());
  console.log('\n  The project runs on the primary manager\'s key. Co-managers approve exactly as the primary does.\n');
}

export async function managerAddCommand(email, opts = {}) {
  const r = await run(`Make ${email} a co-manager of this project.`, opts, () => addManager({ ref: email }));
  if (!r) return;
  console.log(`\n✓ ${email} is now a co-manager — committed.\n`);
  printManagers(r);
  console.log('');
}

export async function managerRemoveCommand(email, opts = {}) {
  const r = await run(`Remove ${email} as a manager of this project.`, opts, () => removeManager({ ref: email }));
  if (!r) return;
  console.log(`\n✓ ${email} is no longer a manager — committed.\n`);
  printManagers(r);
  console.log('');
}

export async function managerTransferCommand(email, opts = {}) {
  const what = `Make ${email} the primary manager${opts.stepDown ? ', and step down yourself' : ', staying on as a co-manager'}.`;
  const r = await run(what, opts, () => transferManager({ ref: email, stepDown: !!opts.stepDown }));
  if (!r) return;
  console.log(`\n✓ ${email} is now the primary manager — committed.\n`);
  printManagers(r);
  console.log('');
}
