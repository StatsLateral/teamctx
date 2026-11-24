/**
 * The output version diff (#253): lineage and a bounded text diff over the
 * append-only `basedOn` chain. The byte read for a file output is injected, so
 * these tests never touch storage.
 */
import { describe, it, expect } from 'vitest';
import { diffTexts, isDiffableText, diffsForOutputs, MAX_HUNK_LINES } from './output-diff.js';

describe('diffTexts', () => {
  it('reports unchanged when the two texts are identical', () => {
    const d = diffTexts('a\nb\nc', 'a\nb\nc');
    expect(d).toMatchObject({ unchanged: true, added: 0, removed: 0, truncated: false });
    expect(d.hunks).toEqual([]);
  });

  it('counts added lines and shows them with a + prefix', () => {
    const d = diffTexts('a\nb', 'a\nb\nc\nd');
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
    expect(d.hunks).toContain('+ c');
    expect(d.hunks).toContain('+ d');
  });

  it('counts removed lines and shows them with a - prefix', () => {
    const d = diffTexts('a\nb\nc', 'a');
    expect(d.removed).toBe(2);
    expect(d.added).toBe(0);
    expect(d.hunks).toContain('- b');
    expect(d.hunks).toContain('- c');
  });

  it('shows a mixed change with both counts', () => {
    const d = diffTexts('title\nold body\nfooter', 'title\nnew body\nfooter');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.hunks).toEqual(expect.arrayContaining(['- old body', '+ new body']));
  });

  it('separates non-adjacent changes with a middot marker', () => {
    const before = 'keep1\ndropme\nkeep2\nkeep3\nkeep4';
    const after = 'keep1\nkeep2\nkeep3\nkeep4\nadded';
    const d = diffTexts(before, after);
    expect(d.hunks).toContain('···');
    expect(d.hunks).toContain('- dropme');
    expect(d.hunks).toContain('+ added');
  });

  it('caps the preview and flags truncation, but still counts every line', () => {
    const after = Array.from({ length: MAX_HUNK_LINES + 20 }, (_, i) => `line ${i}`).join('\n');
    const d = diffTexts('', after);
    expect(d.added).toBe(MAX_HUNK_LINES + 20);
    expect(d.truncated).toBe(true);
    expect(d.hunks.length).toBeLessThanOrEqual(MAX_HUNK_LINES);
  });

  it('refuses to diff when a side is over the char limit, giving counts null', () => {
    const big = 'x'.repeat(60000);
    const d = diffTexts('small', big, { maxChars: 50000 });
    expect(d).toMatchObject({ tooLarge: true, added: null, removed: null, truncated: true });
  });

  it('returns null when a side is not a string', () => {
    expect(diffTexts('a', null)).toBeNull();
    expect(diffTexts(undefined, 'b')).toBeNull();
  });
});

describe('isDiffableText', () => {
  it('is true for a text output', () => {
    expect(isDiffableText({ kind: 'text', body: 'hi' })).toBe(true);
    expect(isDiffableText({ body: 'hi' })).toBe(true); // kind absent means text
  });
  it('is true for a readable-text file output, false for a binary one', () => {
    expect(isDiffableText({ kind: 'file', file: { name: 'notes.md' } })).toBe(true);
    expect(isDiffableText({ kind: 'file', file: { name: 'data.csv' } })).toBe(true);
    expect(isDiffableText({ kind: 'file', file: { name: 'banner.png' } })).toBe(false);
    expect(isDiffableText({ kind: 'file', file: { name: 'report.pdf' } })).toBe(false);
  });
  it('is false for a link output', () => {
    expect(isDiffableText({ kind: 'link', link: { url: 'https://x' } })).toBe(false);
  });
});

describe('diffsForOutputs', () => {
  const txt = (id, body, basedOn) => ({ id, kind: 'text', title: `v ${id}`, body, ...(basedOn ? { basedOn } : {}) });

  it('diffs a text output against the version it is based on', async () => {
    const outs = [txt('o1', 'one\ntwo'), txt('o2', 'one\ntwo\nthree', 'o1')];
    const map = await diffsForOutputs(outs);
    expect(map.o1).toBeUndefined(); // no basedOn
    expect(map.o2).toMatchObject({ diffable: true, added: 1, removed: 0, basedOn: 'o1', basedOnTitle: 'v o1' });
  });

  it('omits an output that is based on nothing', async () => {
    const map = await diffsForOutputs([txt('o1', 'hello')]);
    expect(map).toEqual({});
  });

  it('flags when the parent output is no longer listed', async () => {
    const map = await diffsForOutputs([txt('o2', 'hi', 'gone')]);
    expect(map.o2).toMatchObject({ diffable: false });
    expect(map.o2.reason).toMatch(/no longer listed/);
  });

  it('reads a readable-text file output through the injected reader', async () => {
    const outs = [
      { id: 'f1', kind: 'file', title: 'spec.md', file: { name: 'spec.md' } },
      { id: 'f2', kind: 'file', title: 'spec.md', file: { name: 'spec.md' }, basedOn: 'f1' },
    ];
    const text = { f1: '# Spec\nalpha', f2: '# Spec\nbeta' };
    const map = await diffsForOutputs(outs, async (o) => text[o.id]);
    expect(map.f2).toMatchObject({ diffable: true, added: 1, removed: 1 });
  });

  it('does not diff a binary file output, but names why', async () => {
    const outs = [
      { id: 'b1', kind: 'file', title: 'a.png', file: { name: 'a.png' } },
      { id: 'b2', kind: 'file', title: 'a.png', file: { name: 'a.png' }, basedOn: 'b1' },
    ];
    const map = await diffsForOutputs(outs, async () => 'should not be called');
    expect(map.b2).toMatchObject({ diffable: false, basedOn: 'b1' });
    expect(map.b2.reason).toMatch(/png/);
  });

  it('reports unknown — not a diff — when a text file cannot be read now', async () => {
    const outs = [
      { id: 'f1', kind: 'file', title: 'spec.md', file: { name: 'spec.md' } },
      { id: 'f2', kind: 'file', title: 'spec.md', file: { name: 'spec.md' }, basedOn: 'f1' },
    ];
    const map = await diffsForOutputs(outs, async () => null); // bytes unavailable
    expect(map.f2).toMatchObject({ diffable: false });
    expect(map.f2.reason).toMatch(/could not be read/);
  });
});
