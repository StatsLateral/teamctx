import { execFile } from 'child_process';
import { promisify } from 'util';
import { getCurrentSession } from './session-context.js';

const execFileAsync = promisify(execFile);

export async function checkGitRepo({ cwd } = {}) {
  if (getCurrentSession()) return;   // hosted mode: repo is remote, git binary not involved
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], cwd ? { cwd } : undefined);
  } catch {
    throw new Error('teamctx must be run inside a git repository. Run `git init` first.');
  }
}

export async function commitContext(message, { cwd, author } = {}) {
  const session = getCurrentSession();
  if (session) {
    // Hosted mode: flush all buffered writes as ONE atomic commit via the
    // Git Data API. Matches local behavior — one CLI/tool call = one commit.
    // Reported rather than assumed: a write of the value already stored leaves
    // nothing to commit, and a caller told it committed anyway is handed a
    // success it can only disprove by reading back.
    const r = await session.commit(message, { author });
    return { committed: r?.committed !== false };
  }
  const opts = cwd ? { cwd } : undefined;
  await execFileAsync('git', ['add', '.teamctx/'], opts);
  try {
    await execFileAsync('git', ['commit', '-m', message], opts);
    return { committed: true };
  } catch (err) {
    if (String(err.stdout || '').includes('nothing to commit')) return { committed: false };
    throw err;
  }
}

export async function pushContext({ cwd } = {}) {
  if (getCurrentSession()) return;   // hosted mode: commitContext already pushed the ref
  await execFileAsync('git', ['push'], cwd ? { cwd } : undefined);
}

export async function pullContext({ cwd } = {}) {
  if (getCurrentSession()) return;   // hosted mode: session prefetches on every request
  await execFileAsync('git', ['pull', '--no-rebase'], cwd ? { cwd } : undefined);
}
