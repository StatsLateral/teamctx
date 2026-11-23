/**
 * Read the text of a file output so an assistant can work from it (#250).
 *
 * A file output stores only the bytes and some metadata, so an assistant picking
 * up a task sees a spreadsheet or a document as a name and a size, never its
 * content. This extracts a **bounded** text excerpt from the types worth it —
 * the plain-text ones, and docx / xlsx / pdf — so the assistant can read enough
 * to work from without being handed the whole file.
 *
 * Two rules hold the cost and the risk down:
 *   - **Bounded.** Never the whole file: the excerpt is capped and marked when it
 *     was cut, so a large upload cannot flood a model's context.
 *   - **Honest, never fatal.** A type with no extractor (pptx), or a file that
 *     cannot be parsed, returns no text and a short reason — never a thrown
 *     error that would take down the read around it. Extraction runs on
 *     untrusted bytes through maintained libraries only; nothing is executed.
 *
 * Extraction is done on read, not at upload: the repository keeps only the
 * original file, and the cost is paid when an assistant actually asks.
 */

import { zipDeclaredFootprint } from './formats/docx.js';

/** The most text an excerpt carries. Enough to work from; never a whole file. */
export const MAX_EXTRACT_CHARS = 20000;

/** Types we can turn into text, by extension. pptx is deliberately absent. */
export const EXTRACTABLE_EXTENSIONS = ['txt', 'md', 'csv', 'json', 'docx', 'xlsx', 'pdf'];

// A .docx / .xlsx is a ZIP, and the 10 MB upload cap is on its *compressed* size.
// Before a parser unpacks one into memory, we read what its central directory
// declares and refuse a file that would expand past these bounds — a small file
// that claims gigabytes of contents or a flood of entries is a decompression
// bomb, not a document. 50 MB covers a genuinely large spreadsheet or an
// image-heavy document with room to spare.
const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4096;

// A hostile or malformed file must not be able to hold the read open: a slow
// parse is abandoned after this, and the read returns a reason like any other
// unreadable file. The dangling parse settles on its own and is discarded.
const EXTRACT_TIMEOUT_MS = 10000;
const TIMEOUT_MARK = '__extract_timeout__';

/**
 * Why a type yields no text, in one line — the single source of that wording, so
 * the caller that skips unextractable types without reading them says the same
 * thing this does when it meets one (the pptx download hint above all).
 */
export function noTextReason(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'pptx') return 'text extraction from .pptx is not supported yet; download the file to read it';
  return `no text can be read from a .${e || '?'} file`;
}

/**
 * A reason to refuse a ZIP-based file (docx/xlsx) before unpacking it, or null.
 *
 * The declared sizes are read from the central directory without inflating
 * anything. A file whose bytes are not a readable ZIP returns null, so the real
 * parser still runs and reports its own failure — this guards only against a
 * directory that declares more than we will ever keep.
 */
function zipFootprintProblem(bytes) {
  let footprint;
  try { footprint = zipDeclaredFootprint(Buffer.from(bytes)); }
  catch { return null; }
  if (footprint.uncompressedTotal > MAX_ZIP_UNCOMPRESSED_BYTES) {
    return `the file declares more than ${Math.round(MAX_ZIP_UNCOMPRESSED_BYTES / (1024 * 1024))} MB of contents and was not read`;
  }
  if (footprint.entryCount > MAX_ZIP_ENTRIES) {
    return `the file holds more than ${MAX_ZIP_ENTRIES} entries and was not read`;
  }
  return null;
}

/** Run `promise`, but give up after `ms` so a slow parse cannot hold the read. */
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_MARK)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Cap `text` to `maxChars`, marking it when it had to be cut. */
function bound(text, maxChars) {
  const clean = String(text ?? '').replace(/\u0000/g, '').trimEnd();
  if (clean.length <= maxChars) return { text: clean, truncated: false };
  return {
    text: `${clean.slice(0, maxChars).trimEnd()}\n\n[… excerpt truncated at ${maxChars} characters …]`,
    truncated: true,
  };
}

async function fromDocx(bytes) {
  const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}

// The displayed text of one cell. `cell.text` is ExcelJS's own formatted
// rendering, so a date, a rich-text run, a formula's result and a hyperlink all
// come out as the string a person would see — where reading `cell.value` would
// hand back a Date or a {richText} object and lose the content.
function cellText(cell) {
  const t = cell?.text;
  return t == null ? '' : String(t).replace(/\s+/g, ' ').trim();
}

async function fromXlsx(bytes, maxChars) {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  const parts = [];
  let total = 0;
  for (const ws of wb.worksheets) {
    parts.push(`# ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell)));
      const line = cells.join(', ');
      parts.push(line);
      total += line.length;
    });
    // Stop reading sheets once we already hold more than the cap would keep.
    if (total > maxChars) { parts.push('[… more sheets not read …]'); break; }
  }
  return parts.join('\n');
}

async function fromPdf(bytes, maxChars) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = [];
  let total = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
    pages.push(text);
    total += text.length;
    if (total > maxChars) { pages.push('[… more pages not read …]'); break; }
  }
  try { await doc.destroy(); } catch { /* best effort */ }
  return pages.join('\n\n');
}

/**
 * A bounded text excerpt of a file output's bytes, or a reason there is none.
 *
 * @param {Uint8Array} bytes  the file's bytes
 * @param {string}     ext    its extension, lower-cased, no dot (`docx`, `pdf`, …)
 * @param {object}     [opts]
 * @param {number}     [opts.maxChars=MAX_EXTRACT_CHARS]
 * @returns {Promise<{ text: string|null, truncated: boolean, note: string|null }>}
 */
export async function extractOutputText(bytes, ext, { maxChars = MAX_EXTRACT_CHARS } = {}) {
  const none = (note) => ({ text: null, truncated: false, note });
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return none('the file is empty or could not be read');
  const e = String(ext || '').toLowerCase();

  // docx and xlsx are ZIPs: refuse a decompression bomb before any parser
  // unpacks it, reading only what the archive declares.
  if (e === 'docx' || e === 'xlsx') {
    const over = zipFootprintProblem(bytes);
    if (over) return none(over);
  }

  try {
    let raw;
    if (['txt', 'md', 'csv', 'json'].includes(e)) raw = Buffer.from(bytes).toString('utf8');
    else if (e === 'docx') raw = await withTimeout(fromDocx(bytes), EXTRACT_TIMEOUT_MS);
    else if (e === 'xlsx') raw = await withTimeout(fromXlsx(bytes, maxChars), EXTRACT_TIMEOUT_MS);
    else if (e === 'pdf') raw = await withTimeout(fromPdf(bytes, maxChars), EXTRACT_TIMEOUT_MS);
    else if (e === 'pptx') return none(noTextReason('pptx'));
    else return none(noTextReason(e));

    if (!raw || !raw.trim()) return none('no readable text was found in the file');
    const { text, truncated } = bound(raw, maxChars);
    return { text, truncated, note: null };
  } catch (err) {
    // Never let a malformed, hostile or slow file break the read around it.
    if (err && err.message === TIMEOUT_MARK) return none(`reading the .${e} file timed out`);
    return none(`the .${e} file could not be read as text`);
  }
}
