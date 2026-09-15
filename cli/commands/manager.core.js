import { readConfig, writeConfig } from '../../src/storage.js';
import { commitContext, pushContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';
import { resolveDisplayName } from '../../src/prefs.js';
import { assertManager } from './review.core.js';
import { noreplyEmail } from './member.core.js';
import {
  managersOf, emailOfKey, planAdd, planRemove, planTransfer, ManagerChangeError,
} from '../../src/managers.js';

/**
 * Changing who manages a project.
 *
 * Its own gated write path, beside `setReviewPolicy` and `repairManagerGate`,
 * and deliberately never reachable through `config_set`: `managerKey` is kept
 * off the writable keys because a caller who can write the gate can grant
 * themselves approval (#49). Every operation here opens by checking that the
 * caller can already pass the gate it is about to change.
 *
 * Two checks are passed in rather than performed here, because only the hosted
 * server can run them — a clone cannot read the hosted key store:
 *
 *   checkKey({ email })       before anyone becomes primary: do they have a
 *                             working project key? The project runs on it, so a
 *                             transfer without one is refused. A co-manager's key
 *                             is never used, and adding one checks nothing.
 *   checkLend({ email })      before anyone becomes primary: if the project
 *                             lends GitHub access, is it theirs? A transfer to
 *                             somebody else is refused.
 *   checkStepOut({ email })   before anyone leaves: does the project still run
 *                             on something of theirs?
 *
 * Each returns `{ ok, why?, note? }`. Absent, the check did not run, and the
 * commit says so rather than implying it passed.
 */

export { ManagerChangeError };

async function caller({ config, teamctxDir, projectDir, actor }) {
  const resolved = actor || await resolveActor({ config, cwd: projectDir });
  const displayName = await resolveDisplayName({ actor: resolved, config, teamctxDir });
  assertManager(config, { actor: resolved, displayName });
  return { actor: resolved, displayName };
}

async function commitAndPush(config, message, projectDir, actor) {
  await commitContext(message, {
    ...(projectDir ? { cwd: projectDir } : {}),
    ...(actor ? { author: { name: actor.name, email: noreplyEmail(actor) || actor.email } } : {}),
  });
  if (!config.autoPush) return { committed: true, pushed: false };
  try {
    await pushContext(projectDir ? { cwd: projectDir } : undefined);
    return { committed: true, pushed: true };
  } catch (err) {
    return { committed: true, pushed: false, pushError: err.message?.split('\n')[0] || 'push failed' };
  }
}

/** Run a check the caller passed in, and refuse on a failure. */
async function runCheck(check, key, code) {
  if (!check) return { ran: false };
  // The key travels with the address. A manager written before managers were
  // identified by email has no address, and a check handed only `null` would
  // match nothing — which for the step-out check means letting them through.
  const result = await check({ email: emailOfKey(key), key });
  if (!result?.ok) throw new ManagerChangeError(result?.why || 'The check did not pass.', code);
  return { ran: true, note: result.note || null };
}

/** What the commit says about the checks on a new primary — including any that did not run. */
function checksNote(keyCheck, lendCheck) {
  if (!keyCheck && !lendCheck) return '';
  const parts = [
    keyCheck && (keyCheck.ran ? (keyCheck.note || 'key verified') : 'key not checked'),
    lendCheck && (lendCheck.ran ? (lendCheck.note || 'GitHub access checked') : 'GitHub access not checked'),
  ].filter(Boolean);
  return ` (${parts.join('; ')})`;
}

export function listManagers({ teamctxDir } = {}) {
  return listManagersFrom(readConfig(teamctxDir));
}

/**
 * Refuse a change the checks cannot guard.
 *
 * A project with a `deployUrl` is reached through the hosted server, where its
 * keys and its lent access live. A clone cannot see either, so from a clone the
 * key check and the step-out check cannot run — and a deployed project is exactly
 * the one where skipping them strands people. The connector can run both.
 *
 * A project with no deployment has no hosted keys or lent access to check, so
 * there is nothing a missing check could miss.
 */
function assertGuardable({ config, plan, checkKey, checkLend, checkStepOut }) {
  if (!config.deployUrl) return;
  const missing = (plan.promotes && (!checkKey || !checkLend)) || (plan.leaves && !checkStepOut);
  if (!missing) return;
  throw new ManagerChangeError(
    `This project is deployed at ${config.deployUrl}, and changing its managers needs checks that only `
    + 'the hosted server can run: that a new primary manager has a working key and holds the GitHub access '
    + 'the project lends, and that nobody leaves while '
    + 'members still reach the project through access they lent. Ask your assistant to make this change '
    + 'through the teamctx connector instead.',
    'MANAGER_NEEDS_CONNECTOR',
  );
}

async function apply({ plan, config, message, who, teamctxDir, projectDir, checkKey, checkLend, checkStepOut }) {
  assertGuardable({ config, plan, checkKey, checkLend, checkStepOut });
  const keyCheck = plan.promotes
    ? await runCheck(checkKey, plan.promotes, 'MANAGER_KEY_CHECK')
    : null;
  const lendCheck = plan.promotes
    ? await runCheck(checkLend, plan.promotes, 'MANAGER_LEND_CHECK')
    : null;
  if (plan.leaves) await runCheck(checkStepOut, plan.leaves, 'MANAGER_STEP_OUT');

  writeConfig(plan.next, teamctxDir);
  const git = await commitAndPush(config, `${message} by ${who.displayName}${checksNote(keyCheck, lendCheck)}`, projectDir, who.actor);
  return {
    ...listManagersFrom(plan.next),
    keyChecked: keyCheck ? keyCheck.ran : null,
    lendChecked: lendCheck ? lendCheck.ran : null,
    ...git,
  };
}

function listManagersFrom(config) {
  const { primary, coManagers } = managersOf(config);
  return {
    primary: primary ? { key: primary, email: emailOfKey(primary) } : null,
    coManagers: coManagers.map(key => ({ key, email: emailOfKey(key) })),
  };
}

export async function addManager({ ref, teamctxDir, projectDir, actor } = {}) {
  const config = readConfig(teamctxDir);
  const who = await caller({ config, teamctxDir, projectDir, actor });
  const plan = planAdd(config, ref);
  return apply({
    plan, config, who, teamctxDir, projectDir,
    message: `manager: add ${emailOfKey(plan.key)} as co-manager`,
  });
}

export async function removeManager({ ref, teamctxDir, projectDir, actor, checkStepOut } = {}) {
  const config = readConfig(teamctxDir);
  const who = await caller({ config, teamctxDir, projectDir, actor });
  const plan = planRemove(config, ref);
  return apply({
    plan, config, who, teamctxDir, projectDir, checkStepOut,
    message: `manager: remove ${emailOfKey(plan.key)}`,
  });
}

export async function transferManager({
  ref, stepDown = false, teamctxDir, projectDir, actor, checkKey, checkLend, checkStepOut,
} = {}) {
  const config = readConfig(teamctxDir);
  const who = await caller({ config, teamctxDir, projectDir, actor });
  const plan = planTransfer(config, ref, { actor: who.actor, stepDown });
  return apply({
    plan, config, who, teamctxDir, projectDir, checkKey, checkLend, checkStepOut,
    message: `manager: transfer primary to ${emailOfKey(plan.key)}${stepDown ? ', stepping down' : ''}`,
  });
}
