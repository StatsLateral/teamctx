/**
 * Files as task outputs: validating an uploaded file before it is stored (#244).
 *
 * A task output can be a file the person uploaded. The bytes go into the
 * project's own repository and the manager reviews exactly those bytes, so
 * before anything is written the file is checked here:
 *
 *   - it is within the size limit for the route it came in by;
 *   - it is one of a small allow-list of ordinary work files;
 *   - its real type, read from its leading bytes and not only its name,
 *     matches that extension;
 *   - its name is reduced to something safe to use as a path.
 *
 * The checks refuse, never trim: a file over the limit or of a disallowed type
 * is rejected with a message, as a text output over its length limit is. The
 * caller stores the returned metadata on the output record and the bytes beside
 * it.
 */
import { createHash } from 'crypto';
import { fileTypeFromBuffer } from 'file-type';
import { scanForSecrets, describeSecretFindings } from './secret-scan.js';

// Two routes in, two limits. The CLI writes to the repository itself and allows
// up to 10 MB. The project page posts through the hosted server on Vercel,
// whose functions refuse request bodies over 4.5 MB, so its limit is 4 MB. A
// caller passes the limit for its route as `maxBytes`.
export const MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PAGE_UPLOAD_BYTES = 4 * 1024 * 1024;

// Attaching a folder at once (#256): a run is refused whole, before anything is
// written, if it has more than this many files or more than this many bytes in
// total, so a stray glob against a huge folder cannot bloat the repository. Each
// file still obeys MAX_OUTPUT_FILE_BYTES on its own.
export const MAX_BATCH_FILES = 50;
export const MAX_BATCH_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * Binary work files, each with the content type it is served as. Verified from
 * their leading bytes. The three Office formats (docx, xlsx, pptx) are ZIP
 * containers and share one signature, so a ZIP whose name claims one of them is
 * accepted as that one; they cannot be told apart without opening the archive,
 * which this does not do.
 */
const BINARY_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * Text work files. They have no reliable leading-byte signature, so instead of
 * sniffing a type they are checked to be valid UTF-8 with no NUL byte — which a
 * binary file renamed to `.txt` fails.
 */
const TEXT_TYPES = {
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
};

const OOXML = new Set(['docx', 'xlsx', 'pptx']);
// Spellings that mean the same type, mapped to our canonical extension — both
// for the name the person gives (photo.jpeg) and for what file-type reports.
const EXT_ALIAS = { jpeg: 'jpg' };

export const FILE_OUTPUT_TYPES = { ...BINARY_TYPES, ...TEXT_TYPES };
export const FILE_OUTPUT_EXTENSIONS = Object.keys(FILE_OUTPUT_TYPES);

/** Deliberately refused, so the message can name them: they run in a browser. */
const DANGEROUS_EXTENSIONS = ['svg', 'html', 'htm', 'js', 'exe', 'sh', 'bat'];

/** A file output that could not be stored, with a message meant for the person. */
export class FileOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileOutputError';
    this.code = 'FILE_OUTPUT_REFUSED';
  }
}

/**
 * The upload looked like it held a secret and was refused. A FileOutputError so
 * the CLI prints its message as it does any refusal, but carries the findings
 * so the page can offer an explicit "attach anyway".
 */
export class SecretInUploadError extends FileOutputError {
  constructor(message, findings) {
    super(message);
    this.name = 'SecretInUploadError';
    this.code = 'FILE_OUTPUT_SECRET';
    this.findings = findings || [];
  }
}

