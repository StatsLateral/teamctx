/**
 * The `teamctx task attach` command wrapper (#246): it reads the file from
 * disk, hands the bytes to saveFileOutput, and turns a refusal or a missing
 * file into a clean message rather than a stack trace. The storing itself is
 * covered by task-file-outputs.test.js and file-output.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./task.core.js', async (importActual) => ({
  ...(await importActual()),
  saveFileOutput: vi.fn(),
  saveFileOutputs: vi.fn(),
}));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));

import { taskAttachCommand } from './task.js';
import { saveFileOutput, saveFileOutputs } from './task.core.js';
import { FileOutputError, FILE_OUTPUT_WARNING, MAX_OUTPUT_FILE_BYTES } from '../../src/file-output.js';

let dir, file, log, err, exit;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-attach-'));
  file = join(dir, 'banner.png');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const out = () => log.mock.calls.map(c => c.join(' ')).join('\n');

describe('taskAttachCommand', () => {
  it('reads the file and passes its bytes and name to saveFileOutput', async () => {
    saveFileOutput.mockResolvedValue({
      output: { id: 'o-1', file: { name: 'banner.png', type: 'image/png', size: 4 } },
      task: { key: '1.1', id: 't-x' }, committed: false,
    });
    await taskAttachCommand('1.1', file, { note: 'first cut' });
    const arg = saveFileOutput.mock.calls[0][0];
    expect(Buffer.isBuffer(arg.bytes)).toBe(true);
    expect(arg).toMatchObject({ id: '1.1', name: 'banner.png', notes: 'first cut', source: 'cli' });
    expect(out()).toContain('Attached banner.png to task 1.1');
    expect(out()).toContain('image/png');
    expect(out()).toContain(FILE_OUTPUT_WARNING);
  });

  it('passes the --allow-secrets override through to saveFileOutput (#252)', async () => {
    saveFileOutput.mockResolvedValue({
      output: { id: 'o-2', file: { name: 'banner.png', type: 'image/png', size: 4 } },
      task: { key: '1.1', id: 't-x' }, committed: false,
    });
    await taskAttachCommand('1.1', file, { allowSecrets: true });
    expect(saveFileOutput.mock.calls[0][0]).toMatchObject({ allowSecrets: true });
  });

  it('defaults the override off when the flag is absent (#252)', async () => {
    saveFileOutput.mockResolvedValue({
      output: { id: 'o-3', file: { name: 'banner.png', type: 'image/png', size: 4 } },
      task: { key: '1.1', id: 't-x' }, committed: false,
    });
    await taskAttachCommand('1.1', file, {});
    expect(saveFileOutput.mock.calls[0][0]).toMatchObject({ allowSecrets: false });
  });

  it('prints a clean error, not a stack trace, when the file is refused', async () => {
    saveFileOutput.mockRejectedValue(new FileOutputError('the file is too large to attach'));
    await expect(taskAttachCommand('1.1', file, {})).rejects.toThrow('exit');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('fails before saving when the file is not on disk', async () => {
    await expect(taskAttachCommand('1.1', join(dir, 'nope.png'), {})).rejects.toThrow('exit');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('file not found'));
    expect(saveFileOutput).not.toHaveBeenCalled();
  });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('taskAttachCommand — many files', () => {
  let bdir;
  beforeEach(() => { bdir = join(dir, 'batch'); mkdirSync(bdir); });

  function batchReturns({ skipped = [] } = {}) {
    saveFileOutputs.mockImplementation(async ({ files }) => ({
      outputs: files.map((f, i) => ({ id: `o-${i}`, file: { name: f.name, type: 'image/png', size: f.bytes.length } })),
      skipped,
      task: { key: '1.1', id: 't-x' },
      committed: false,
    }));
  }

  it('attaches a folder in one batch, passing only attachable files, quietly ignoring the rest', async () => {
    writeFileSync(join(bdir, 'a.png'), PNG);
    writeFileSync(join(bdir, 'b.png'), PNG);
    writeFileSync(join(bdir, 'notes.txt'), 'text is attachable too');
    writeFileSync(join(bdir, 'skip.exe'), Buffer.from([1, 2, 3])); // not an allowed type
    batchReturns();

    await taskAttachCommand('1.1', bdir, {});
    const names = saveFileOutputs.mock.calls[0][0].files.map(f => f.name).sort();
    expect(names).toEqual(['a.png', 'b.png', 'notes.txt']);
    expect(saveFileOutputs.mock.calls[0][0]).toMatchObject({ id: '1.1', source: 'cli' });
    expect(out()).toContain('Attached 3 files to task 1.1');
    expect(out()).toContain('ignored 1 non-attachable file');
    expect(out()).toContain(FILE_OUTPUT_WARNING);
    expect(saveFileOutput).not.toHaveBeenCalled();
  });

  it('passes --allow-secrets through to the batch, so the scan is overridable per file (#252)', async () => {
    writeFileSync(join(bdir, 'a.png'), PNG);
    batchReturns();
    await taskAttachCommand('1.1', bdir, { allowSecrets: true });
    expect(saveFileOutputs.mock.calls[0][0]).toMatchObject({ allowSecrets: true });

    saveFileOutputs.mockClear();
    batchReturns();
    await taskAttachCommand('1.1', bdir, {});
    expect(saveFileOutputs.mock.calls[0][0]).toMatchObject({ allowSecrets: false });
  });

  it('does not descend into sub-folders unless --recursive', async () => {
    writeFileSync(join(bdir, 'top.png'), PNG);
    const sub = join(bdir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'deep.png'), PNG);
    batchReturns();

    await taskAttachCommand('1.1', bdir, {});
    expect(saveFileOutputs.mock.calls[0][0].files.map(f => f.name)).toEqual(['top.png']);

    saveFileOutputs.mockClear();
    batchReturns();
    await taskAttachCommand('1.1', bdir, { recursive: true });
    expect(saveFileOutputs.mock.calls[0][0].files.map(f => f.name).sort()).toEqual(['deep.png', 'top.png']);
  });

  it('expands a glob to its matches', async () => {
    writeFileSync(join(bdir, 'one.png'), PNG);
    writeFileSync(join(bdir, 'two.png'), PNG);
    writeFileSync(join(bdir, 'three.pdf'), PNG);
    batchReturns();

    await taskAttachCommand('1.1', join(bdir, '*.png'), {});
    expect(saveFileOutputs.mock.calls[0][0].files.map(f => f.name).sort()).toEqual(['one.png', 'two.png']);
  });

  it('skips a single file over the per-file limit without reading it, and reports it', async () => {
    writeFileSync(join(bdir, 'ok.png'), PNG);
    writeFileSync(join(bdir, 'huge.png'), Buffer.alloc(MAX_OUTPUT_FILE_BYTES + 1, 7));
    batchReturns();

    await taskAttachCommand('1.1', bdir, {});
    expect(saveFileOutputs.mock.calls[0][0].files.map(f => f.name)).toEqual(['ok.png']);
    expect(out()).toContain('skipped huge.png');
    expect(out()).toContain('too large');
  });

  it('surfaces per-file refusals from the store alongside the ones it attached', async () => {
    writeFileSync(join(bdir, 'good.png'), PNG);
    writeFileSync(join(bdir, 'liar.png'), PNG);
    batchReturns({ skipped: [{ name: 'liar.png', reason: 'the file does not match its .png name' }] });

    await taskAttachCommand('1.1', bdir, {});
    expect(out()).toContain('skipped liar.png — the file does not match its .png name');
  });

  it('refuses a run with too many files, suggesting a cloud link, without attaching any', async () => {
    for (let i = 0; i < 51; i++) writeFileSync(join(bdir, `f${i}.png`), PNG);
    await expect(taskAttachCommand('1.1', bdir, {})).rejects.toThrow('exit');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/at most 50.*cloud/s));
    expect(saveFileOutputs).not.toHaveBeenCalled();
  });

  it('refuses a run over the total-size cap, without attaching any', async () => {
    // Eleven files at the 10 MB per-file limit is 110 MB — over the 100 MB run cap.
    for (let i = 0; i < 11; i++) writeFileSync(join(bdir, `big${i}.png`), Buffer.alloc(MAX_OUTPUT_FILE_BYTES, 1));
    await expect(taskAttachCommand('1.1', bdir, {})).rejects.toThrow('exit');
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/100 MB|most is/));
    expect(saveFileOutputs).not.toHaveBeenCalled();
  });
});
