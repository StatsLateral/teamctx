/**
 * Connected sources (#168): what a project's context was drawn from.
 *
 * When something an assistant read in Slack, Notion, Google Drive, SharePoint,
 * Dropbox or Coda reaches the project, a reference to it is kept: which tool,
 * which item, when it was read, who brought it, and what it feeds. Links and
 * short summaries only. Each app stays where it is: there is no field for the
 * item's contents, and a link is stripped of anything that looks like a token
 * before it is written, because the record lives in the team's repository where
 * everyone with access can read it.
 *
 * This is the one place a reference is built, so those rules hold for both ways
 * one arrives: through the person's assistant (`contribute`), and through
 * `teamctx import`.
 */
import { createHash } from 'crypto';
import { readSourceRef, writeSourceRef } from './storage.js';

/** The tools a reference can name, as the drawer shows them. */
export const CONNECTORS = {
  slack: { name: 'Slack', mark: 'S' },
  notion: { name: 'Notion', mark: 'N' },
  gdrive: { name: 'Google Drive', mark: 'G' },
  m365: { name: 'Microsoft SharePoint', mark: 'M' },
  dropbox: { name: 'Dropbox', mark: 'D' },
  coda: { name: 'Coda', mark: 'C' },
  other: { name: 'Other sources', mark: '·' },
};

/** What an assistant or an importer might call a tool, mapped to its key. */
const ALIASES = {
  slack: 'slack',
  notion: 'notion',
  gdrive: 'gdrive', 'google drive': 'gdrive', googledrive: 'gdrive', drive: 'gdrive', google: 'gdrive', 'google docs': 'gdrive',
  m365: 'm365', sharepoint: 'm365', onedrive: 'm365', 'microsoft 365': 'm365', 'microsoft sharepoint': 'm365', office365: 'm365',
  dropbox: 'dropbox',
  coda: 'coda',
};

export const TITLE_MAX = 200;
export const SUMMARY_MAX = 400;
/** How many references one contribution can carry. */
export const SOURCES_PER_CONTRIBUTION = 20;

/**
 * A query parameter that carries a credential, matched by its whole name: a
 * substring match also took `rlkey` (Dropbox) and `resourcekey` (Drive), which a
 * shared link needs in order to open.
 */
