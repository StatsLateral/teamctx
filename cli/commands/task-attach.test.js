/**
 * The `teamctx task attach` command wrapper (#246): it reads the file from
 * disk, hands the bytes to saveFileOutput, and turns a refusal or a missing
 * file into a clean message rather than a stack trace. The storing itself is
 * covered by task-file-outputs.test.js and file-output.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./task.core.js', async (importActual) => ({
  ...(await importActual()),
  saveFileOutput: vi.fn(),
}));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));

import { taskAttachCommand } from './task.js';
import { saveFileOutput } from './task.core.js';
import { FileOutputError, FILE_OUTPUT_WARNING } from '../../src/file-output.js';

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
