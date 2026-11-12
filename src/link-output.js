/**
 * Links as task outputs: a deliverable that lives in a connected cloud tool
 * (Google Drive, SharePoint/OneDrive, Dropbox…) rather than in the repository
 * (#245).
 *
 * teamctx copies nothing and holds no credential: the assistant supplies the
 * link, a name and — if the tool gives one — a version marker. The link is
 * normalised and stripped of any credential-bearing query parameter by the same
 * code that records connected sources (`sources.js`), so a "Share" link and an
 * address-bar link for one file become a single reference, and a SharePoint or
 * Dropbox *sharing* link (which is the access itself) is never stored — the
 * reference keeps its name instead.
 *
 * The record keeps `link: { connector, title, url, itemId?, version }`. `url`
 * is null when there was nothing safe to keep; `version` is null when the tool
 * gave no marker, so the record says which it was rather than inventing one.
 */
import { cleanRef } from './sources.js';

const VERSION_MAX = 200;

/** A link output that could not be recorded, with a message meant for the person. */
export class LinkOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinkOutputError';
    this.code = 'LINK_OUTPUT_REFUSED';
  }
}

/** Collapse control characters and whitespace; trim; cap length. */
function oneLine(v, max) {
  return String(v ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Check a link output and return what to store, or throw LinkOutputError.
 *
 * @param {object} input
 * @param {string} input.connector  the tool the file lives in (gdrive, m365, dropbox, …)
 * @param {string} [input.url]      the link the assistant copied
 * @param {string} [input.title]    what the file is called
 * @param {string} [input.version]  the tool's version marker (revision/ETag), if any
 * @returns {{ connector, title, url, itemId?, version }}
 */
export function validateLinkOutput({ connector, url, title, version } = {}) {
  // cleanRef normalises the link, strips credential-bearing parameters, drops a
  // bare sharing link, and keys the reference. It returns null when there is
  // neither a usable link nor a title — nothing to point at.
  const ref = cleanRef({ connector, link: url, title });
  if (!ref) {
    throw new LinkOutputError('a link output needs a link or a name for the file');
  }
  const v = oneLine(version, VERSION_MAX);
  return {
    connector: ref.connector,
    title: ref.title,
    url: ref.link ?? null,
    ...(ref.itemId ? { itemId: ref.itemId } : {}),
    version: v || null,
  };
}
