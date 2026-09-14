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
 * Only reached on a project with no deployment — a deployed project is refused
 * by the core before this matters, because there the unchecked cases strand
 * people. Here there are no hosted keys or lent access to miss, but the person
 * running this should still know what was not looked at rather than assume it
 * was.
 */
async function confirm(what, opts) {
  console.log(`\n${what}`);
  console.log('\nFrom a clone, teamctx cannot check:');
  console.log('  - that the new manager has a working AI key of their own');
  console.log('  - whether anyone reaches the project through GitHub access this person lent');
  console.log('This project has no deployment, so neither applies yet. If it is deployed later,');
  console.log('make manager changes through the teamctx connector, where both are checked.\n');

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
