import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  listMembers, addMember, removeMember,
  MemberNotFoundError, MemberExistsError, InviteNeedsLoginError,
} from './member.core.js';
import { ManagerGateError } from './review.core.js';

const execFileAsync = promisify(execFile);

/** Presentation only — every operation lives in member.core.js. */

function fail(message, hint) {
  console.error(`Error: ${message}${hint ? `. ${hint}` : ''}`);
  process.exit(1);
}

function reportAndExit(err) {
  if (err instanceof ManagerGateError) fail(err.message);
  if (err instanceof MemberNotFoundError) fail(err.message, 'Run `teamctx member list`');
  if (err instanceof MemberExistsError) fail(err.message);
  if (err instanceof InviteNeedsLoginError) fail(err.message);
  fail(err.message);
}

/**
 * The repository this project lives in, for the invite path.
 *
 * Read from the git remote rather than config: it is the same answer, it stays
 * correct if the repo is renamed or transferred, and it needs nothing recorded.
 */
async function currentRepo() {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin']);
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(stdout.trim());
    return m ? { owner: m[1], repo: m[2] } : {};
  } catch {
    return {};
  }
}

export async function memberAddCommand(ref, opts = {}) {
  const { owner, repo } = opts.invite ? await currentRepo() : {};
  if (opts.invite && !owner) {
    fail('could not work out the GitHub repository from `git remote get-url origin`',
      'Add the member without --invite, or invite them on GitHub directly');
  }

  let result;
  try {
    result = await addMember({
      ref,
      name: opts.name,
      invite: !!opts.invite,
      permission: opts.permission || 'push',
      owner,
      repo,
    });
  } catch (err) { reportAndExit(err); }

  const m = result.member;
  console.log(`\n✓ ${m.name} added to the project${result.committed ? ' — committed' : ''}.`);
  console.log(`  Identified by: ${m.login ? `@${m.login}` : m.email}`);

  if (result.invite?.invited) {
    console.log(`  Invited to the repository — they must accept before they can clone it.`);
  } else if (result.invite?.alreadyCollaborator) {
    console.log(`  Already had repository access.`);
  } else if (result.invite?.error) {
    console.log(`  Repository invite failed (${result.invite.error}).`);
    console.log(`  They are on the roster but cannot clone yet — invite them on GitHub.`);
  } else if (m.login) {
    // The common mistake: a roster entry looks like access, and is not.
    console.log(`  Not invited to the repository. Re-run with --invite, or add them on GitHub.`);
  }
  console.log('');
}

export async function memberListCommand() {
  const members = listMembers();
  if (members.length === 0) {
    console.log('\nNo members yet. Add one with `teamctx member add <username|email>`.\n');
    return;
  }
  const header = ['Name', 'GitHub', 'Email', 'Added'];
  const rows = members.map(m => [m.name || '-', m.login ? `@${m.login}` : '-', m.email || '-', m.addedAt || '-']);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n${members.length} member${members.length !== 1 ? 's' : ''}:\n`);
  console.log(fmt(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(fmt(r)));
  console.log('');
}

export async function memberRmCommand(ref) {
  let result;
  try { result = await removeMember({ ref }); } catch (err) { reportAndExit(err); }
  console.log(`\n✓ ${result.member.name} removed from the project — committed.`);
  if (result.stillHasRepoAccess) {
    // Saying so matters: a manager who thinks this revoked access is wrong.
    console.log(`  Their GitHub access is unchanged — remove them from the repository on GitHub if that is the intent.`);
  }
  console.log('');
}
