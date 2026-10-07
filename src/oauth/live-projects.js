import { kvGet, kvSet, keys } from './kv.js';

/**
 * The projects on somebody's list that still exist on GitHub, under the names they
 * have there now.
 *
 * The list is what teamctx has been told about, not what GitHub has: a repository
 * deleted there stays on it for ever, and one that was renamed or moved to another
 * owner stays under its old name. So each is asked after. One GitHub says is gone
 * is left off the page; one it has moved is shown under its current name, once.
 * Nothing is removed from the store: if the repository comes back, so does the
 * entry.
 *
 * It is asked with the person's own GitHub token and, where the project lent one,
 * the project's. A project is hidden only if every token that could ask got a
 * definite "not found"; if any of them could see it, or none could be asked, or
 * GitHub was slow or refused, it stays. A verdict is remembered for ten minutes so
 * the list does not cost a GitHub call per project per visit. The memory is
 * per person, never shared: the answer depends on whose token asked (a private
 * repository says 404 to somebody it will not show it to), so one person's verdict,
 * or the current name it carries, is never used for another.
 */

const REMEMBER_SECONDS = 600;
const ASK_TIMEOUT_MS = 2500;
const UNKNOWN = { state: 'unknown' };

const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(UNKNOWN), ms))]);

/** `{ state, fullName? }` for one project: what GitHub says it is, or unknown. */
async function verdictFor(slug, { viewer, userToken, lentToken, check }) {
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) return UNKNOWN;
  const remembered = viewer ? await kvGet(keys.repoState(viewer, owner, repo)) : null;
  if (remembered?.state === 'exists' || remembered?.state === 'gone') return remembered;
  const tokens = [...new Set([userToken, await lentToken(owner, repo)].filter(Boolean))];
  if (!tokens.length) return UNKNOWN;
  const answers = await Promise.all(tokens.map(t => withTimeout(check(t, owner, repo), ASK_TIMEOUT_MS)));
  const seen = answers.find(a => a?.state === 'exists');
  const verdict = seen
    ? { state: 'exists', fullName: seen.fullName || null }
    : answers.every(a => a?.state === 'gone') ? { state: 'gone' } : UNKNOWN;
  if (viewer && verdict.state !== 'unknown') await kvSet(keys.repoState(viewer, owner, repo), verdict, { ttlSeconds: REMEMBER_SECONDS });
  return verdict;
}

export async function liveProjects(slugs, { viewer = null, userToken = null, lentToken = async () => null, check } = {}) {
  const verdicts = await Promise.all(slugs.map(slug => verdictFor(slug, { viewer, userToken, lentToken, check }).catch(() => UNKNOWN)));
  const shown = [];
  slugs.forEach((slug, i) => {
    const v = verdicts[i];
    if (v.state === 'gone') return;
    // Under the name GitHub has for it now, so a renamed repository is not listed
    // twice, once as it was and once as it is.
    const name = v.state === 'exists' && v.fullName && v.fullName.toLowerCase() !== slug.toLowerCase() ? v.fullName : slug;
    if (!shown.some(x => x.toLowerCase() === name.toLowerCase())) shown.push(name);
  });
  return shown;
}
