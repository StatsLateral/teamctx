import { readFileSync, statSync, readdirSync, globSync } from 'fs';
import { basename, join } from 'path';
import { readConfig } from '../../src/storage.js';
import { currentIdentity } from '../identity.js';
import {
  listTasksFiltered, getTask, addTask, setTaskStatus, assignTask, removeTask, saveFileOutput, saveFileOutputs,
  compileTask, TaskNotFoundError, UnknownTaskWorkstreamError, TaskWithoutWorkstreamError, UnknownRoleError,
  slugify, uniqueTaskId,
} from './task.core.js';
import {
  FileOutputError, FILE_OUTPUT_WARNING, FILE_OUTPUT_EXTENSIONS, extensionOf,
  MAX_OUTPUT_FILE_BYTES, MAX_BATCH_FILES, MAX_BATCH_TOTAL_BYTES, humanBytes,
} from '../../src/file-output.js';

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
  if (err instanceof TaskWithoutWorkstreamError) fail(err.message, 'Run `teamctx workstream list`');
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
  const wsLabel = ` [workstream: ${task.workstream}]`;
  reportGit(result, `✓ Task ${task.key || task.id} added${wsLabel}`);
  console.log(`  Owner: ${task.owner}`);
  console.log(`  Compile a prompt for it with: teamctx task compile ${task.key || task.id}`);
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
    t.key || t.id,
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

  console.log(`\n# Task ${task.key || task.id}`);
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
    console.log(`\nTask ${result.task.key || result.task.id} is already done.\n`);
    return;
  }
  reportGit(result, `✓ Task ${result.task.key || result.task.id} marked done`);
}

export async function taskReopenCommand(idOrPrefix) {
  let result;
  try { result = await setTaskStatus({ id: idOrPrefix, status: 'open' }); } catch (err) { reportAndExit(err); }
  if (result.unchanged) {
    console.log(`\nTask ${result.task.key || result.task.id} is already open.\n`);
    return;
  }
  reportGit(result, `✓ Task ${result.task.key || result.task.id} reopened`);
}

export async function taskAssignCommand(idOrPrefix, opts = {}) {
  if (!opts.owner) fail('--owner <name> is required');
  let result;
  try { result = await assignTask({ id: idOrPrefix, owner: opts.owner }); } catch (err) { reportAndExit(err); }
  reportGit(result, `✓ Task ${result.task.key || result.task.id} assigned to ${opts.owner}`);
}

export async function taskRmCommand(idOrPrefix, opts = {}) {
  let result;
  try { result = await removeTask({ id: idOrPrefix, reason: opts.reason }); } catch (err) { reportAndExit(err); }
  reportGit(result, `✓ Task ${result.key || result.id} removed (workstream: ${result.workstream})`);
  // An accepted task's outputs and approval stay; what else its acceptance
  // recorded is the manager's to decide about.
  if (result.stillActive?.length) {
    console.log('Still in the context from when it was accepted:');
    for (const x of result.stillActive) console.log(`  - ${x.kind === 'task' ? `task ${x.key || x.id}: ${x.title}` : `${x.type}: ${x.text}`}`);
    console.log();
  }
}

export async function taskCompileCommand(idOrPrefix, opts = {}) {
  console.log(`\n→ Compiling prompt for task ${idOrPrefix}${opts.role ? ` (role: ${opts.role})` : ''}...`);
  let result;
  try {
    result = await compileTask({ id: idOrPrefix, role: opts.role, force: !!opts.force });
  } catch (err) { reportAndExit(err); }

  if (result.alreadyCompiled) {
    console.log(`\n✓ Task ${result.task.key || result.task.id} already compiled (workstream Whys unchanged since ${result.task.compiledAt}).`);
    console.log(`  Prompt file: ${result.promptPath}`);
    console.log(`  Re-run with --force to regenerate.\n`);
    return;
  }

  const roleTag = result.role ? ` (role: ${result.role})` : '';
  reportGit(result, `✓ Task prompt compiled for ${result.task.key || result.task.id}${roleTag}`);
  console.log(`  Prompt file: ${result.promptPath}`);
  console.log(`  Copy that file's contents into your AI (ChatGPT, Claude, Cursor, ...).\n`);
}

