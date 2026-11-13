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

/** The most text an excerpt carries. Enough to work from; never a whole file. */
export const MAX_EXTRACT_CHARS = 20000;

/** Types we can turn into text, by extension. pptx is deliberately absent. */
export const EXTRACTABLE_EXTENSIONS = ['txt', 'md', 'csv', 'json', 'docx', 'xlsx', 'pdf'];

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

async function fromXlsx(bytes, maxChars) {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  const parts = [];
  let total = 0;
  for (const ws of wb.worksheets) {
    parts.push(`# ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      // row.values is 1-indexed with a leading hole; drop it and flatten cells.
      const cells = (Array.isArray(row.values) ? row.values.slice(1) : [])
        .map((c) => (c == null ? '' : typeof c === 'object' ? (c.text ?? c.result ?? c.hyperlink ?? '') : c));
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

  try {
    let raw;
    if (['txt', 'md', 'csv', 'json'].includes(e)) raw = Buffer.from(bytes).toString('utf8');
    else if (e === 'docx') raw = await fromDocx(bytes);
    else if (e === 'xlsx') raw = await fromXlsx(bytes, maxChars);
    else if (e === 'pdf') raw = await fromPdf(bytes, maxChars);
    else if (e === 'pptx') return none('text extraction from .pptx is not supported yet; download the file to read it');
    else return none(`no text can be read from a .${e || '?'} file`);

    if (!raw || !raw.trim()) return none('no readable text was found in the file');
    const { text, truncated } = bound(raw, maxChars);
    return { text, truncated, note: null };
  } catch {
    // Never let a malformed or hostile file break the read around it.
    return none(`the .${e} file could not be read as text`);
  }
}
