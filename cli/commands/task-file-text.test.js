/**
 * get_task's text enrichment (#250): the file output a reader is handed in full
 * gains a bounded text excerpt; the earlier list stays lean.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOutputFile } from '../../src/storage.js';
import { withExtractedText } from './task.core.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'teamctx-filetext-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A file output whose bytes are written to the temp project, as saveFileOutput does.
function fileOutput(taskId, display, text, ext) {
  const onDisk = `o-1-${display}`;
  writeOutputFile(taskId, onDisk, new TextEncoder().encode(text), dir);
  return {
    id: 'o-1', kind: 'file', title: display,
    file: { name: display, type: 'text/plain', size: text.length, path: `outputs/${taskId}/files/${onDisk}` },
  };
}

describe('withExtractedText', () => {
  it('attaches a text excerpt to the output asked for by id', async () => {
    const out = fileOutput('task-a', 'notes.txt', 'The quarterly plan.', 'txt');
    const result = { id: 'task-a', output: out, outputs: { latest: out, earlier: [] } };
    const enriched = await withExtractedText(result, dir);
    expect(enriched.output.text).toBe('The quarterly plan.');
    expect(enriched.output.textTruncated).toBe(false);
    expect(enriched.outputs.latest.text).toBe('The quarterly plan.');
  });

  it('says why there is no text for a type it cannot read', async () => {
    const out = { id: 'o-2', kind: 'file', title: 'slides.pptx', file: { name: 'slides.pptx', path: 'outputs/task-b/files/o-2-slides.pptx' } };
    const enriched = await withExtractedText({ id: 'task-b', output: out }, dir);
    expect(enriched.output.text).toBeNull();
    expect(enriched.output.textNote).toMatch(/no text can be read from a .pptx/);
  });

  it('leaves a non-file output and the lean earlier list untouched', async () => {
    const latest = fileOutput('task-c', 'data.csv', 'a,b\n1,2', 'csv');
    const result = {
      id: 'task-c',
      output: { id: 'o-text', kind: 'text', body: 'just words' },
      outputs: { latest, earlier: [{ id: 'o-old', title: 'older' }] },
    };
    const enriched = await withExtractedText(result, dir);
    expect(enriched.output.text).toBeUndefined();   // a text-kind output is not a file; untouched
    expect(enriched.outputs.latest.text).toContain('a,b');
    expect(enriched.outputs.earlier).toEqual([{ id: 'o-old', title: 'older' }]);
  });

  it('is a no-op when nothing was produced', async () => {
    expect(await withExtractedText({ id: 'task-d', outputs: null }, dir)).toEqual({ id: 'task-d', outputs: null });
  });
});
