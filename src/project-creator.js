import { promisify } from 'util';
import { execFile } from 'child_process';
import { getCurrentSession } from './session-context.js';

const execFileAsync = promisify(execFile);

/**
 * "We could not ask", as distinct from "we asked, and there is no answer".
 *
 * Collapsing the two is what made the display-name fallback reachable on the
 * hosted surface: a rate limit looked identical to a project whose history says
 * nothing, and the weaker check ran in a place where the caller has no file to
 * hand-edit and every reason to be a stranger. `checked` is what keeps them
 * apart, so a transient failure becomes "try again" rather than a way in.
 */
const UNCHECKED_HOSTED = { email: null, checked: false, hosted: true };

/**
 * The same answer, over the API, for a hosted caller with no clone to read.
 *
 * Without this the hosted surface has no history to consult and falls back to
 * comparing display names — the weaker signal, in exactly the place where the
 * caller is most likely to be somebody other than the creator.
 */
const PER_PAGE = 100;

/**
 * A page cap, not a page size.
 *
 * Walking to the oldest commit costs one request per hundred, and a config file
 * with more than a thousand touching commits is not a real project — but the
 * cap must not silently produce a wrong answer, so hitting it reports
 * "unchecked" rather than the oldest commit seen so far.
 */
const MAX_PAGES = 10;

async function creatorViaApi(session) {
  const { owner, repo, ghToken } = session;
  if (!owner || !repo || !ghToken) return UNCHECKED_HOSTED;
  try {
    let last = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits`
          + `?path=.teamctx/config.json&per_page=${PER_PAGE}&page=${page}`,
        { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' } },
      );
      // A rate limit or a 5xx is "ask again", not "there is no creator". The
      // difference decides whether a caller is refused or offered a weaker
      // check, so it must not collapse into one null.
      if (!res.ok) return UNCHECKED_HOSTED;
      const list = await res.json();
      if (!Array.isArray(list)) return UNCHECKED_HOSTED;
      if (list.length) last = list[list.length - 1];
      // Short page means this was the last one, so `last` is now the oldest
      // commit that touched the file — the one that created it.
      if (list.length < PER_PAGE) {
        const email = last?.commit?.author?.email;
        return { email: email ? String(email).toLowerCase() : null, checked: true, hosted: true };
      }
    }
    return UNCHECKED_HOSTED;
  } catch {
    return UNCHECKED_HOSTED;
  }
}

/**
 * Who created this project, according to the repository itself.
 *
 * The commit that first added `.teamctx/config.json` is the `init` commit, and
 * its author is the person who ran it. That is a better answer than anything in
 * `config.json`, because the file is editable by anyone with the repo while the
 * history is not — forging it needs push access, which is the bar repair
 * already sits behind.
 *
 * It also survives the case a display name cannot: somebody whose git name is
 * "Ada" repairing a gate that reads `name:Ada Lovelace`. The email is the same
 * either way.
 *
 * Returns `{ email, checked, hosted }`. `email` is null when the history names
 * nobody; `checked` says whether the history could be consulted at all — a
 * shallow clone, a rate-limited API, no git binary. The caller needs both,
 * because "we asked and it says someone else" and "we could not ask" are
 * different refusals, and only one of them may fall back to a weaker check.
 */
export async function projectCreator(cwd) {
  const session = getCurrentSession();
  if (session) return creatorViaApi(session);
  try {
    const { stdout } = await execFileAsync('git', [
      'log', '--diff-filter=A', '--format=%ae', '--', '.teamctx/config.json',
    ], cwd ? { cwd } : undefined);
    const lines = stdout.trim().split('\n').filter(Boolean);
    // The *last* line is the oldest commit — the one that created the file.
    const email = lines.length ? lines[lines.length - 1].trim().toLowerCase() : null;
    return { email, checked: true, hosted: false };
  } catch {
    return { email: null, checked: false, hosted: false };
  }
}

/**
 * Is this actor the person that email names?
 *
 * GitHub's noreply form, `<id>+<login>@users.noreply.github.com`, is what a
 * commit made through the web flow carries — so it has to be unpacked rather
 * than compared whole, otherwise the creator returning as `github:<id>` fails
 * to match the commit they themselves authored.
 */
export function isCreator(creatorEmail, actor) {
  if (!creatorEmail || !actor) return null;
  const email = String(creatorEmail).toLowerCase();
  const mine = String(actor.email || '').toLowerCase();

  if (mine && mine === email) return true;
  if (String(actor.key || '').toLowerCase() === `git:${email}`) return true;

  const noreply = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  if (noreply) {
    const [, id, login] = noreply;
    if (id && String(actor.key || '') === `github:${id}`) return true;
    if (login && String(actor.login || '').toLowerCase() === login.toLowerCase()) return true;
    // A noreply address names an account outright, so not matching it is a real
    // answer rather than a gap.
    return false;
  }

  // A plain address can only be compared against an address. A hosted caller
  // whose token predates the `user:email` scope has none — and calling that a
  // mismatch would lock the creator out of their own project over MCP, which is
  // the failure this whole command exists to undo. Not knowing is not "no".
  return mine ? false : null;
}
