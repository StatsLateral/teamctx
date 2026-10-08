import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, unlinkSync, openSync, closeSync, statSync } from 'fs';
import { mintTaskKey, workstreamNumber, TaskWithoutWorkstreamError } from './numbering.js';
import { ensureGitignored } from './local-dir.js';
import { join, dirname } from 'path';
import { getCurrentSession } from './session-context.js';
import { isProjectLevel, resolveTarget } from './project-level.js';
import { emptyProject as emptyProjectShape, emptyWorkstream, assertCurrentFormat } from './model.js';

/**
 * Storage layer.
 *
 * Local (CLI) mode: every function reads/writes the filesystem under
 * `dir` (usually `.teamctx/`).
 *
 * Hosted (MCP over HTTP) mode: the HTTP handler runs each tool call inside
 * a `runWithSession(session, ...)` context (see src/session-context.js).
 * The session has an in-memory buffer prefetched from a GitHub repo.
 * When `getCurrentSession()` returns non-null, every read/write here
 * targets that buffer instead of the filesystem — synchronous, no async
 * cascade. The session's `commit()` flushes buffered writes as one atomic
 * git commit later, at request end.
 *
 * The `dir` argument in hosted mode is a virtual root; the session's
 * paths are all absolute inside the repo. We ignore `dir` for github
 * dispatch because the session knows its own layout.
 */

const CTX_ROOT = '.teamctx';

function resolve(dir, ...parts) {
  return join(dir || getTeamctxDir(), ...parts);
}

function ctxPath(...parts) {
  return [CTX_ROOT, ...parts].join('/');
}

export function getTeamctxDir(startPath = process.cwd()) {
  let current = startPath;
  while (true) {
    const candidate = join(current, '.teamctx');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Not in a teamctx project. Run `teamctx init` first.');
}

// ---- Session helpers (hosted mode only) ----

function sessionRead(path) {
  const s = getCurrentSession();
  if (!s) return undefined;
  const rec = s.read(path);
  return rec ? rec.content : null;
}

function sessionWrite(path, content) {
  const s = getCurrentSession();
  if (!s) return false;
  s.write(path, content);
  return true;
}

function sessionDelete(path) {
  const s = getCurrentSession();
  if (!s) return false;
  s.del(path);
  return true;
}

function sessionListDir(dirPath) {
  const s = getCurrentSession();
  if (!s) return null;
  return s.listDir(dirPath);
}

// ---- Config ----

export function readConfig(dir) {
  const s = sessionRead(ctxPath('config.json'));
  if (s !== undefined) {
    if (s === null) throw new Error('Not in a teamctx project. .teamctx/config.json not found.');
    return JSON.parse(s);
  }
  return JSON.parse(readFileSync(resolve(dir, 'config.json'), 'utf-8'));
}

export function writeConfig(config, dir) {
  if (sessionWrite(ctxPath('config.json'), JSON.stringify(config, null, 2))) return;
  writeFileSync(resolve(dir, 'config.json'), JSON.stringify(config, null, 2));
}

/**
 * Take over a lock whose owner is gone, or report that it is still warm.
 *
 * The age is read and the file removed as two steps, which two processes could
 * interleave — so the caller re-opens with `wx` and the loser of that race gets
 * EEXIST and reports the lock held, rather than both proceeding.
 */
function claimStaleLock(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
    unlinkSync(lock);
    return true;
  } catch (error) {
    // Gone between the stat and the unlink: somebody else finished normally, so
    // the lock is free either way.
    return error.code === 'ENOENT';
  }
}

/**
 * How long a lock may sit before it is treated as abandoned.
 *
 * A context write is one AI call and a few file writes. Ten minutes is far
 * longer than that and far shorter than a person's patience, so a lock older
 * than this belonged to a process that is gone.
 */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** A synchronous context write that mints numbers against the latest counters.
 * The local exclusive file prevents two CLI processes allocating the same number.
 * Hosted writes are buffered together; the adapter rejects stale counter commits.
 */
