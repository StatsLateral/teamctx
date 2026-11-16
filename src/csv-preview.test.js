/**
 * The CSV preview parser (#249): a bounded grid for the task drawer, handling
 * quotes and embedded delimiters, and honest about what it left out.
 */
import { describe, it, expect } from 'vitest';
import { parseCsvPreview } from './csv-preview.js';

describe('parseCsvPreview', () => {
  it('parses simple rows and columns', () => {
    const g = parseCsvPreview('a,b,c\n1,2,3\n4,5,6', 50, 20);
    expect(g.rows).toEqual([['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
    expect(g.totalRows).toBe(3);
    expect(g.rowsTruncated).toBe(false);
    expect(g.colsTruncated).toBe(false);
  });

  it('keeps commas and newlines inside quoted fields', () => {
    const g = parseCsvPreview('name,note\n"Doe, Jane","line one\nline two"', 50, 20);
    expect(g.rows[1]).toEqual(['Doe, Jane', 'line one\nline two']);
    expect(g.totalRows).toBe(2);
  });

  it('unescapes doubled quotes', () => {
    const g = parseCsvPreview('q\n"she said ""hi"""', 50, 20);
    expect(g.rows[1]).toEqual(['she said "hi"']);
  });

  it('treats CRLF as one row end', () => {
    const g = parseCsvPreview('a,b\r\n1,2\r\n', 50, 20);
    expect(g.rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(g.totalRows).toBe(2);
  });

  it('caps rows and reports the real total', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `r${i}`).join('\n');
    const g = parseCsvPreview(lines, 50, 20);
    expect(g.rows).toHaveLength(50);
    expect(g.totalRows).toBe(120);
    expect(g.rowsTruncated).toBe(true);
  });

  it('caps columns and flags it', () => {
    const wide = Array.from({ length: 30 }, (_, i) => `c${i}`).join(',');
    const g = parseCsvPreview(wide, 50, 20);
    expect(g.rows[0]).toHaveLength(20);
    expect(g.colsTruncated).toBe(true);
  });

  it('strips a leading UTF-8 BOM so the first header is clean', () => {
    const g = parseCsvPreview('﻿name,score\nAna,97', 50, 20);
    expect(g.rows[0]).toEqual(['name', 'score']);
  });

  it('flags column truncation only from the rows actually shown', () => {
    // 50 shown rows have 3 cols; a hidden row past the cap is wide. The note
    // must not claim columns were clipped, since no shown cell was.
    const shown = Array.from({ length: 50 }, () => 'a,b,c');
    const hiddenWide = Array.from({ length: 30 }, (_, i) => `c${i}`).join(',');
    const g = parseCsvPreview([...shown, hiddenWide].join('\n'), 50, 20);
    expect(g.rowsTruncated).toBe(true);
    expect(g.colsTruncated).toBe(false);
  });

  it('returns an empty grid for empty text', () => {
    expect(parseCsvPreview('', 50, 20).rows).toEqual([]);
    expect(parseCsvPreview(null, 50, 20).rows).toEqual([]);
  });
});
