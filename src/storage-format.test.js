import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readProject, readWorkstream, writeProject, writeWorkstream } from './storage.js';
import { LegacyFormatError } from './model.js';
import { isProjectLevel } from './project-level.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-')); mkdirSync(join(dir, 'workstreams')); });

describe('tree storage', () => {
  it('reads a missing project as the new empty shape', () => {
    expect(readProject(dir)).toEqual({ name: '', goal: null, records: [], tasks: [] });
  });
  it('round-trips a workstream', () => {
    writeWorkstream('sales', { id: 'sales', name: 'Sales', records: [], tasks: [] }, dir);
    expect(readWorkstream('sales', dir).name).toBe('Sales');
  });
  it('reports the old format instead of reading it as empty', () => {
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'p', whys: [] }));
    expect(() => readProject(dir)).toThrow(LegacyFormatError);
    writeFileSync(join(dir, 'workstreams', 'old.json'), JSON.stringify({ id: 'old', whys: [] }));
    expect(() => readWorkstream('old', dir)).toThrow(LegacyFormatError);
  });
  it('writes the project without a stray id', () => {
    writeProject({ id: 'x', name: 'p', goal: null, records: [], tasks: [] }, dir);
    expect(readProject(dir)).not.toHaveProperty('id');
  });
  it('no longer treats "main" as the project', () => {
    expect(isProjectLevel('main')).toBe(false);
    expect(isProjectLevel(null)).toBe(true);
  });
});
