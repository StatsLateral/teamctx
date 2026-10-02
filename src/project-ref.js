/**
 * The repository somebody means, out of whatever they paste.
 *
 * A person who has been sent a project has one of these in their clipboard: the
 * connector URL their manager handed out, a link to a page in the project, the
 * GitHub page itself, or just its name. Asking them which of those the box wants
 * is asking them to understand the difference, and the one who pasted the wrong
 * one gets "no such project" for a repository that plainly exists.
 *
 * So all of them are accepted, and nothing else is guessed at: a URL has to
 * name the repository somewhere this recognises, rather than have its last two
 * path segments taken on faith.
 */

// What GitHub itself allows. An owner is letters, digits and hyphens; a repo
// also takes dots and underscores. Checked so a typo stops here rather than
// becoming a request for a repository that cannot exist.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

const pair = (owner, repo) => {
  const name = String(repo || '').replace(/\.git$/i, '');
  return OWNER.test(String(owner || '')) && REPO.test(name) && name !== '.' && name !== '..'
    ? { owner: String(owner), repo: name }
    : null;
};

/**
 * `{ owner, repo }`, or null when it is not a reference to a repository.
 *
 * Accepted:
 *   acme/ledger                                   what they would type
 *   https://host/api/mcp/acme/ledger              the connector URL
 *   https://host/project/acme/ledger?ws=product   a link to a page in it
 *   https://github.com/acme/ledger/tree/main      the repository on GitHub
 *   git@github.com:acme/ledger.git                a clone line
 */
export function parseProjectRef(input) {
  const text = String(input || '').trim().replace(/^<|>$/g, '');
  if (!text) return null;

  // A clone line is not a URL, so it is turned into one rather than parsed twice.
  const asUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text
    : /^git@/i.test(text) ? `https://${text.slice(4).replace(':', '/')}`
      : /^(?:www\.)?github\.com\//i.test(text) ? `https://${text}`
        : null;

  if (!asUrl) {
    const parts = text.replace(/\/+$/, '').split('/');
    return parts.length === 2 ? pair(parts[0], parts[1]) : null;
  }

  let url;
  try { url = new URL(asUrl); } catch { return null; }
  const segs = url.pathname.split('/').map(decodeURIComponent).filter(Boolean);

  // The two segments after whichever marker the link uses. `api/mcp` is the
  // connector, `project` is a page on this server, and on github.com the
  // repository is simply first — the rest of that path is a branch or a file.
  const at = segs.findIndex((s, i) => (s === 'mcp' && segs[i - 1] === 'api') || s === 'project');
  if (at >= 0) return pair(segs[at + 1], segs[at + 2]);
  if (/(^|\.)github\.com$/i.test(url.hostname)) return pair(segs[0], segs[1]);
  return null;
}
