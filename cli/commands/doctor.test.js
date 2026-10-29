/**
 * `teamctx doctor` as a person runs it: listed in --help, one line per check,
 * "all good" and exit 0 when nothing failed, exit 1 when something did.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { formatDoctor } from './doctor.js';

const execFileAsync = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

describe('what doctor prints', () => {
  it('says all good when nothing failed', () => {
    const r = formatDoctor([{ name: 'Git repository', status: 'ok' }, { name: 'AI key accepted', status: 'skip', fix: 'skipped with --offline' }]);
    expect(r.failed).toBe(0);
    expect(r.text).toBe('  ✓ Git repository\n  – AI key accepted — skipped with --offline\n\nall good');
  });

  it('puts the fix on the line of each failure and counts them', () => {
    const r = formatDoctor([{ name: 'teamctx project', status: 'fail', fix: 'No teamctx project here. Run `teamctx init`.' }, { name: 'Node version', status: 'ok' }]);
    expect(r.failed).toBe(1);
    expect(r.text).toContain('  ✗ teamctx project — No teamctx project here. Run `teamctx init`.');
    expect(r.text).toMatch(/1 problem to fix\.$/);
  });
});

describe('teamctx doctor from the command line', () => {
  it('is listed in --help', async () => {
    const { stdout } = await execFileAsync(process.execPath, [cli, '--help']);
    expect(stdout.replace(/\s+/g, ' ')).toMatch(/doctor \[options\] Check the setup and say how to fix each problem/);
  });

  it('exits 1 outside a project and says to run teamctx init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamctx-doctor-cli-'));
    try {
      const err = await execFileAsync(process.execPath, [cli, 'doctor', '--offline'], { cwd: dir }).then(() => null, e => e);
      expect(err?.code).toBe(1);
      expect(err.stdout).toMatch(/✗ teamctx project — No teamctx project here\. Run `teamctx init`\./);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
});