const GLOB_CHARS = /[*?[\]{}]/;

/** Walk a directory to its files; descends into sub-folders only when recursive. */
function filesUnder(dir, recursive) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (recursive) out.push(...filesUnder(p, recursive)); }
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/**
 * Turn what the user typed — one or more files, folders or globs — into a
 * concrete list of file paths. A folder yields the files directly inside it
 * (recursively only with --recursive); a glob is expanded; a literal path that
 * is not there is reported as missing. `expanded` marks a run that came from a
 * folder or glob (as opposed to explicitly named files), so the caller can
 * quietly ignore non-attachable types rather than refuse them one by one.
 */
function resolveAttachPaths(inputs, { recursive }) {
  const files = new Set();
  const missing = [];
  let expanded = false;
  for (const input of inputs) {
    if (GLOB_CHARS.test(input)) {
      expanded = true;
      let matches = [];
      try { matches = globSync(input); } catch { /* treated as no match below */ }
      for (const m of matches) { try { if (statSync(m).isFile()) files.add(m); } catch { /* skip */ } }
      continue;
    }
    let stat;
    try { stat = statSync(input); } catch { missing.push(input); continue; }
    if (stat.isDirectory()) { expanded = true; for (const f of filesUnder(input, recursive)) files.add(f); }
    else files.add(input);
  }
  return { files: [...files].sort(), missing, expanded };
}

export async function taskAttachCommand(idOrPrefix, pathOrPaths, opts = {}) {
  const inputs = (Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths]).filter(Boolean);
  if (inputs.length === 0) fail('nothing to attach', 'Give a file, a folder, or a glob');

  const { files, missing, expanded } = resolveAttachPaths(inputs, { recursive: !!opts.recursive });
  // A literal path the user named but that is not there is an error, as before.
  if (missing.length) fail(`file not found: ${missing.join(', ')}`);
  if (files.length === 0) fail('no files matched', 'Check the folder or pattern');

  // A single explicitly named file keeps the original one-file flow, with its
  // --title/--note and its fuller output.
  if (files.length === 1 && !expanded) return attachOne(idOrPrefix, files[0], opts);
  return attachMany(idOrPrefix, files, { ...opts, expanded });
}

/** Attach one named file (the original behaviour). */
async function attachOne(idOrPrefix, path, opts) {
  // Check the size before reading, so an enormous file is refused cheaply
  // rather than buffered whole into memory first.
  const stat = statSync(path);
  if (stat.size > MAX_OUTPUT_FILE_BYTES) {
    fail(`the file is too large to attach (${humanBytes(stat.size)}; the most from the command line is ${humanBytes(MAX_OUTPUT_FILE_BYTES)}). `
      + 'Keep it in a cloud or local folder and attach a part or a summary, or link it.');
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    fail(`could not read ${path}: ${err.message}`);
  }

  let result;
  try {
    result = await saveFileOutput({
      id: idOrPrefix, bytes, name: basename(path), title: opts.title, notes: opts.note, source: 'cli',
      allowSecrets: !!opts.allowSecrets,
    });
  } catch (err) {
    // A file refused for its size, type or a name mismatch carries its own
    // message meant for the person; print it without a stack trace.
    if (err instanceof FileOutputError) fail(err.message);
    reportAndExit(err);
  }

  const { output, task } = result;
  reportGit(result, `✓ Attached ${output.file.name} to task ${task.key || task.id}`);
  console.log(`  ${output.file.type}, ${humanBytes(output.file.size)} · output ${output.id}`);
  console.log(`  ${FILE_OUTPUT_WARNING}`);
  console.log(`  Send it to the manager with: teamctx task submit ${task.key || task.id}\n`);
}

