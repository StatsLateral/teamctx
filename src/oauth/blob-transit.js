import { randomBytes } from 'crypto';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { list, del } from '@vercel/blob';

/**
 * A transit blob for file outputs too big for the function body (#251).
 *
 * The hosted upload paths — the project page form and the single-PUT upload
 * ticket (#257) — send the bytes *through* the Vercel serverless function,
 * whose request body is capped at ~4.5 MB. A larger file cannot come in that
 * way. So instead the sandbox sends the bytes *around* the function, straight
 * to Vercel Blob, and the function only ever handles small things: it mints the
 * short-lived client token that authorises that one upload, and later fetches
 * the bytes back out of the blob to validate and commit them, exactly as a page
 * upload is committed. The blob is pure transit — deleted as soon as the bytes
 * are committed, and given a one-day TTL so an abandoned upload cleans itself
 * up too.
 *
 * The client token is bound to a single, unguessable pathname with 256 bits of
 * randomness (the same strength as an upload ticket), a size cap and a ten
 * minute expiry, so even a public transit blob is safe for the seconds it
 * exists. Nothing here is a second home for a file: the only durable store is
 * the project's own git repository, as everywhere else.
 */

/** Where the sandbox PUTs the bytes — Vercel Blob's ingest API, not teamctx. */
export const BLOB_UPLOAD_API = 'https://vercel.com/api/blob';
/** The Blob API version the current @vercel/blob client speaks. */
const BLOB_API_VERSION = '13';

/** Whether this deployment has a Blob store to transit through. */
export function blobConfigured(env = process.env) {
  return Boolean(env && env.BLOB_READ_WRITE_TOKEN);
}

function readWriteToken(env = process.env) {
  const token = env && env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('large uploads are not configured on this deployment.');
  return token;
}

/** The store id is the fourth `_`-separated field of a read-write token. */
export function storeIdFromToken(token) {
  return String(token || '').split('_')[3] || '';
}

/** A one-off, unguessable destination path for one transit blob. */
export function transitPathname(taskId, name) {
  const rand = randomBytes(32).toString('hex');
  const safe = (String(name || '').split(/[\\/]/).pop() || 'file')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[.\-_]+/, '')
    .slice(0, 80) || 'file';
  return `teamctx-transit/${encodeURIComponent(String(taskId))}/${rand}/${safe}`;
}

/**
 * Mint what a sandbox needs to PUT one file straight to Vercel Blob: the full
 * URL, the method, and every header the ingest API expects (the client token as
 * the bearer, the store id, the access and the version). The returned
 * `pathname` is the handle the server finalises against — the bytes are fetched
 * back and deleted by it, never by the sandbox.
 */
export async function mintBlobUpload({
  taskId, name, contentType, maxBytes, ttlSeconds = 600, now = Date.now(), env = process.env,
}) {
  const rwToken = readWriteToken(env);
  const storeId = storeIdFromToken(rwToken);
  const pathname = transitPathname(taskId, name);
  const validUntil = now + ttlSeconds * 1000;

  const clientToken = await generateClientTokenFromReadWriteToken({
    token: rwToken,
    pathname,
    validUntil,
    maximumSizeInBytes: maxBytes || undefined,
    allowedContentTypes: contentType ? [contentType] : undefined,
    addRandomSuffix: false,
    // A courier blob that cleans itself up a day later even if finalize never runs.
    ttlDays: 1,
  });

  const requestId = `${storeId}:${now}:${randomBytes(6).toString('hex')}`;
  const headers = {
    authorization: `Bearer ${clientToken}`,
    'x-api-version': BLOB_API_VERSION,
    'x-vercel-blob-store-id': storeId,
    'x-vercel-blob-access': 'public',
    'x-api-blob-request-id': requestId,
    'x-api-blob-request-attempt': '0',
    ...(contentType ? { 'x-content-type': contentType } : {}),
  };
  return {
    uploadUrl: `${BLOB_UPLOAD_API}/?pathname=${encodeURIComponent(pathname)}`,
    method: 'PUT',
    headers,
    pathname,
    uploadHost: new URL(BLOB_UPLOAD_API).host,
    expiresAt: new Date(validUntil).toISOString(),
  };
}

/**
 * Read the bytes back out of the transit blob for committing, or null when the
 * blob is not there (the sandbox never sent it). Located by its exact pathname
 * rather than a reconstructed URL, so no address format is assumed.
 */
export async function fetchTransitBytes({ pathname, env = process.env }) {
  const token = readWriteToken(env);
  const { blobs } = await list({ prefix: pathname, limit: 1, token });
  const blob = blobs && blobs[0];
  if (!blob || blob.pathname !== pathname) return null;
  const res = await fetch(blob.downloadUrl || blob.url);
  if (!res || !res.ok) throw new Error(`the uploaded file could not be read back (${res ? res.status : 'no response'}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes };
}

/** Delete the transit blob; it is only ever a courier. Never throws. */
export async function deleteTransitBlob({ pathname, env = process.env }) {
  try {
    const token = readWriteToken(env);
    const { blobs } = await list({ prefix: pathname, limit: 1, token });
    const blob = blobs && blobs[0];
    if (blob) await del(blob.url, { token });
  } catch {
    // Best effort: the blob's own one-day TTL is the backstop.
  }
}