export function withCounters(dir, write) {
  const lock = getCurrentSession() ? null : resolve(dir, '.local', 'counters.lock');
  let fd;
  if (lock) {
    mkdirSync(dirname(lock), { recursive: true });
    // Before the lock exists, not after. `commitContext` stages the whole of
    // `.teamctx/`, and `.teamctx/.local/` only reaches .gitignore the first time
    // somebody writes a *preference* — so in a clone where nobody has run
    // `teamctx config name`, a lock left behind by a killed process gets
    // committed and pushed by the next command that commits at all. Everyone who
    // pulls is then locked out of every key-allocating path until the deletion
    // is committed too.
    ensureGitignored(dir);
    try { fd = openSync(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Held, or abandoned. A process killed between `openSync` and the
      // `finally` leaves this behind, and telling somebody to delete a file to
      // get their work done is a worse answer than noticing it is cold.
      if (!claimStaleLock(lock)) {
        throw new Error('Another context write holds counters.lock. Retry after it finishes. If its process stopped, remove .teamctx/.local/counters.lock before retrying.');
      }
      fd = openSync(lock, 'wx');
    }
  }
  try {
    return write(readConfig(dir));
  } finally {
    if (fd !== undefined) { closeSync(fd); unlinkSync(lock); }
  }
}

// ---- Contributions log ----

export function appendContribution(contribution, dir) {
  const s = getCurrentSession();
  if (s) {
    const path = ctxPath('contributions.jsonl');
    const existing = s.read(path);
    const next = (existing?.content || '') + JSON.stringify(contribution) + '\n';
    s.write(path, next);
    return;
  }
  appendFileSync(resolve(dir, 'contributions.jsonl'), JSON.stringify(contribution) + '\n');
}

export function readContributions(dir) {
  const s = sessionRead(ctxPath('contributions.jsonl'));
  if (s !== undefined) {
    if (s === null) return [];
    return s.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  const p = resolve(dir, 'contributions.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// ---- Role files ----

function sanitizeSlug(slug) {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid role slug: "${slug}"`);
  }
}

export function writeRoleFile(slug, content, dir) {
  sanitizeSlug(slug);
  if (sessionWrite(ctxPath('context', 'roles', `${slug}.md`), content)) return;
  const rolesDir = resolve(dir, 'context', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, `${slug}.md`), content);
}

export function readRoleFile(slug, dir) {
  sanitizeSlug(slug);
  const s = sessionRead(ctxPath('context', 'roles', `${slug}.md`));
  if (s !== undefined) {
    if (s === null) throw new Error(`role file not found: ${slug}`);
    return s;
  }
  return readFileSync(resolve(dir, 'context', 'roles', `${slug}.md`), 'utf-8');
}

// ---- Queue ----

function sanitizeQueueId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid queue id: "${id}"`);
  }
}

export function queueDir(dir) {
  return resolve(dir, 'queue');
}

export function writeQueueItem(item, dir) {
  sanitizeQueueId(item?.id);
  if (sessionWrite(ctxPath('queue', `${item.id}.json`), JSON.stringify(item, null, 2))) return;
  const d = queueDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}

export function readQueueItem(id, dir) {
  sanitizeQueueId(id);
  const s = sessionRead(ctxPath('queue', `${id}.json`));
  if (s !== undefined) {
    if (s === null) throw new Error(`queue item not found: ${id}`);
    return JSON.parse(s);
  }
  return JSON.parse(readFileSync(join(queueDir(dir), `${id}.json`), 'utf-8'));
}

export function listQueue(dir) {
  const s = sessionListDir(ctxPath('queue'));
  if (s !== null) {
    return s.filter(name => name.endsWith('.json'))
      .map(name => {
        const content = getCurrentSession().read(ctxPath('queue', name));
        return content ? JSON.parse(content.content) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  const d = queueDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function deleteQueueItem(id, dir) {
  sanitizeQueueId(id);
  if (sessionDelete(ctxPath('queue', `${id}.json`))) return;
  unlinkSync(join(queueDir(dir), `${id}.json`));
}

export function writeRejected(item, dir) {
  if (sessionWrite(ctxPath('rejected', `${item.id}.json`), JSON.stringify(item, null, 2))) return;
  const d = resolve(dir, 'rejected');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${item.id}.json`), JSON.stringify(item, null, 2));
}

/**
 * Rejections are the only decision that leaves a file behind — approving
 * deletes the queue item and records nothing — so this is the only way to tell
 * an approval from a rejection without reading git history.
 */
export function listRejected(dir) {
  const s = sessionListDir(ctxPath('rejected'));
  if (s !== null) {
    return s.filter(name => name.endsWith('.json'))
      .map(name => {
        const content = getCurrentSession().read(ctxPath('rejected', name));
        return content ? JSON.parse(content.content) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.rejectedAt || '').localeCompare(b.rejectedAt || ''));
  }
  const d = resolve(dir, 'rejected');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.rejectedAt || '').localeCompare(b.rejectedAt || ''));
}

/**
 * Approvals leave a file too (#143), so a task's history can say who approved
 * a contribution and when. One small file per decision, beside `rejected/`,
 * rather than a field stamped into `contributions.jsonl`: that log is
 * append-only, and rewriting a line of it can lose a contribution appended at
 * the same moment.
 */
export function writeApproved(record, dir) {
  sanitizeQueueId(record?.id);
  if (sessionWrite(ctxPath('approved', `${record.id}.json`), JSON.stringify(record, null, 2))) return;
  const d = resolve(dir, 'approved');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${record.id}.json`), JSON.stringify(record, null, 2));
}

/**
 * Every recorded approval, keyed by contribution id.
 *
 * These are files in the repository, so a file that is not valid, or is not an
 * object with an id, is skipped rather than allowed to take the page down.
 */
export function readApprovals(dir) {
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const entries = (records) => Object.fromEntries(records
    .filter(r => r && typeof r === 'object' && typeof r.id === 'string')
    .map(r => [r.id, r]));
  const s = sessionListDir(ctxPath('approved'));
  if (s !== null) {
    return entries(s.filter(name => name.endsWith('.json'))
      .map(name => getCurrentSession().read(ctxPath('approved', name)))
      .filter(Boolean)
      .map(f => parse(f.content)));
  }
  const d = resolve(dir, 'approved');
  if (!existsSync(d)) return {};
  return entries(readdirSync(d)
    .filter(name => name.endsWith('.json'))
    .map(name => parse(readFileSync(join(d, name), 'utf-8'))));
}

// ---- Snapshots ----

export function snapshotsDir(dir) {
  return resolve(dir, 'snapshots');
}

export function writeSnapshot(snapshot, dir) {
  if (sessionWrite(ctxPath('snapshots', `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2))) return;
  const d = snapshotsDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2));
}

export function readSnapshot(id, dir) {
  const s = sessionRead(ctxPath('snapshots', `${id}.json`));
  if (s !== undefined) {
    if (s === null) throw new Error(`snapshot not found: ${id}`);
    return JSON.parse(s);
  }
  return JSON.parse(readFileSync(join(snapshotsDir(dir), `${id}.json`), 'utf-8'));
}

export function listSnapshots(dir) {
  const s = sessionListDir(ctxPath('snapshots'));
  if (s !== null) {
    return s
      .filter(name => name.endsWith('.json') && name !== 'current.json')
      .map(name => {
        const content = getCurrentSession().read(ctxPath('snapshots', name));
        return content ? JSON.parse(content.content) : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  const d = snapshotsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(name => name.endsWith('.json') && name !== 'current.json')
    .map(name => JSON.parse(readFileSync(join(d, name), 'utf-8')))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

export function resolveSnapshotId(prefix, dir) {
  const s = sessionListDir(ctxPath('snapshots'));
  let ids;
  if (s !== null) {
    ids = s
      .filter(name => name.endsWith('.json') && name !== 'current.json')
      .map(name => name.slice(0, -5));
  } else {
    const d = snapshotsDir(dir);
    if (!existsSync(d)) throw new Error(`no snapshot matches "${prefix}"`);
    ids = readdirSync(d)
      .filter(name => name.endsWith('.json') && name !== 'current.json')
      .map(name => name.slice(0, -5));
  }
  const matches = ids.filter(id => id === prefix || id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`no snapshot matches "${prefix}"`);
  const exact = matches.find(id => id === prefix);
  if (exact) return exact;
  if (matches.length > 1) throw new Error(`prefix "${prefix}" is ambiguous: ${matches.join(', ')}`);
  return matches[0];
}

export function readCurrentSnapshotPointer(dir) {
  const s = sessionRead(ctxPath('snapshots', 'current.json'));
  if (s !== undefined) return s === null ? null : JSON.parse(s);
  const p = join(snapshotsDir(dir), 'current.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function writeCurrentSnapshotPointer(pointer, dir) {
  if (sessionWrite(ctxPath('snapshots', 'current.json'), JSON.stringify(pointer, null, 2))) return;
  const d = snapshotsDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'current.json'), JSON.stringify(pointer, null, 2));
}

// ---- Project context ----

/**
 * The project's own tree: its goal, records and tasks.
 *
 * One level above workstreams, and the base every workstream inherits at compile
 * time. Its own file rather than a reserved workstream id, because that is what
 * `main` was — a workstream doing double duty with nothing in the data to tell
 * the two roles apart.
 *
 * Missing reads as an empty tree, the same way a workstream does, so a project
 * can be read before it has been migrated.
 */
export function readProject(dir) {
  const s = sessionRead(ctxPath('project.json'));
  if (s !== undefined) return s === null ? emptyProjectShape() : assertCurrentFormat(JSON.parse(s));
  const p = resolve(dir, 'project.json');
  if (!existsSync(p)) return emptyProjectShape();
  return assertCurrentFormat(JSON.parse(readFileSync(p, 'utf-8')));
}

export function writeProject(project, dir) {
  // `id` is dropped on the way in: a project is not a workstream, and leaving
  // one there invites code to treat it as an id it can pass around.
  const { id, whys, ...rest } = project || {};
  const body = JSON.stringify({ ...emptyProjectShape(), ...rest }, null, 2);
  if (sessionWrite(ctxPath('project.json'), body)) return;
  writeFileSync(resolve(dir, 'project.json'), body);
}

export function readProjectMd(dir) {
  const s = sessionRead(ctxPath('context', 'project.md'));
  if (s !== undefined) return s === null ? '' : s;
  const p = resolve(dir, 'context', 'project.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function writeProjectMd(content, dir) {
  if (sessionWrite(ctxPath('context', 'project.md'), content)) return;
  const mdDir = resolve(dir, 'context');
  mkdirSync(mdDir, { recursive: true });
  writeFileSync(join(mdDir, 'project.md'), content);
}

// ---- Workstreams ----

function sanitizeWorkstreamId(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid workstream id: "${id}"`);
  }
}

export function readWorkstream(id, dir) {
  sanitizeWorkstreamId(id);
  const s = sessionRead(ctxPath('workstreams', `${id}.json`));
  if (s !== undefined) return s === null ? emptyWorkstream(id) : assertCurrentFormat(JSON.parse(s));
  const p = resolve(dir, 'workstreams', `${id}.json`);
  if (!existsSync(p)) return emptyWorkstream(id);
  return assertCurrentFormat(JSON.parse(readFileSync(p, 'utf-8')));
}

export function writeWorkstream(id, workstream, dir) {
  sanitizeWorkstreamId(id);
  if (sessionWrite(ctxPath('workstreams', `${id}.json`), JSON.stringify(workstream, null, 2))) return;
  const wsDir = resolve(dir, 'workstreams');
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, `${id}.json`), JSON.stringify(workstream, null, 2));
}

export function listWorkstreamIds(dir) {
  const s = sessionListDir(ctxPath('workstreams'));
  if (s !== null) return s.filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).sort();
  const wsDir = resolve(dir, 'workstreams');
  if (!existsSync(wsDir)) return [];
  return readdirSync(wsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -'.json'.length))
    .sort();
}

export function readWorkstreamMd(id, dir) {
  sanitizeWorkstreamId(id);
  const s = sessionRead(ctxPath('context', 'workstreams', `${id}.md`));
  if (s !== undefined) return s === null ? '' : s;
  const p = resolve(dir, 'context', 'workstreams', `${id}.md`);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

export function writeWorkstreamMd(id, content, dir) {
  sanitizeWorkstreamId(id);
  if (sessionWrite(ctxPath('context', 'workstreams', `${id}.md`), content)) return;
  const mdDir = resolve(dir, 'context', 'workstreams');
  mkdirSync(mdDir, { recursive: true });
  writeFileSync(join(mdDir, `${id}.md`), content);
}

function sanitizeTaskId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid task id: "${id}"`);
  }
}

export function tasksDir(dir) {
  return resolve(dir, 'context', 'tasks');
}

/**
 * Where a task's compiled prompt lives.
 *
 * Hosted mode has no filesystem — the repo is reached over the Git Data API and
 * `dir` is a project descriptor rather than a path, so `resolve()` would throw
 * on it. Every other reader here already branches on the session; these did
 * not, because no task code had ever run through the hosted path until tasks
 * reached MCP.
 *
 * The hosted form is the repo-relative path, which is the honest answer: there
 * is no local file to open, and `compileTask` returns the markdown itself for
 * exactly that reason.
 */
export function taskFilePath(id, dir) {
  sanitizeTaskId(id);
  if (getCurrentSession()) return ctxPath('context', 'tasks', `${id}.md`);
  return join(tasksDir(dir), `${id}.md`);
}

export function taskFileExists(id, dir) {
  sanitizeTaskId(id);
  const s = sessionRead(ctxPath('context', 'tasks', `${id}.md`));
  if (s !== undefined) return s !== null;
  return existsSync(taskFilePath(id, dir));
}

export function writeTaskFile(id, content, dir) {
  sanitizeTaskId(id);
  if (sessionWrite(ctxPath('context', 'tasks', `${id}.md`), content)) return;
  const d = tasksDir(dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.md`), content);
}

