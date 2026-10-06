/**
 * `.teamctx/.local/`, and keeping it out of the repository.
 *
 * Two things write here and neither should ever be committed: a person's own
 * preferences, and the lock a context write holds while it allocates record
 * keys. The ignore entry is added when the directory is first used, not at
 * `init` — anyone who clones an already-initialized project never runs `init`,
 * so an entry written there would not exist on their machine.
 *
 * Its own module because `storage.js` needs it for the lock and `prefs.js`
 * needs it for preferences, and `prefs.js` already imports `storage.js`. Asking
 * for it the other way round would close that circle.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export const LOCAL_DIR = '.local';
const IGNORE_ENTRY = '.teamctx/.local/';

/**
 * Add the ignore entry, and say whether it had to.
 *
 * Idempotent, and tolerant of the three spellings somebody may already have
 * written by hand. Safe to call on every write, which is what makes it safe to
 * call before taking the lock.
 */
export function ensureGitignored(teamctxDir) {
  const projectDir = dirname(teamctxDir);
  const gitignorePath = join(projectDir, '.gitignore');
  let current = '';
  try { current = readFileSync(gitignorePath, 'utf-8'); } catch { /* no .gitignore yet */ }

  const alreadyIgnored = current
    .split('\n')
    .map(l => l.trim())
    .some(l => l === IGNORE_ENTRY || l === '.teamctx/.local' || l === '.teamctx/.local/*');
  if (alreadyIgnored) return false;

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${IGNORE_ENTRY}\n`);
    return true;
  }
  appendFileSync(gitignorePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${IGNORE_ENTRY}\n`);
  return true;
}
