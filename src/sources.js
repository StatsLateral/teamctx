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
import { readSourceRefs, writeSourceRef } from './storage.js';

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

/** A query parameter whose name says it may carry a credential. */
const SECRET_PARAM = /token|key|secret|sig|signature|password|passwd|pwd|auth|code|credential|session|cookie/i;

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
  if (SECRET_PARAM.test(url.hash)) url.hash = '';
  return url.toString().slice(0, 2000);
}

/** A stable id for one item in one tool: the same item read again is the same record. */
export function sourceId(connector, handle) {
  return createHash('sha256').update(`${connector}\n${handle}`).digest('hex').slice(0, 24);
}

/**
 * Turn what arrived into the fields a reference keeps, or `null` when there is
 * nothing to point at (no link and no title). Only these four fields are read:
 * anything else that came with it, a body or a token included, is never looked
 * at, so it can never be written.
 */
export function cleanRef(input) {
  if (!input || typeof input !== 'object') return null;
  const connector = connectorKey(input.connector);
  const link = cleanLink(input.link);
  const title = oneLine(input.title, TITLE_MAX);
  const summary = oneLine(input.summary, SUMMARY_MAX);
  if (!link && !title) return null;
  return { id: sourceId(connector, link || title.toLowerCase()), connector, title: title || link, link, summary };
}

/** One thing a reference feeds: a contribution in a part of the work, and its task. */
const sameFeed = (a, b) => a.contribution === b.contribution && (a.task || null) === (b.task || null);

/**
 * Record these references as feeding `feed` (`{ workstream, contribution,
 * task? }`). A reference already on record is updated rather than added again:
 * it was read again, so `lastReadAt`, its title and summary refresh, and the
 * new feed joins the old ones. Returns the ids written.
 */
export function recordSources(refs, { by = null, at = new Date().toISOString(), feed, via = 'assistant', dir } = {}) {
  const list = (Array.isArray(refs) ? refs : []).slice(0, SOURCES_PER_CONTRIBUTION).map(cleanRef).filter(Boolean);
  if (!list.length) return [];
  const existing = readSourceRefs(dir);
  const written = [];
  for (const ref of list) {
    if (written.includes(ref.id)) continue;
    const old = existing[ref.id];
    const feeds = Array.isArray(old?.feeds) ? old.feeds.filter(f => f && typeof f === 'object') : [];
    const next = {
      ...ref,
      title: ref.title || old?.title || '',
      summary: ref.summary || old?.summary || '',
      by: old?.by || (by ? { name: oneLine(by.name, 120), key: by.key || null } : null),
      firstReadAt: old?.firstReadAt || at,
      lastReadAt: at,
      lastBy: by ? { name: oneLine(by.name, 120), key: by.key || null } : old?.lastBy || null,
      via: old?.via && old.via !== via ? 'both' : via,
      feeds: feed && !feeds.some(f => sameFeed(f, feed)) ? [...feeds, cleanFeed(feed)] : feeds,
    };
    writeSourceRef(next, dir);
    written.push(ref.id);
  }
  return written;
}

function cleanFeed({ workstream = null, contribution = null, task = null } = {}) {
  return { workstream: workstream ?? null, contribution: contribution ?? null, ...(task ? { task } : {}) };
}

/**
 * The references a reader may see, each with only the feeds they may see.
 *
 * `canSee(workstream)` says whether a part of the work is in their scope; the
 * project itself (`null`) is for everyone with access. A reference left with no
 * feed this reader can see is not shown to them at all, so its title and link
 * never reach them.
 */
export function visibleSources(records, canSee = () => true) {
  return Object.values(records || {})
    .map(r => ({ ...r, feeds: (Array.isArray(r.feeds) ? r.feeds : []).filter(f => f && (f.workstream == null || canSee(f.workstream))) }))
    .filter(r => r.feeds.length)
    .sort((a, b) => String(b.lastReadAt || '').localeCompare(String(a.lastReadAt || '')));
}
