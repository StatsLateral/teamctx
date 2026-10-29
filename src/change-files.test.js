/**
 * The change log answers "newer than X, in these parts" from file names (#206),
 * so a long log is not read to answer a short question.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeChange, listChanges, changeFileName, changeFilePart, wantedChangeFiles } from './storage.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'teamctx-changefiles-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (id, at, tree) => ({ id, at, tree, summary: [`${id}`], touched: { records: [], tasks: [] }, by: null });

describe('a change file name', () => {
  it('carries the time, the part and the id', () => {
    expect(changeFileName(entry('c-1', '2026-10-22T11:17:42.736Z', 'registration'))).toBe('2026-10-22T111742736Z.registration.c-1.json');
    expect(changeFileName(entry('c-2', '2026-10-22T11:17:42.736Z', null))).toBe('2026-10-22T111742736Z.project.c-2.json');
  });

  it('keeps the older form for a part id it could not read back', () => {
    expect(changeFileName(entry('c-3', '2026-10-22T11:17:42.736Z', 'a.b'))).toBe('2026-10-22T111742736Z-c-3.json');
    expect(changeFileName(entry('c-4', '2026-10-22T11:17:42.736Z', 'project'))).toBe('2026-10-22T111742736Z-c-4.json');
  });

  it('is read back to its part, and an older name has none', () => {
    expect(changeFilePart('2026-10-22T111742736Z.registration.c-1.json')).toBe('registration');
    expect(changeFilePart('2026-10-22T111742736Z.project.c-2.json')).toBeNull();
    expect(changeFilePart('2026-10-22T111742736Z-c-1.json')).toBeUndefined();
  });
});

describe('which change files are read', () => {
  const names = [
    '2026-10-01T000000000Z.registration.old.json',
    '2026-10-20T000000000Z.registration.new.json',
    '2026-10-20T000000000Z.venue.sibling.json',
    '2026-10-20T000000000Z.project.top.json',
    '2026-10-20T000000000Z-legacy.json',
  ];

  it('drops older ones and other parts by name, and keeps older names to read', () => {
    expect(wantedChangeFiles(names, { after: '2026-10-10T00:00:00.000Z', trees: [null, 'registration'] })).toEqual([
      '2026-10-20T000000000Z-legacy.json',
      '2026-10-20T000000000Z.project.top.json',
      '2026-10-20T000000000Z.registration.new.json',
    ]);
  });

  it('reads them all when nothing narrows it', () => {
    expect(wantedChangeFiles(names)).toHaveLength(5);
  });
});

describe('listing changes', () => {
  it('writes the part into the name and lists by part and time, older names included', () => {
    writeChange(entry('c-reg', '2026-10-20T00:00:00.000Z', 'registration'), dir);
    writeChange(entry('c-venue', '2026-10-20T00:00:01.000Z', 'venue'), dir);
    writeChange(entry('c-top', '2026-10-20T00:00:02.000Z', null), dir);
    writeChange(entry('c-old', '2026-10-01T00:00:00.000Z', 'registration'), dir);
    mkdirSync(join(dir, 'changes'), { recursive: true });
    writeFileSync(join(dir, 'changes', '2026-10-20T000000003Z-c-legacy-reg.json'), JSON.stringify(entry('c-legacy-reg', '2026-10-20T00:00:00.003Z', 'registration')));
    writeFileSync(join(dir, 'changes', '2026-10-20T000000004Z-c-legacy-venue.json'), JSON.stringify(entry('c-legacy-venue', '2026-10-20T00:00:00.004Z', 'venue')));

    expect(readdirSync(join(dir, 'changes'))).toContain('2026-10-20T000000000Z.registration.c-reg.json');
    const got = listChanges({ after: '2026-10-10T00:00:00.000Z', trees: [null, 'registration'] }, dir).map(e => e.id);
    expect(got).toEqual(['c-reg', 'c-legacy-reg', 'c-top']);
    expect(listChanges({}, dir)).toHaveLength(6);
  });
});