const SECRET_PARAM = /^(?:access_?token|id_?token|refresh_?token|token|auth|authorization|code|key|api_?key|secret|client_?secret|sig|signature|password|passwd|pwd|credential|session|sessionid|sid|jwt|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$|_token$/i;

const oneLine = (v, max) => String(v ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The tool's key, or `other` for one not on the list. */
export function connectorKey(name) {
  const k = String(name ?? '').trim().toLowerCase();
  return ALIASES[k] || ALIASES[k.replace(/[^a-z0-9 ]/g, '')] || 'other';
}

/**
 * A link that is safe to keep: `http` or `https` only, with no user or password
 * in it and no query parameter whose name suggests a credential. Anything that
 * is not a link comes back `null`.
 */
export function cleanLink(link) {
  if (typeof link !== 'string' || !link.trim()) return null;
  let url;
  try { url = new URL(link.trim()); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.username = '';
  url.password = '';
  for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.delete(name);
  // A fragment can carry a token too (implicit OAuth puts one there).
  if (/token|code=|secret|signature|password/i.test(url.hash)) url.hash = '';
  return url.toString().slice(0, 2000);
}

/** A stable id for one item in one tool: the same item read again is the same record. */
export function sourceId(connector, handle) {
  return createHash('sha256').update(`${connector}\n${handle}`).digest('hex').slice(0, 24);
}

/**
 * Turn what arrived into the fields a reference keeps, or `null` when there is
 * nothing to point at (no link and no title). Only these fields are read:
 * anything else that came with it, a body or a token included, is never looked
 * at, so it can never be written.
 *
 * Its id comes from the link, else the tool's own id for the item (`itemId`, as
 * an importer knows it), and only last from its title, so two different items
 * that happen to share a title stay two references whenever either is known.
 */
export function cleanRef(input) {
  if (!input || typeof input !== 'object') return null;
  const connector = connectorKey(input.connector);
  const link = cleanLink(input.link);
  const title = oneLine(input.title, TITLE_MAX);
  const itemId = oneLine(input.itemId, 200) || null;
  const summary = oneLine(input.summary, SUMMARY_MAX);
  if (!link && !title) return null;
  const handle = link || (itemId ? `id:${itemId}` : `title:${title.toLowerCase()}`);
  return { id: sourceId(connector, handle), connector, title: title || link, link, ...(itemId ? { itemId } : {}), summary };
}

/** Who brought it, as recorded: a name and the key behind it. */
const person = (by) => (by ? { name: oneLine(by.name, 120), key: by.key || null } : null);

/**
 * Record these references as feeding one contribution (`feed`: `{ workstream,
 * contribution, task? }`).
 *
 * What a contribution said about an item, who brought it and when are kept on
 * that feed, not on the item: so an item cited again never loses what an earlier
 * contribution said about it, and a reader who may see only some of its feeds
 * sees only what those said. The item keeps what is true of it in every case:
 * its tool, link, id and title. `summary` is the contribution's own, used for an
 * item that came without one. Only the files for these items are read, never
 * every reference. Returns the ids written.
 */
export function recordSources(refs, { by = null, at = new Date().toISOString(), feed, via = 'assistant', summary = '', dir } = {}) {
  const list = (Array.isArray(refs) ? refs : []).slice(0, SOURCES_PER_CONTRIBUTION).map(cleanRef).filter(Boolean);
  if (!list.length || !feed?.contribution) return [];
  const written = [];
  for (const ref of list) {
    if (written.includes(ref.id)) continue;
    const old = readSourceRef(ref.id, dir);
    const feeds = (Array.isArray(old?.feeds) ? old.feeds : [])
      .filter(f => f && typeof f === 'object' && !sameFeed(f, feed));
    const entry = {
      workstream: feed.workstream ?? null,
      contribution: String(feed.contribution),
      ...(feed.task ? { task: feed.task } : {}),
      at,
      by: person(by),
      summary: ref.summary || oneLine(summary, SUMMARY_MAX),
      via,
    };
    const { summary: _s, ...item } = ref;
    writeSourceRef({
      ...item,
      title: ref.title || old?.title || '',
      firstReadAt: old?.firstReadAt || at,
      feeds: [...feeds, entry],
    }, dir);
    written.push(ref.id);
  }
  return written;
}

/** One thing a reference feeds: a contribution, and its task. */
const sameFeed = (a, b) => String(a.contribution) === String(b.contribution) && (a.task || null) === (b.task || null);

/**
 * The references a reader may see, each with only the feeds they may see, and
 * what to show of it taken from those feeds alone.
 *
 * - `canSee(workstream)`: is that part of the work in their scope (the project
 *   itself, `null`, is for everyone with access).
 * - `counts(feed)`: does that feed's contribution count for this reader, for
 *   example only approved ones for a member, and waiting ones too for a manager.
 *
 * A reference left with no feed is not shown at all, so its title and link never
 * reach the reader. Its summary, who brought it and when are the latest visible
 * feed's, never one from a part of the work the reader cannot see.
 */
export function visibleSources(records, { canSee = () => true, counts = () => true } = {}) {
  return Object.values(records || {})
    .map(r => {
      const feeds = (Array.isArray(r.feeds) ? r.feeds : [])
        .filter(f => f && typeof f === 'object' && (f.workstream == null || canSee(f.workstream)) && counts(f))
        .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      const latest = feeds[feeds.length - 1];
      return {
        id: r.id, connector: r.connector, title: r.title, link: r.link ?? null, feeds,
        summary: [...feeds].reverse().find(f => f.summary)?.summary || '',
        lastReadAt: latest?.at || null,
        by: latest?.by || null,
      };
    })
    .filter(r => r.feeds.length)
    .sort((a, b) => String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || '')));
}
