/**
 * Validating a file before it is stored as a task output (#244): the size
 * limit, the type allow-list, the real-type check from leading bytes, and the
 * safe name. The checks refuse rather than trim.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  validateFileOutput, safeFileName, extensionOf, sha256Hex,
  FileOutputError, MAX_OUTPUT_FILE_BYTES, MAX_PAGE_UPLOAD_BYTES,
  FILE_OUTPUT_EXTENSIONS,
} from './file-output.js';
import { buildZip, buildDocx, wordDocument, para, run } from './formats/zip-fixture.js';

// Smallest buffers that each format's signature needs.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(13)]);
const gif = Buffer.from('GIF89a' + '\0'.repeat(10), 'binary');
const pdf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'binary');
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const docx = buildDocx(wordDocument(para(run('Hello'))));

describe('extensionOf', () => {
  it('reads the last extension, lower-cased, ignoring directories', () => {
    expect(extensionOf('Report.FINAL.PDF')).toBe('pdf');
    expect(extensionOf('a/b/c.png')).toBe('png');
    expect(extensionOf('C:\\docs\\sheet.XLSX')).toBe('xlsx');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('noext')).toBe('');
  });
});

describe('safeFileName', () => {
  it('drops directory parts and keeps a clean name with its extension', () => {
    expect(safeFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(safeFileName('my report (final).pdf')).toBe('my_report_final.pdf');
  });
  it('removes control characters and leading dots/dashes', () => {
    expect(safeFileName('\t-.hidden\x00.md')).toBe('hidden.md');
  });
  it('limits the length but keeps the extension', () => {
    const out = safeFileName('a'.repeat(300) + '.csv');
    expect(out.length).toBeLessThanOrEqual(84);
    expect(out.endsWith('.csv')).toBe(true);
  });
  it('falls back to a name when nothing usable is left', () => {
    expect(safeFileName('***.png')).toBe('file.png');
  });
  it('collapses consecutive dots so the name is never path-rejected later', () => {
    expect(safeFileName('report..v2.pdf')).toBe('report.v2.pdf');
    expect(safeFileName('a...b.csv')).toBe('a.b.csv');
    for (const n of ['report..v2.pdf', 'a...b.csv', '..hidden.md']) {
      expect(safeFileName(n)).not.toContain('..');
    }
  });
});

describe('sha256Hex', () => {
  it('matches a plain crypto hash of the same bytes', () => {
    expect(sha256Hex(png)).toBe(createHash('sha256').update(png).digest('hex'));
  });
});

describe('validateFileOutput — accepts allowed files', () => {
  it('accepts each binary type and reports its served type, size and hash', async () => {
    const cases = [['a.png', png, 'image/png'], ['a.jpg', jpg, 'image/jpeg'], ['a.gif', gif, 'image/gif'], ['a.webp', webp, 'image/webp'], ['a.pdf', pdf, 'application/pdf']];
    for (const [name, bytes, type] of cases) {
      const rec = await validateFileOutput(bytes, name);
      expect(rec).toMatchObject({ name, type, size: bytes.length });
      expect(rec.sha256).toBe(sha256Hex(bytes));
    }
  });

  it('accepts a .jpeg name for jpeg bytes (aliased to jpg type)', async () => {
    const rec = await validateFileOutput(jpg, 'photo.jpeg');
    expect(rec.type).toBe('image/jpeg');
  });

  it('accepts an Office file, which is a ZIP, under its claimed name', async () => {
    const rec = await validateFileOutput(docx, 'report.docx');
    expect(rec.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('accepts text files as valid UTF-8', async () => {
    const txt = Buffer.from('hello, world\n', 'utf8');
    expect((await validateFileOutput(txt, 'notes.txt')).type).toBe('text/plain');
    expect((await validateFileOutput(Buffer.from('{"a":1}', 'utf8'), 'd.json')).type).toBe('application/json');
    expect((await validateFileOutput(Buffer.from('a,b\n1,2\n', 'utf8'), 'r.csv')).type).toBe('text/csv');
  });
});

describe('validateFileOutput — refuses', () => {
  it('refuses an empty file', async () => {
    await expect(validateFileOutput(Buffer.alloc(0), 'a.png')).rejects.toThrow(/empty/);
  });

  it('refuses a file over the route limit, naming the limit', async () => {
    const big = Buffer.alloc(MAX_PAGE_UPLOAD_BYTES + 1);
    big.set(png.subarray(0, png.length));
    await expect(validateFileOutput(big, 'a.png', { maxBytes: MAX_PAGE_UPLOAD_BYTES }))
      .rejects.toThrow(/too large/);
  });

  it('mentions the higher CLI limit when a page-sized limit is exceeded', async () => {
    const big = Buffer.alloc(MAX_PAGE_UPLOAD_BYTES + 1);
    await validateFileOutput(big, 'a.png', { maxBytes: MAX_PAGE_UPLOAD_BYTES }).catch(e => {
      expect(e).toBeInstanceOf(FileOutputError);
      expect(e.message).toContain('command line');
    });
  });

  it('refuses a dangerous type that could run in a browser', async () => {
    await expect(validateFileOutput(Buffer.from('<svg/>', 'utf8'), 'x.svg')).rejects.toThrow(/not allowed/);
    await expect(validateFileOutput(Buffer.from('<html/>', 'utf8'), 'x.html')).rejects.toThrow(/not allowed/);
  });

  it('refuses a type that is not on the allow-list', async () => {
    await expect(validateFileOutput(Buffer.from('MZ', 'binary'), 'x.zip')).rejects.toThrow(/not an allowed type/);
  });

  it('refuses a file with no extension', async () => {
    await expect(validateFileOutput(png, 'noextension')).rejects.toThrow(/no extension/);
  });

  it('refuses bytes whose real type does not match the name', async () => {
    await expect(validateFileOutput(pdf, 'secret.png')).rejects.toThrow(/does not match/);
  });

  it('refuses a binary file renamed to a text extension', async () => {
    await expect(validateFileOutput(png, 'notes.txt')).rejects.toThrow(/does not look like/);
  });

  it('refuses non-bytes', async () => {
    await expect(validateFileOutput('a string', 'a.txt')).rejects.toThrow(FileOutputError);
  });
});

describe('limits and allow-list are as the spec says', () => {
  it('10 MB from the CLI, 4 MB from the page', () => {
    expect(MAX_OUTPUT_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_PAGE_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
  });
  it('allows exactly the listed types, and no svg/html/scripts', () => {
    expect(new Set(FILE_OUTPUT_EXTENSIONS)).toEqual(new Set(
      ['png', 'jpg', 'gif', 'webp', 'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md', 'json'],
    ));
    for (const bad of ['svg', 'html', 'js', 'exe']) expect(FILE_OUTPUT_EXTENSIONS).not.toContain(bad);
  });
});
