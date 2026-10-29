/**
 * The command line calls storage with no folder, meaning the project found from
 * the working directory. Taking the counters lock must work that way too, or
 * every command that adds a task or approves anything fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withCounters } from './storage.js';

let projectDir;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'teamctx-counters-'));
  mkdirSync(join(projectDir, '.teamctx'));
  writeFileSync(join(projectDir, '.teamctx', 'config.json'), JSON.stringify({ project: 'Ledger' }));
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('the counters lock with no folder given', () => {
  it('uses the project found from the working directory, and keeps the lock out of git', () => {
    expect(withCounters(undefined, config => config.project)).toBe('Ledger');
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toContain('.teamctx/.local/');
  });
});
