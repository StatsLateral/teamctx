/**
 * Authenticated encryption for secrets at rest.
 *
 * Nothing but the crypto lives here: an envelope format and seal/open over
 * AES-256-GCM from Node's built-in `crypto`. The KV layer decides which keys
 * are secret and calls this; it is the only caller.
 *
 * Envelope (stored in place of the JSON value):
 *   {"enc":"v1","kid":"k2","iv":<b64url 12B>,"ct":<b64url>,"tag":<b64url 16B>}
 *
 * The KV key name is the additional authenticated data, so a ciphertext copied
 * to another key fails to open. The whole record is encrypted, not single
 * fields, which is simpler and hides metadata (such as who lent a credential).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ENC_VERSION = 'v1';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** Parse `TEAMCTX_SECRET_KEYS` (JSON `kid -> base64 32-byte key`) into kid -> Buffer. */
export function loadSecretKeys(env = process.env) {
  const raw = env.TEAMCTX_SECRET_KEYS;
  if (!raw) return {};
  let map;
  try { map = JSON.parse(raw); }
  catch { throw new Error('TEAMCTX_SECRET_KEYS is not valid JSON'); }
  const out = {};
  for (const [kid, b64] of Object.entries(map)) {
    const key = Buffer.from(String(b64), 'base64');
    if (key.length !== 32) throw new Error(`TEAMCTX_SECRET_KEYS["${kid}"] must be a base64-encoded 32-byte key`);
    out[kid] = key;
  }
  return out;
}

export function activeKid(env = process.env) {
  return env.TEAMCTX_SECRET_KEY_ACTIVE || null;
}

/** True for a value that is one of our envelopes. */
export function isEnvelope(value) {
  return !!value && typeof value === 'object' && value.enc === ENC_VERSION
    && typeof value.ct === 'string' && typeof value.iv === 'string' && typeof value.tag === 'string';
}

/**
 * Encrypt a JSON-serialisable record to an envelope object, bound to `keyName`.
 * `keys` is kid -> Buffer; `kid` names the key to use.
 */
export function seal(record, keyName, { keys, kid }) {
  const key = keys?.[kid];
  if (!key) throw new Error(`no secret key for kid "${kid}"`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(keyName), 'utf8'));
  const pt = Buffer.from(JSON.stringify(record), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return { enc: ENC_VERSION, kid, iv: b64u(iv), ct: b64u(ct), tag: b64u(cipher.getAuthTag()) };
}

/**
 * Decrypt an envelope back to its record, verifying the key name as AAD.
 * Throws on a wrong/removed key, a tampered record, or a key-name mismatch.
 */
export function open(envelope, keyName, { keys }) {
  if (!isEnvelope(envelope)) throw new Error('not an encrypted record');
  const key = keys?.[envelope.kid];
  if (!key) throw new Error(`no secret key for kid "${envelope.kid}"`);
  const decipher = createDecipheriv('aes-256-gcm', key, unb64u(envelope.iv));
  decipher.setAAD(Buffer.from(String(keyName), 'utf8'));
  decipher.setAuthTag(unb64u(envelope.tag));
  const pt = Buffer.concat([decipher.update(unb64u(envelope.ct)), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}