/** Human-readable size, for messages and the CLI line: 4 MB, 1.5 MB, 900 KB. */
export function humanBytes(n) {
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.ceil(n / 1024)} KB`;
}

/** The extension of a name, lower-cased, without the dot. '' if there is none. */
export function extensionOf(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Reduce an uploaded name to something safe to use as a path component: no
 * directory parts, no control characters, only characters that behave the same
 * on every filesystem and in git, and not too long. The output id prefixed by
 * the caller keeps two uploads of the same name apart, so this need not be
 * unique.
 */
export function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const ext = extensionOf(base);
  let stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  // Collapse anything outside a conservative set to a single underscore, and
  // trim the leading dots and dashes that make a name awkward or hidden.
  stem = stem
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')          // no "..", which a path-safety check rejects
    .replace(/^[.\-_]+/, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 80)
    .replace(/[.\-_]+$/, '');
  if (!stem) stem = 'file';
  return ext ? `${stem}.${ext}` : stem;
}

/** The sha-256 of some bytes, as hex — recorded so "what was approved" is exact. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decode bytes as a real text file — valid UTF-8 with no NUL byte — returning
 * the string, or null when they are not text (a binary file renamed .txt
 * fails). Decoding once here lets the secret scan reuse the string instead of
 * decoding the whole buffer a second time.
 */
function decodePlainText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    // 'fatal' rejects ill-formed UTF-8 instead of inserting replacement chars.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Check an uploaded file and return what to store, or throw FileOutputError.
 *
 * @param {Uint8Array|Buffer} bytes  the file's contents
 * @param {string} name              the name the person gave it
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]   the limit for this route (default 10 MB)
 * @returns {Promise<{name, type, size, sha256}>}
 */
export async function validateFileOutput(bytes, name, { maxBytes = MAX_OUTPUT_FILE_BYTES, allowSecrets = false } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new FileOutputError('the file could not be read as bytes');
  }
  const size = bytes.length;
  if (size === 0) throw new FileOutputError('the file is empty: there is nothing to attach');
  if (size > maxBytes) {
    throw new FileOutputError(
      `the file is too large to attach (${humanBytes(size)}; the most for this route is ${humanBytes(maxBytes)}). `
      + 'Keep it in a cloud or local folder and attach a part or a summary, or link it. '
      + (maxBytes < MAX_OUTPUT_FILE_BYTES ? `The command line takes up to ${humanBytes(MAX_OUTPUT_FILE_BYTES)}.` : ''),
    );
  }

  const raw = extensionOf(name);
  const ext = EXT_ALIAS[raw] || raw;
  if (!ext) {
    throw new FileOutputError('the file has no extension, so its type cannot be checked. Add one (for example .pdf or .png).');
  }
  if (DANGEROUS_EXTENSIONS.includes(ext)) {
    throw new FileOutputError(`a .${ext} file is not allowed, because it can run in a reader's browser. Allowed types: ${FILE_OUTPUT_EXTENSIONS.join(', ')}.`);
  }
  if (!(ext in FILE_OUTPUT_TYPES)) {
    throw new FileOutputError(`a .${ext} file is not an allowed type. Allowed types: ${FILE_OUTPUT_EXTENSIONS.join(', ')}.`);
  }

  let text = null;
  if (ext in TEXT_TYPES) {
    text = decodePlainText(bytes);
    if (text === null) {
      throw new FileOutputError(`this does not look like a .${ext} text file (it is not valid UTF-8 text). Attach it under its real type.`);
    }
  } else {
    const sniff = await fileTypeFromBuffer(bytes);
    const found = sniff ? (EXT_ALIAS[sniff.ext] || sniff.ext) : null;
    const ok = OOXML.has(ext)
      // The three Office formats are ZIP containers; file-type reads them as
      // 'zip', so a ZIP named .docx/.xlsx/.pptx is taken at its word.
      ? (found === ext || found === 'zip')
      : found === ext;
    if (!ok) {
      const seen = found ? `looks like a .${found} file` : 'could not be recognised';
      throw new FileOutputError(`the file does not match its .${ext} name (it ${seen}). Attach it under its real type.`);
    }
  }

  // A committed secret stays in the repository's history, so scan the text
  // before anything is written and refuse — unless the person has said to
  // attach anyway, in which case the override is recorded (see saveFileOutput)
  // rather than passing silently. v1 scans the text types; the Office/PDF
  // binaries are not cracked open, and the message says so.
  let secretsOverridden = false;
  if (text !== null) {
    const findings = scanForSecrets(text);
    if (findings.length) {
      if (!allowSecrets) {
        throw new SecretInUploadError(
          'this file looks like it contains a secret, so it was not attached '
          + '(a file that is committed stays in the repository\'s history even if the task or output is later removed):\n'
          + `${describeSecretFindings(findings)}\n`
          + 'Rotate the credential if it is real — that is the real fix, since anyone who has pulled already has it. '
          + 'If this is a false positive, attach again with the override '
          + '(--allow-secrets on the command line, or the second confirm on the page). '
          + `Only text files (${Object.keys(TEXT_TYPES).map(t => `.${t}`).join(', ')}) are scanned; `
          + '.docx, .xlsx and .pdf are not opened, so check those yourself. '
          + 'To remove a file already committed, see docs/removing-a-mistaken-upload.md.',
          findings,
        );
      }
      secretsOverridden = true;
    }
  }

  return {
    name: safeFileName(name),
    type: FILE_OUTPUT_TYPES[ext],
    size,
    sha256: sha256Hex(bytes),
    ...(secretsOverridden ? { secretsOverridden: true } : {}),
  };
}

/**
 * The warning shown to a person before a file is committed: once it is in the
 * repository's history, removing the task or output later does not remove it.
 */
export const FILE_OUTPUT_WARNING =
  'This file goes into the project\'s git repository. Once it is committed it stays in the '
  + 'repository\'s history even if the task or the output is later removed. Do not attach anything secret.';