export function readTaskFile(id, dir) {
  sanitizeTaskId(id);
  const s = sessionRead(ctxPath('context', 'tasks', `${id}.md`));
  if (s !== undefined) {
    if (s === null) throw new Error(`no compiled prompt for task "${id}"`);
    return s;
  }
  return readFileSync(taskFilePath(id, dir), 'utf-8');
}

export function deleteTaskFile(id, dir) {
  sanitizeTaskId(id);
  if (sessionDelete(ctxPath('context', 'tasks', `${id}.md`))) return;
  const p = taskFilePath(id, dir);
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Tasks live inside the tree they belong to, and the project is now one of
 * those trees.
 *
 * `workstream` absent means every tree, including the project's. Passing it
 * explicitly as `null` means the project alone — which is why the key has to be
 * tested for presence rather than for truthiness: "the project" and "everywhere"
 * are both falsy and are not the same request.
 */
export function listTasks(opts = {}, dir) {
  const scoped = Object.prototype.hasOwnProperty.call(opts, 'workstream');
  const targets = scoped ? [isProjectLevel(opts.workstream) ? null : opts.workstream]
    : [null, ...listWorkstreamIds(dir)];
  // Deduped by id, because a project part-way through the migration can have a
  // project tree and a `main` workstream at once, and a task recorded in both
  // would otherwise be counted twice — enough to make a prefix look ambiguous
  // against itself.
  const seen = new Set();
  const out = [];
  for (const target of targets) {
    const tree = readTree(target, dir);
    const tasks = Array.isArray(tree.tasks) ? tree.tasks : [];
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      // The tree it was found in decides where it lives when the task does
      // not say — checking the task's own field first made an old task with no
      // workstream on it read as project-level, which for a scoped member is a
      // sibling's task appearing in their list.
      out.push({ ...task, workstream: resolveTarget(task.workstream ?? target) });
    }
  }
  return out;
}

