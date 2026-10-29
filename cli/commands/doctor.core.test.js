import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeConfig } from '../../src/storage.js';
import { makeConfig } from '../../src/test-fixtures/model.js';
import { runDoctor, meetsEngines, minimumNode } from './doctor.core.js';

let root;
const project = (over = {}) => {
  mkdirSync(join(root, '.teamctx'), { recursive: true });
  writeConfig(makeConfig({ autoPush: true, ...over }), join(root, '.teamctx'));
};
const repo = ({ remote = 'origin\n', upstream = true } = {}) => vi.fn(async (args) => {
  if (args[0] === 'remote') return remote;
  if (args.includes('@{u}') && !upstream) throw new Error('fatal: no upstream configured');
  return '.git\n';
});
const notRepo = vi.fn(async () => { throw new Error('fatal: not a git repository'); });
const accepted = vi.fn(async () => ({ ok: true, status: 200 }));
const KEY = { ANTHROPIC_API_KEY: 'sk-ant-test' };
const doctor = (over = {}) => runDoctor({ cwd: root, env: KEY, git: repo(), fetchImpl: accepted, nodeVersion: 'v20.11.0', ...over });
const line = (checks, name) => checks.find(c => c.name === name);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'teamctx-doctor-')); accepted.mockClear(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('teamctx doctor on a project that is set up', () => {
  it('passes every check', async () => {
    project();
    const checks = await doctor();
    expect(checks.map(c => [c.name, c.status])).toEqual([
      ['Git repository', 'ok'], ['teamctx project', 'ok'], ['Node version', 'ok'],
      ['AI key present', 'ok'], ['AI key accepted', 'ok'], ['Manager gate', 'ok'], ['Remote for auto-push', 'ok'],
    ]);
  });
});

describe('each check, failing, says how to fix it', () => {
  it('outside a git repository', async () => {
    project();
    expect(line(await doctor({ git: notRepo }), 'Git repository')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/git init/) });
  });

  it('with no teamctx project, and skips what needs one', async () => {
    const checks = await doctor();
    expect(line(checks, 'teamctx project')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/teamctx init/) });
    for (const name of ['AI key present', 'AI key accepted', 'Manager gate', 'Remote for auto-push']) expect(line(checks, name).status, name).toBe('skip');
    expect(accepted).not.toHaveBeenCalled();
  });

  it('on a Node older than package.json allows, and does not blame the network too', async () => {
    project();
    const checks = await doctor({ nodeVersion: 'v16.20.0' });
    expect(line(checks, 'Node version')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/Install Node 18 or later/) });
    expect(line(checks, 'AI key accepted')).toMatchObject({ status: 'skip', fix: 'needs a supported Node' });
    expect(accepted).not.toHaveBeenCalled();
  });

  it('with a provider it does not know, even one named like an object property', async () => {
    project({ provider: 'constructor' });
    expect(line(await doctor(), 'AI key present')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/^Unknown provider "constructor".*anthropic, openai, gemini\.$/) });
  });

  it('with no key for the configured provider, in the words the CLI already uses', async () => {
    project({ provider: 'openai' });
    const checks = await doctor();
    expect(line(checks, 'AI key present')).toMatchObject({ status: 'fail', fix: 'OPENAI_API_KEY not set. Add it to your .env file or shell environment.' });
    expect(line(checks, 'AI key accepted').status).toBe('skip');
  });

  it('with a key the provider rejects', async () => {
    project();
    const rejected = vi.fn(async () => ({ ok: false, status: 401 }));
    expect(line(await doctor({ fetchImpl: rejected }), 'AI key accepted'))
      .toMatchObject({ status: 'fail', fix: 'anthropic rejected the key (401). Replace ANTHROPIC_API_KEY with a working key, in .env.local or in your shell (a value set in the shell wins).' });
  });

  it('when the provider cannot be reached', async () => {
    project();
    const down = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    expect(line(await doctor({ fetchImpl: down }), 'AI key accepted'))
      .toMatchObject({ status: 'fail', fix: expect.stringMatching(/Could not reach anthropic .* Check the network, then run `teamctx doctor` again\.$/) });
  });

  it('with a manager gate nobody can match', async () => {
    project({ managerKey: undefined, managerKeys: ['name:Old Name'] });
    expect(line(await doctor(), 'Manager gate')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/teamctx config manager --repair/) });
  });

  it('with auto-push on and a branch that tracks no remote branch', async () => {
    project();
    expect(line(await doctor({ git: repo({ upstream: false }) }), 'Remote for auto-push'))
      .toMatchObject({ status: 'fail', fix: expect.stringMatching(/git push -u origin HEAD/) });
  });

  it('with auto-push on and no remote', async () => {
    project();
    expect(line(await doctor({ git: repo({ remote: '' }) }), 'Remote for auto-push')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/git remote add origin/) });
  });
});

describe('what doctor skips', () => {
  it('the key check with --offline, and calls no network', async () => {
    project();
    const checks = await doctor({ offline: true });
    expect(line(checks, 'AI key accepted')).toMatchObject({ status: 'skip', fix: 'skipped with --offline' });
    expect(accepted).not.toHaveBeenCalled();
  });

  it('the remote check when auto-push is off', async () => {
    project({ autoPush: false });
    expect(line(await doctor({ git: repo({ remote: '' }) }), 'Remote for auto-push').status).toBe('skip');
  });
});

describe('the Node range', () => {
  it('reads >= ranges', () => {
    expect(meetsEngines('v18.0.0', '>=18')).toBe(true);
    expect(meetsEngines('v17.9.1', '>=18')).toBe(false);
    expect(meetsEngines('v18.2.0', '>=18.10')).toBe(false);
    expect(meetsEngines('v22.1.0', '>=18.10')).toBe(true);
  });

  it('names the lowest version allowed in the fix', () => {
    expect(minimumNode('>=20')).toBe('20');
    expect(minimumNode('>=18.10')).toBe('18.10');
  });
});