/** Attach many files from a folder or glob, in one commit. */
async function attachMany(idOrPrefix, paths, opts) {
  const allowed = new Set(FILE_OUTPUT_EXTENSIONS);
  // From a folder or glob, only attachable types are in scope; other files are
  // quietly ignored (not every stray file is a "refusal"). An explicit list of
  // files is taken at face value — a bad type there is reported as a skip.
  const inScope = opts.expanded ? paths.filter(p => allowed.has(extensionOf(p))) : paths;
  const ignored = paths.length - inScope.length;
  if (inScope.length === 0) {
    fail('no attachable files found', `Allowed types: ${FILE_OUTPUT_EXTENSIONS.join(', ')}`);
  }

  // Read sizes before anything is written: refuse a whole run that is too big,
  // and skip (without reading) any single file over the per-file limit.
  const toAttach = [];
  const skipped = [];
  let total = 0;
  for (const p of inScope) {
    let size;
    try { size = statSync(p).size; } catch (err) { skipped.push({ name: basename(p), reason: `could not read (${err.code || err.message})` }); continue; }
    if (size > MAX_OUTPUT_FILE_BYTES) {
      skipped.push({ name: basename(p), reason: `too large (${humanBytes(size)}; limit ${humanBytes(MAX_OUTPUT_FILE_BYTES)})` });
      continue;
    }
    toAttach.push({ path: p, size });
    total += size;
  }
  if (toAttach.length > MAX_BATCH_FILES) {
    fail(`that is ${toAttach.length} files; a single run takes at most ${MAX_BATCH_FILES}. `
      + 'Attach fewer at a time, or keep the folder in a cloud tool and link it with a cloud share URL.');
  }
  if (total > MAX_BATCH_TOTAL_BYTES) {
    fail(`that is ${humanBytes(total)} in one run; the most is ${humanBytes(MAX_BATCH_TOTAL_BYTES)}. `
      + 'Attach fewer at a time, or keep the folder in a cloud tool and link it with a cloud share URL.');
  }
  if (toAttach.length === 0) {
    reportSkips(skipped, ignored);
    fail('nothing could be attached');
  }

  const batch = [];
  for (const f of toAttach) {
    try { batch.push({ bytes: readFileSync(f.path), name: basename(f.path) }); }
    catch (err) { skipped.push({ name: basename(f.path), reason: `could not read (${err.code || err.message})` }); }
  }

  let result;
  try {
    result = await saveFileOutputs({ id: idOrPrefix, files: batch, source: 'cli', allowSecrets: !!opts.allowSecrets });
  } catch (err) {
    if (err instanceof FileOutputError) fail(err.message);
    reportAndExit(err);
  }

  const { outputs, skipped: refused, task } = result;
  for (const s of refused) skipped.push(s);
  const bytesIn = outputs.reduce((n, o) => n + (o.file?.size || 0), 0);
  reportGit(result, `✓ Attached ${outputs.length} file${outputs.length === 1 ? '' : 's'} to task ${task.key || task.id} (${humanBytes(bytesIn)})`);
  for (const o of outputs) console.log(`  · ${o.file.name} (${o.file.type}, ${humanBytes(o.file.size)}) · output ${o.id}`);
  reportSkips(skipped, ignored);
  console.log(`  ${FILE_OUTPUT_WARNING}`);
  console.log(`  Send them to the manager with: teamctx task submit ${task.key || task.id}\n`);
}

function reportSkips(skipped, ignored) {
  for (const s of skipped) console.log(`  ⤬ skipped ${s.name} — ${s.reason}`);
  if (ignored > 0) console.log(`  (ignored ${ignored} non-attachable file${ignored === 1 ? '' : 's'})`);
}

export { slugify, uniqueTaskId };
