/**
 * Reading the text of a file output (#250): each supported type yields a bounded
 * excerpt, and an unsupported or broken file yields a reason, never a throw.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { extractOutputText, MAX_EXTRACT_CHARS, EXTRACTABLE_EXTENSIONS } from './file-text.js';

const enc = (s) => new TextEncoder().encode(s);
let xlsx; let docx; let pdf;

beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Name', 'Score', 'Deadline']);
  ws.addRow(['Ana', 97, new Date(Date.UTC(2027, 0, 5))]);
  ws.addRow(['Bo', 88, new Date(Date.UTC(2027, 5, 30))]);
  xlsx = new Uint8Array(await wb.xlsx.writeBuffer());

  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.folder('word').file('document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body><w:p><w:r><w:t>Hello from the docx fixture.</w:t></w:r></w:p></w:body></w:document>');
  docx = await zip.generateAsync({ type: 'uint8array' });

  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const stream = 'BT /F1 24 Tf 72 700 Td (Hello PDF text) Tj ET';
  objs.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  let s = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(s.length); s += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xrefAt = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { s += `${String(o).padStart(10, '0')} 00000 n \n`; });
  s += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF`;
  pdf = enc(s);
});

describe('extractOutputText', () => {
  it('decodes the plain-text types directly', async () => {
    expect((await extractOutputText(enc('Hello.\nLine two.'), 'txt')).text).toBe('Hello.\nLine two.');
    expect((await extractOutputText(enc('a,b\n1,2'), 'csv')).text).toContain('a,b');
    expect((await extractOutputText(enc('{"k":1}'), 'json')).text).toBe('{"k":1}');
  });

  it('reads a docx as text', async () => {
    const r = await extractOutputText(docx, 'docx');
    expect(r.text).toContain('Hello from the docx fixture.');
    expect(r.note).toBeNull();
  });

  it('reads an xlsx as rows, with the sheet name', async () => {
    const r = await extractOutputText(xlsx, 'xlsx');
    expect(r.text).toContain('Sheet1');
    expect(r.text).toContain('Name, Score');
    expect(r.text).toContain('Ana, 97');
  });

  it('renders date cells as text instead of dropping them', async () => {
    const r = await extractOutputText(xlsx, 'xlsx');
    // The Deadline column holds Date values; cell.text formats them, so the
    // year must survive rather than reading back as an empty cell.
    expect(r.text).toContain('2027');
  });

  it('reads a pdf as text', async () => {
    const r = await extractOutputText(pdf, 'pdf');
    expect(r.text).toContain('Hello PDF text');
  });

  it('caps the excerpt and marks it when the text is longer than the bound', async () => {
    const r = await extractOutputText(enc('x'.repeat(50000)), 'txt', { maxChars: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(1100);
    expect(r.text).toContain('truncated');
  });

  it('returns a reason, not a throw, for pptx', async () => {
    const r = await extractOutputText(enc('zzz'), 'pptx');
    expect(r.text).toBeNull();
    expect(r.note).toMatch(/pptx/);
  });

  it('returns a reason, not a throw, for a file that cannot be parsed', async () => {
    const r = await extractOutputText(enc('this is not a real docx'), 'docx');
    expect(r.text).toBeNull();
    expect(r.note).toMatch(/could not be read/);
  });

  it('returns a reason for an unknown type and for empty bytes', async () => {
    expect((await extractOutputText(enc('x'), 'exe')).note).toMatch(/no text/);
    expect((await extractOutputText(new Uint8Array(0), 'txt')).note).toMatch(/empty/);
  });

  it('lists pptx out of the extractable set', () => {
    expect(EXTRACTABLE_EXTENSIONS).not.toContain('pptx');
    expect(MAX_EXTRACT_CHARS).toBeGreaterThan(0);
  });
});
