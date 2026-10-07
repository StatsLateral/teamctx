import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let caller = { key: 'git:boss@x', name: 'Boss', source: 'git' };
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(), pushContext: vi.fn() }));
vi.mock('../../src/actor.js', () => ({ resolveActor: vi.fn(async () => caller) }));
vi.mock('../../src/prefs.js', () => ({
  resolveActiveWorkstream: vi.fn(async () => null),
  resolveDisplayName: vi.fn(async () => caller.name),
  writePrefs: vi.fn(),
}));

const { addWorkstream } = await import('./workstream.core.js');
const { readConfig, writeConfig, readWorkstream } = await import('../../src/storage.js');

let teamctxDir;
beforeEach(() => {
  teamctxDir = mkdtempSync(join(tmpdir(), 'tc-ws-'));
  mkdirSync(join(teamctxDir, 'workstreams'));
  writeConfig({ project: 'Party', me: 'Boss', managerKey: 'git:boss@x', workstreams: [], roles: [], members: [] }, teamctxDir);
  caller = { key: 'git:boss@x', name: 'Boss', source: 'git' };
});

describe('addWorkstream', () => {
  it('adds a top-level and a nested workstream, numbered flat in the order they were made', async () => {
    const a = await addWorkstream({ name: 'Food & cake', teamctxDir });
    const b = await addWorkstream({ name: 'Cake', parent: a.workstream.id, teamctxDir });
    const c = await addWorkstream({ name: 'Guests', teamctxDir });
    // Nesting is the indent, never the number: Cake is 2, not 1.1, and Guests is 3.
    expect(a.workstream.number).toBe('1');
    expect(b.workstream.number).toBe('2');
    expect(c.workstream.number).toBe('3');
    expect(readConfig(teamctxDir).workstreams.map(w => w.number)).toEqual([1, 2, 3]);
    expect(readConfig(teamctxDir).nextKey).toEqual({ workstream: 4, tasks: {} });
    expect(readConfig(teamctxDir).workstreams.find(w => w.id === b.workstream.id).parent).toBe(a.workstream.id);
    expect(readWorkstream(b.workstream.id, teamctxDir)).toEqual({ id: b.workstream.id, name: 'Cake', records: [], tasks: [] });
  });

  it('gives a second workstream with the same name its own id', async () => {
    const a = await addWorkstream({ name: 'Cake', teamctxDir });
    const b = await addWorkstream({ name: 'Cake', teamctxDir });
    expect(a.workstream.id).not.toBe(b.workstream.id);
  });

  it('keeps a number for good: removing a part leaves a gap, and a new one does not take it', async () => {
    const a = await addWorkstream({ name: 'One', teamctxDir });
    await addWorkstream({ name: 'Two', teamctxDir });
    const config = readConfig(teamctxDir);
    writeConfig({ ...config, workstreams: config.workstreams.filter(w => w.id !== a.workstream.id) }, teamctxDir);
    const c = await addWorkstream({ name: 'Three', teamctxDir });
    expect(c.workstream.number).toBe('3');
  });

  it('numbers nothing when it refuses', async () => {
    await expect(addWorkstream({ name: 'X', parent: 'ghost', teamctxDir })).rejects.toThrow();
    expect(readConfig(teamctxDir).nextKey).toBeUndefined();
  });

  it('refuses an unknown parent', async () => {
    await expect(addWorkstream({ name: 'X', parent: 'ghost', teamctxDir })).rejects.toThrow(/no workstream "ghost"/);
  });

  it('refuses an empty name', async () => {
    await expect(addWorkstream({ name: '  ', teamctxDir })).rejects.toThrow(/needs a name/);
  });

  it("is the manager's alone", async () => {
    caller = { key: 'git:member@x', name: 'Member', source: 'git' };
    await expect(addWorkstream({ name: 'X', teamctxDir })).rejects.toMatchObject({ code: 'MANAGER_GATE' });
  });
});
