import { createHash, randomBytes } from 'crypto';
import { kvSet, kvTake, keys } from './kv.js';

/**
 * One-shot tickets for uploading a file output by URL (#257).
 *
 * A person working in a chatbot may make dozens of files. Carrying the bytes
 * through an MCP tool call would spend tokens on every one, so instead the
 * `request_upload` tool mints a ticket here and hands back a short-lived URL;
 * the chatbot's own sandbox sends the bytes straight to it (for example with
 * curl), and the model never holds them.
 *
 * The ticket is the authority for that one upload — there is no sign-in on the
 * upload request — so it is deliberately narrow: a single file, on one task, for
 * ten minutes, once. It carries the credential the member's session would have
 * written with, so the stored output is identical to one made through
 * task_output: same access, same author. Only a sha-256 of the token is the KV
 * key, and the record (which holds that credential) is encrypted at rest like
 * every other token payload, so a leaked store yields nothing that works.
 */

/** Ten minutes: long enough for a sandbox to fetch-and-send, short enough that a leaked URL goes stale fast. */
export const UPLOAD_TICKET_TTL_SECONDS = 10 * 60;

const hashTicket = token => createHash('sha256').update(String(token)).digest('hex');

const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * Mint a ticket for one upload and return the opaque token to put in the URL.
 *
 * Stores only the hash of the token, with a short TTL, so it expires whether or
 * not it is used. The record carries who the uploader is (for authorship), what
 * the file will be called, the size cap, and the credential to write with.
 */
export async function createUploadTicket({
  owner, repo, taskId, actor, name, title, notes, ghToken, maxBytes,
  transport = 'direct', blobPathname = null, now = new Date(),
} = {}) {
  if (!owner || !repo) throw new Error('an upload ticket needs a project');
  if (!taskId) throw new Error('an upload ticket needs a task');
  if (!name) throw new Error('an upload ticket needs a file name');
  if (!ghToken) throw new Error('an upload ticket needs a credential to write with');
  if (transport === 'blob' && !blobPathname) throw new Error('a transit upload ticket needs a blob pathname');

  const token = randomBytes(32).toString('base64url');
  const record = {
    owner: String(owner),
    repo: String(repo),
    taskId: String(taskId),
    actor: actor || null,
    name: String(name),
    title: title || null,
    notes: notes || null,
    ghToken,
    maxBytes: Number(maxBytes) || null,
    // 'direct' = the bytes arrive on the PUT itself (#257); 'blob' = they went
    // around the function to a transit blob and this ticket is spent finalising
    // it (#251).
    transport: transport === 'blob' ? 'blob' : 'direct',
    blobPathname: transport === 'blob' ? String(blobPathname) : null,
    createdAt: now.toISOString(),
  };
  await kvSet(keys.uploadTicket(hashTicket(token)), record, { ttlSeconds: UPLOAD_TICKET_TTL_SECONDS });
  return {
    token,
    expiresAt: new Date(now.getTime() + UPLOAD_TICKET_TTL_SECONDS * 1000).toISOString(),
    record,
  };
}

/**
 * Spend a ticket: read it and delete it in one step, so it cannot be used twice.
 *
 * Returns the record, or null when the token is unknown, already spent or
 * expired. When `owner`/`repo`/`taskId` are given they must match the ticket —
 * a URL for one task cannot be redirected onto another. The delete happens
 * before that check (it is atomic), which only ever burns a ticket whose token
 * the caller already holds, so the authority is unchanged.
 */
export async function consumeUploadTicket(token, { owner, repo, taskId } = {}) {
  if (!token) return null;
  const record = await kvTake(keys.uploadTicket(hashTicket(token)));
  if (!record) return null;
  if (owner && !sameText(record.owner, owner)) return null;
  if (repo && !sameText(record.repo, repo)) return null;
  if (taskId && String(record.taskId) !== String(taskId)) return null;
  return record;
}
