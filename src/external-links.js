/**
 * Where a task lives in somebody else's tool.
 *
 * A team tracks its work in Asana, Jira or the like, and teamctx is not meant to
 * become a second tracker. So a task can carry a link to its ticket there, and
 * nothing more: no status, no comments, no credential. It is what lets a
 * person's assistant find the ticket for a task that an approval has just
 * touched, and offer to update it through its own connection to that tool.
 *
 * The link is cleaned the way a source link is (https only, no user or password,
 * no query parameter that looks like a credential, and never a sharing link,
 * which is the access itself). The tool is worked out from the address and from
 * nothing else: a caller cannot label a link as Asana when it is not on Asana's
 * address, because the label decides how much an assistant trusts the link. An
 * address teamctx does not recognise is kept, as `other`, and is only ever shown
 * to a person, never written to. At most a few per task: a task that needs more
 * is several tasks.
 */
import { cleanLink } from './sources.js';
import { isSharingLink } from './connectors/m365.js';
import { isSharedLink } from './connectors/dropbox.js';

export const MAX_EXTERNAL_PER_TASK = 5;

const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** What a link's address says it is, when it says. */
const HOSTS = [
  [/(^|\.)asana\.com$/i, 'asana'],
  [/(^|\.)atlassian\.net$/i, 'jira'],
  [/(^|\.)jira\.com$/i, 'jira'],
  [/(^|\.)linear\.app$/i, 'linear'],
  [/(^|\.)trello\.com$/i, 'trello'],
  [/(^|\.)monday\.com$/i, 'monday'],
  [/(^|\.)clickup\.com$/i, 'clickup'],
  [/(^|\.)slack\.com$/i, 'slack'],
  [/(^|\.)notion\.(so|site)$/i, 'notion'],
];

export class ExternalLinkError extends Error {
  constructor(message) {
    super(message);
    this.code = 'EXTERNAL_LINK';
  }
}

/** The tool a link belongs to, from its address, or `other`. */
export function systemOf(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return 'other'; }
  return HOSTS.find(([re]) => re.test(host))?.[1] || 'other';
}

/**
 * A link as a task keeps it: `{ system, url, ref? }`, or an error saying what is
 * wrong. `system` is read off the address; it is never taken from the caller.
 */
export function cleanExternal({ url, ref } = {}) {
  const link = cleanLink(url);
  if (!link || !link.startsWith('https://')) throw new ExternalLinkError('a link to a ticket must be an https address');
  if (isSharingLink(link) || isSharedLink(link)) {
    throw new ExternalLinkError('that is a sharing link, which is the access itself: link the ticket by its ordinary address instead');
  }
  const id = typeof ref === 'string' && ref.trim() ? ref.trim() : null;
  if (id && !REF.test(id)) throw new ExternalLinkError('the ticket reference is its id or key, such as PROJ-123');
  return { system: systemOf(link), url: link, ...(id ? { ref: id } : {}) };
}

/** The list with this link in it. The same address replaces itself rather than repeating. */
export function addExternal(list, link) {
  const rest = (Array.isArray(list) ? list : []).filter(e => e?.url !== link.url);
  if (rest.length >= MAX_EXTERNAL_PER_TASK) {
    throw new ExternalLinkError(`a task carries at most ${MAX_EXTERNAL_PER_TASK} links: remove one first, or split the task`);
  }
  return [...rest, link];
}

/** The list without the link at this address. */
export function removeExternal(list, url) {
  const clean = cleanLink(url);
  return (Array.isArray(list) ? list : []).filter(e => e?.url !== clean);
}
