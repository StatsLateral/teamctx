import { readConfig } from '../../src/storage.js';
import { currentIdentity } from '../identity.js';
import {
  listTasksFiltered, getTask, addTask, setTaskStatus, assignTask, removeTask,
  compileTask, TaskNotFoundError, UnknownTaskWorkstreamError, UnknownRoleError,
  slugify, uniqueTaskId,
} from './task.core.js';

/**
 * Presentation for the task commands.
 *
 * Every operation lives in task.core.js so the MCP server runs the same code.
 * What is left here is argument handling, tables, and turning a typed error
 * into a message and an exit code.
 */

function fail(message, hint) {
  console.error(`Error: ${message}${hint ? `. ${hint}` : ''}`);
  process.exit(1);
}

/** Typed errors carry the wording; only the "what to run next" is added here. */
function reportAndExit(err) {
  if (err instanceof TaskNotFoundError) fail(err.message, 'Run `teamctx task list --all` to see tasks');
  if (err instanceof UnknownTaskWorkstreamError) fail(err.message, 'Run `teamctx workstream list`');
  if (err instanceof UnknownRoleError) fail(err.message, 'Run `teamctx role list`');
  throw err;
}

function reportGit(result, successLine) {
  if (!result.committed) {
    console.log(`\n${successLine}.\n`);
  } else if (result.pushed) {
    console.log(`\n${successLine} — committed and pushed.\n`);
  } else if (result.pushError) {
    console.log(`\n${successLine} — committed. Push failed (${result.pushError}) — run \`git push\` manually.\n`);
  } else {
    console.log(`\n${successLine} — committed. Run \`git push\` to share with your team.\n`);
  }
}

export async function taskAddCommand(title, opts = {}) {
  let result;
  try {
    result = await addTask({ title, owner: opts.owner, workstream: opts.workstream });
  } catch (err) { reportAndExit(err); }

  const { task } = result;
  const wsLabel = task.workstream === 'main' ? '' : ` [workstream: ${task.workstream}]`;
  reportGit(result, `✓ Task ${task.id} added${wsLabel}`);
  console.log(`  Owner: ${task.owner}`);
  console.log(`  Compile a prompt for it with: teamctx task compile ${task.id}`);
}

export async function taskListCommand(opts = {}) {
  const config = readConfig();
  const { activeWorkstream, me, authorKey } = await currentIdentity(config);
  let result;
  try {
    result = listTasksFiltered({
      status: opts.status,
      owner: opts.owner,
      workstream: opts.workstream,
      all: !!opts.all,
      mine: !!opts.mine,
      me,
      myKey: authorKey,
      activeWorkstream,
    });
  } catch (err) {
    fail(err.message);
  }
  const { tasks, scope } = result;

  if (tasks.length === 0) {
    console.log('\nNo tasks match. Try `teamctx task list --all`.\n');
    return;
  }

  const header = ['ID', 'Status', 'Owner', 'Workstream', 'Compiled', 'Title'];
  const rows = tasks.map(t => [
    t.id,
    t.status || '-',
    t.owner || '-',
    t.workstream || '-',
    t.compiledAt ? 'yes' : '-',
    (t.title || '').slice(0, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n${tasks.length} task${tasks.length !== 1 ? 's' : ''} (${scope}):\n`);
  console.log(fmt(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(fmt(r)));
  console.log('');
}

export async function taskShowCommand(idOrPrefix) {
  let task;
  try { task = getTask({ id: idOrPrefix }); } catch (err) { reportAndExit(err); }

  console.log(`\n# Task ${task.id}`);
  console.log(`  Title:      ${task.title}`);
  console.log(`  Owner:      ${task.owner || '-'}`);
  console.log(`  Status:     ${task.status}`);
  console.log(`  Workstream: ${task.workstream}`);
  console.log(`  Created:    ${task.createdAt || '-'}`);
  if (task.doneAt) console.log(`  Done at:    ${task.doneAt}`);
  console.log(`  Compiled:   ${task.compiledAt ? task.compiledAt : 'not yet — run `teamctx task compile ' + task.id + '`'}`);
  console.log('');
}

export async function taskDoneCommand(idOrPrefix) {
  let result;
  try { result = await setTaskStatus({ id: idOrPrefix, status: 'done' }); } catch (err) { reportAndExit(err); }
  if (result.unchanged) {
    console.log(`\nTask ${result.task.id} is already done.\n`);
    return;
  }
  reportGit(result, `✓ Task ${result.task.id} marked done`);
}

export async function taskReopenCommand(idOrPrefix) {
  let result;
  try { result = await setTaskStatus({ id: idOrPrefix, status: 'open' }); } catch (err) { reportAndExit(err); }
  if (result.unchanged) {
    console.log(`\nTask ${result.task.id} is already open.\n`);
    return;
  }
  reportGit(result, `✓ Task ${result.task.id} reopened`);
}

export async function taskAssignCommand(idOrPrefix, opts = {}) {
  if (!opts.owner) fail('--owner <name> is required');
  let result;
  try { result = await assignTask({ id: idOrPrefix, owner: opts.owner }); } catch (err) { reportAndExit(err); }
  reportGit(result, `✓ Task ${result.task.id} assigned to ${opts.owner}`);
}

export async function taskRmCommand(idOrPrefix) {
  let result;
  try { result = await removeTask({ id: idOrPrefix }); } catch (err) { reportAndExit(err); }
  reportGit(result, `✓ Task ${result.id} removed (workstream: ${result.workstream})`);
}

export async function taskCompileCommand(idOrPrefix, opts = {}) {
  console.log(`\n→ Compiling prompt for task ${idOrPrefix}${opts.role ? ` (role: ${opts.role})` : ''}...`);
  let result;
  try {
    result = await compileTask({ id: idOrPrefix, role: opts.role, force: !!opts.force });
  } catch (err) { reportAndExit(err); }

  if (result.alreadyCompiled) {
    console.log(`\n✓ Task ${result.task.id} already compiled (workstream Whys unchanged since ${result.task.compiledAt}).`);
    console.log(`  Prompt file: ${result.promptPath}`);
    console.log(`  Re-run with --force to regenerate.\n`);
    return;
  }

  const roleTag = result.role ? ` (role: ${result.role})` : '';
  reportGit(result, `✓ Task prompt compiled for ${result.task.id}${roleTag}`);
  console.log(`  Prompt file: ${result.promptPath}`);
  console.log(`  Copy that file's contents into your AI (ChatGPT, Claude, Cursor, ...).\n`);
}

export { slugify, uniqueTaskId };
