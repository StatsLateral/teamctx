/**
 * A link from a chat back to the thing it just touched.
 *
 * Somebody adds context through their assistant and has no way to see it: the
 * reply says what changed, and the tree it changed lives on a page they would
 * have to find. So the tools that touch something hand back a link to it, and
 * the assistant passes it on.
 *
 * Two rules the format is built on, both learned the hard way:
 *
 * The parameters are stable ids, never the `1.2` numbering the page displays —
 * that numbering shifts the moment anybody adds a Why above it, and a link that
 * rots quietly is worse than no link.
 *
 * And they are a query string, not a `#fragment`. A fragment never reaches the
 * server, so it would be dropped the moment a signed-out click went through
 * sign-in and came back — which is exactly the click this exists for.
 *
 * Nothing here carries a credential. Following a link still means signing in
 * and passing the same access checks, so forwarding one grants nobody anything.
 */

/** The four things a link can point at, in the order they are read. */
export const VIEW_PARAMS = ['ws', 'item', 'task', 'review'];

/**
 * What an id may look like.
 *
 * Deliberately narrow. These values are read back off the URL and used to look
 * things up, and a character class is the cheapest place to stop a surprise —
 * the page never echoes them, but "never" is easier to keep when the values are
 * boring.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isViewId = (v) => typeof v === 'string' && ID.test(v);

export class ViewUrlError extends Error {
  constructor(message) {
    super(message);
    this.code = 'VIEW_URL';
  }
}

/**
 * The link to a project, and optionally to one thing inside it.
 *
 * `ws` is left off for project level, which is `null` in the data and has no id
 * to name. An unusable id is dropped rather than carried: a link to the
 * workstream is still worth having when the item cannot be addressed.
 */
export function buildViewUrl({ base, owner, repo, ws = null, item = null, task = null, review = null } = {}) {
  if (!base) throw new ViewUrlError('no deployment address for this project, so there is no page to link to');
  if (!isViewId(owner) || !isViewId(repo)) throw new ViewUrlError('owner and repo are required');

  const url = new URL(`/project/${owner}/${repo}`, base.endsWith('/') ? base : `${base}/`);
  for (const [key, value] of [['ws', ws], ['item', item], ['task', task], ['review', review]]) {
    if (value != null && isViewId(value)) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * The parameters off an incoming link, and nothing else.
 *
 * Anything unknown, misspelled or out of shape is left out rather than passed
 * along — the page decides what exists, but it should never be handed a value
 * this file would not have written.
 */
export function parseViewParams(query = {}) {
  const out = {};
  for (const key of VIEW_PARAMS) {
    const raw = query[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && isViewId(value)) out[key] = value;
  }
  return out;
}

/**
 * Is this a path the sign-in flow may send somebody back to?
 *
 * Same-site paths only, and only the parameters above. `returnTo` is the one
 * place a value from a query string decides a redirect, so it is allow-listed
 * rather than sanitised: `//host` and `https://host` are not paths, whatever
 * else they might parse as.
 */
export function isReturnable(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  const [pathname, rest] = path.split('?');
  const known = /^\/(?:settings(?:\/[a-z-]+)?|projects|project\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/;
  if (!known.test(pathname)) return false;
  if (rest === undefined) return true;
  if (rest.includes('#')) return false;

  const params = new URLSearchParams(rest);
  for (const [key, value] of params) {
    // `view` is the columns/list toggle: part of the page, not part of a link's
    // target, but it travels the same way and has its own small vocabulary.
    if (key === 'view') {
      if (value !== 'list' && value !== 'columns') return false;
      continue;
    }
    if (key === 'history') {
      if (value !== '1') return false;
      continue;
    }
    // Which tab of the project page, and which page of its list.
    if (key === 'tab') {
      if (!['context', 'tasks', 'review'].includes(value)) return false;
      continue;
    }
    if (key === 'page' || key === 'ipage' || key === 'npage') {
      if (!/^[1-9]\d{0,3}$/.test(value)) return false;
      continue;
    }
    if (key === 'taskWs') {
      if (!['@project', '@all'].includes(value) && !isViewId(value)) return false;
      continue;
    }
    if (key === 'taskOwner') {
      if (!value || value.length > 128 || /[\u0000-\u001f\u007f<>]/.test(value)) return false;
      continue;
    }
    if (!VIEW_PARAMS.includes(key) || !isViewId(value)) return false;
  }
  return true;
}