export function resolveTaskId(prefix, dir) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error(`no task matches "${prefix}"`);
  }
  const all = listTasks({}, dir);
  const keyed = all.find(t => t.key === prefix);
  if (keyed) return keyed.id;
  const matches = all.filter(t => t.id === prefix || t.id.startsWith(prefix));
  if (matches.length === 0) throw new Error(`no task matches "${prefix}"`);
  const exact = matches.find(t => t.id === prefix);
  if (exact) return exact.id;
  if (matches.length > 1) throw new Error(`prefix "${prefix}" is ambiguous: ${matches.map(t => t.id).join(', ')}`);
  return matches[0].id;
}

export function readTask(idOrPrefix, dir) {
  const id = resolveTaskId(idOrPrefix, dir);
  const all = listTasks({}, dir);
  const task = all.find(t => t.id === id);
  return { task, workstream: task.workstream };
}

export function writeTask(task, dir) {
  sanitizeTaskId(task?.id);
  // A task belongs to a workstream; the project's own work is a workstream too.
  if (isProjectLevel(task.workstream)) throw new TaskWithoutWorkstreamError();
  const wsId = task.workstream;
  sanitizeWorkstreamId(wsId);
  return withCounters(dir, config => {
    const ws = readTree(wsId, dir);
    const tasks = Array.isArray(ws.tasks) ? ws.tasks : [];
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) task.key = tasks[idx].key;
    else {
      const minted = mintTaskKey(config.nextKey, { number: workstreamNumber(config, wsId), workstream: wsId });
      task.key = minted.key;
      writeConfig({ ...config, nextKey: minted.counters }, dir);
    }
    if (idx >= 0) tasks[idx] = task;
    else tasks.push(task);
    ws.tasks = tasks;
    writeTree(wsId, ws, dir);
    return task;
  });
}

