import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeConfig, readConfig } from './storage.js';
import { migrateIfNeeded } from './migrate.js';

/**
 * The whole migration chain, against a real filesystem.
 *
 * A project old enough to have `shared.json` now travels two steps in one call:
 * shared → `main` → the project tree. These assert where it ends up, not where
 * it passes through, because the intermediate `main` no longer survives.
 */

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamctx-migrate-'));
  mkdirSync(join(dir, 'context', 'roles'), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedPreMigrationProject({ roles = [] } = {}) {
  writeConfig({ project: 'Demo', me: 'alice', model: 'claude-sonnet-4-6', autoPush: false, roles }, dir);
  writeFileSync(join(dir, 'shared.json'), JSON.stringify({ id: 'main', name: 'Demo', whys: [{ id: 'w1', text: 'launch' }] }, null, 2));
  writeFileSync(join(dir, 'context', 'shared.md'), '# Demo\n\nHello.\n');
}

describe('migrateIfNeeded', () => {
  it('returns false when no config.json exists', () => {
    expect(migrateIfNeeded(dir)).toBe(false);
  });

  it('returns false when a project has already been through both steps', () => {
    writeConfig({ project: 'X', workstreamsMigrated: true, projectLayerMigrated: true, roles: [] }, dir);
    expect(migrateIfNeeded(dir)).toBe(false);
  });

  it('takes a project already on workstreams through the remaining step', () => {
    // The common case now: migrated to workstreams long ago, `main` still there.
    writeConfig({
      project: 'X', workstreamsMigrated: true, roles: [],
      workstreams: [{ id: 'main', name: 'X' }], activeWorkstream: 'main',
    }, dir);
    mkdirSync(join(dir, 'workstreams'), { recursive: true });
    writeFileSync(join(dir, 'workstreams', 'main.json'), JSON.stringify({ id: 'main', name: 'X', whys: [{ id: 'w9', text: 'carried' }] }));

    expect(migrateIfNeeded(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8')).whys[0].text).toBe('carried');
    expect(existsSync(join(dir, 'workstreams', 'main.json'))).toBe(false);
  });

  it('carries shared.json all the way to the project tree', () => {
    seedPreMigrationProject();
    expect(migrateIfNeeded(dir)).toBe(true);

    expect(existsSync(join(dir, 'shared.json'))).toBe(false);
    expect(existsSync(join(dir, 'workstreams', 'main.json'))).toBe(false);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
    expect(project.whys[0].text).toBe('launch');
    expect(project.name).toBe('Demo');
    // Not a workstream, so it carries no id to be passed around as one.
    expect(project.id).toBeUndefined();
  });

  it('carries the compiled markdown all the way too', () => {
    seedPreMigrationProject();
    migrateIfNeeded(dir);

    expect(existsSync(join(dir, 'context', 'shared.md'))).toBe(false);
    expect(existsSync(join(dir, 'context', 'workstreams', 'main.md'))).toBe(false);
    expect(readFileSync(join(dir, 'context', 'project.md'), 'utf-8')).toBe('# Demo\n\nHello.\n');
  });

  it('leaves no workstreams and no active one', () => {
    seedPreMigrationProject();
    migrateIfNeeded(dir);

    const config = readConfig(dir);
    expect(config.workstreams).toEqual([]);
    expect(config.activeWorkstream).toBe(null);
    expect(config.workstreamsMigrated).toBe(true);
    expect(config.projectLayerMigrated).toBe(true);
  });

  it('binds existing roles to project level', () => {
    seedPreMigrationProject({ roles: [{ slug: 'eng', name: 'Eng' }, { slug: 'ops', name: 'Ops' }] });
    migrateIfNeeded(dir);

    expect(readConfig(dir).roles.every(r => r.workstream === null)).toBe(true);
  });

  it('is idempotent: a second run changes nothing', () => {
    seedPreMigrationProject();
    migrateIfNeeded(dir);
    const after = readFileSync(join(dir, 'project.json'), 'utf-8');
    const config = JSON.stringify(readConfig(dir));

    expect(migrateIfNeeded(dir)).toBe(false);
    expect(readFileSync(join(dir, 'project.json'), 'utf-8')).toBe(after);
    expect(JSON.stringify(readConfig(dir))).toBe(config);
  });

  it('gives a project with nothing in it an empty project tree', () => {
    writeConfig({ project: 'Fresh', me: 'alice', roles: [] }, dir);
    expect(migrateIfNeeded(dir)).toBe(true);

    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
    expect(project).toEqual({ name: 'Fresh', whys: [] });
  });

  it('leaves a split-out workstream untouched', () => {
    // The thing that must survive: work someone split out before this shipped.
    seedPreMigrationProject();
    mkdirSync(join(dir, 'workstreams'), { recursive: true });
    writeFileSync(join(dir, 'workstreams', 'engineering.json'),
      JSON.stringify({ id: 'engineering', name: 'Engineering', whys: [{ id: 'e1', text: 'build it' }] }));
    writeConfig({ ...readConfig(dir), workstreams: [{ id: 'engineering', name: 'Engineering' }] }, dir);

    migrateIfNeeded(dir);

    const eng = JSON.parse(readFileSync(join(dir, 'workstreams', 'engineering.json'), 'utf-8'));
    expect(eng.whys[0].text).toBe('build it');
  });
});
