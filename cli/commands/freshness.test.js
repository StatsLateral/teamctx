/**
 * How fresh the context is (#183) on the command line: `teamctx status` has a
 * line for it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeConfig, writeApproved, writeQueueItem } from '../../src/storage.js';
import { emptyProject } from '../../src/model.js';
import { makeConfig } from '../../src/test-fixtures/model.js';

const execFileAsync = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const day = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

let root;
let ctx;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'teamctx-fresh-cli-'));
  ctx = join(root, '.teamctx');
  mkdirSync(ctx, { recursive: true });
  writeConfig(makeConfig({ project: 'Shop', model: 'm' }), ctx);
  writeFileSync(join(ctx, 'project.json'), JSON.stringify(emptyProject('Shop')));
  writeFileSync(join(ctx, 'contributions.jsonl'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = args => execFileAsync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, TEAMCTX_NAME: 'Tester' } });

describe('teamctx status', () => {
  it('says when the context was last approved and what is waiting', async () => {
    writeApproved({ id: 'c-1', approvedAt: day(12) }, ctx);
    writeQueueItem({ id: 'q-1', createdAt: day(0) }, ctx);
    const { stdout } = await run(['status']);
    expect(stdout).toMatch(/Freshness: +Context last approved 12 days ago; 1 item waiting for review\./);
  }, 20000);

  it('says not recorded, and nothing waiting, on a project with neither', async () => {
    const { stdout } = await run(['status']);
    expect(stdout).toMatch(/Freshness: +Context last approved: not recorded; nothing waiting for review\./);
  }, 20000);
});