export function deleteTask(idOrPrefix, dir) {
  const id = resolveTaskId(idOrPrefix, dir);
  return withCounters(dir, () => {
    const { workstream: wsId } = readTask(id, dir);
    const ws = readTree(wsId, dir);
    ws.tasks = (ws.tasks || []).filter(t => t.id !== id);
    writeTree(wsId, ws, dir);
    deleteTaskFile(id, dir);
    return { id, workstream: wsId };
  });
}


// ---- Targets: the project, or one workstream ----

/**
 * Read whichever tree a caller is pointed at.
 *
 * Contribute and ask do the same thing to either level, and the
 * only difference is which file it lands in. Dispatching here keeps that
 * difference in one place rather than putting the same `if` at the top of every
 * command — which is how `main` came to mean two things to begin with.
 */
export function readTree(target, dir) {
  return isProjectLevel(target) ? readProject(dir) : readWorkstream(target, dir);
}

export function writeTree(target, tree, dir) {
  if (isProjectLevel(target)) return writeProject(tree, dir);
  return writeWorkstream(target, tree, dir);
}

export function readTreeMd(target, dir) {
  return isProjectLevel(target) ? readProjectMd(dir) : readWorkstreamMd(target, dir);
}

export function writeTreeMd(target, content, dir) {
  if (isProjectLevel(target)) return writeProjectMd(content, dir);
  return writeWorkstreamMd(target, content, dir);
}

/**
 * Remove a workstream and its compiled file.
 *
 * Only the project-layer migration needs this, and it needs it in both modes —
 * a hosted project has no filesystem to unlink from, and it is the one place
 * `main` has to actually stop existing rather than merely stop being referenced.
 */
export function deleteWorkstream(id, dir) {
  sanitizeWorkstreamId(id);
  const jsonPath = ctxPath('workstreams', `${id}.json`);
  const mdPath = ctxPath('context', 'workstreams', `${id}.md`);
  if (getCurrentSession()) {
    sessionDelete(jsonPath);
    sessionDelete(mdPath);
    return;
  }
  const json = resolve(dir, 'workstreams', `${id}.json`);
  if (existsSync(json)) unlinkSync(json);
  const md = resolve(dir, 'context', 'workstreams', `${id}.md`);
  if (existsSync(md)) unlinkSync(md);
}
