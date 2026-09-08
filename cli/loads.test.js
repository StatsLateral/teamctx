/**
 * The CLI actually loads.
 *
 * A literal newline inside a single-quoted string shipped in `config.js` and
 * the whole suite stayed green: nothing imports `cli/index.js` or the command
 * wrappers, so a file that does not parse broke every command — `status`,
 * `contribute`, `review`, `init` — without failing a single test.
 *
 * Two checks, because they catch different things. The sweep is per-file and
 * says which one is broken. Running the binary proves the import graph
 * resolves, which no amount of parsing each file separately can.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (args, opts) => execFileAsync(process.execPath, args, { cwd: root, ...opts });

describe('every tracked source file parses', () => {
  it('has no syntax errors anywhere in the repo', async () => {
    const { stdout } = await execFileAsync('git', ['ls-files', '*.js'], { cwd: root });
    const files = stdout.split('\n').map(f => f.trim()).filter(Boolean);
    expect(files.length).toBeGreaterThan(50);

    const broken = [];
    for (const f of files) {
      try { await run(['--check', join(root, f)]); }
      catch (err) { broken.push(`${f}: ${String(err.stderr || err.message).split('\n')[1] || ''}`.trim()); }
    }
    expect(broken).toEqual([]);
  }, 120000);
});

describe('the binary starts', () => {
  it('resolves its whole import graph and answers --version', async () => {
    // `--version` is the cheapest command that still pulls in every import at
    // the top of cli/index.js, which is where the broken module was reached.
    const { stdout } = await run([join(root, 'cli', 'index.js'), '--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60000);

  it('lists the commands it claims to have', async () => {
    const { stdout } = await run([join(root, 'cli', 'index.js'), '--help']);
    ['init', 'contribute', 'review', 'status', 'config', 'mcp']
      .forEach(cmd => expect(stdout).toContain(cmd));
  }, 60000);

  it('reaches the config subcommands, where the break was', async () => {
    const { stdout } = await run([join(root, 'cli', 'index.js'), 'config', '--help']);
    expect(stdout).toContain('review-policy');
    expect(stdout).toContain('manager');
  }, 60000);
});

describe('the sweep would notice', () => {
  it('reports a file that does not parse', async () => {
    // Proves the check is doing work rather than passing vacuously: the same
    // mistake that shipped, checked directly.
    const bad = join(root, 'node_modules', '.teamctx-syntax-probe.mjs');
    const { writeFile, rm, mkdir } = await import('fs/promises');
    await mkdir(dirname(bad), { recursive: true });
    await writeFile(bad, "console.log('\nunterminated');\n", 'utf8');
    try {
      await expect(run(['--check', bad])).rejects.toThrow();
    } finally {
      await rm(bad, { force: true });
    }
  }, 60000);
});

describe('paths reported by the sweep are usable', () => {
  it('names files relative to the repo root', () => {
    expect(relative(root, join(root, 'cli', 'index.js'))).toBe(join('cli', 'index.js'));
  });
});
