import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeApproved, writeQueueItem } from './storage.js';
import { contextFreshness, freshnessLine, withFreshness } from './freshness.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'teamctx-fresh-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse('2026-10-21T12:00:00Z');

describe('how fresh the context is', () => {
  it('takes the date from the newest approval file, whatever order they are in', () => {
    writeApproved({ id: 'c-a', approvedAt: '2026-10-01T09:00:00Z' }, dir);
    writeApproved({ id: 'c-b', approvedAt: '2026-10-09T09:00:00Z' }, dir);
    writeApproved({ id: 'c-c', approvedAt: '2026-09-30T09:00:00Z' }, dir);
    expect(contextFreshness(dir).lastApprovedAt).toBe('2026-10-09T09:00:00Z');
  });

  it('has no date when nothing was recorded, and an unreadable date is not one', () => {
    expect(contextFreshness(dir).lastApprovedAt).toBeNull();
    writeApproved({ id: 'c-a', approvedAt: 'soon' }, dir);
    mkdirSync(join(dir, 'approved'), { recursive: true });
    writeFileSync(join(dir, 'approved', 'broken.json'), '{');
    expect(contextFreshness(dir).lastApprovedAt).toBeNull();
  });

  it('counts what is waiting for review', () => {
    expect(contextFreshness(dir).waiting).toBe(0);
    writeQueueItem({ id: 'q-1', workstream: 'ws-a', createdAt: '2026-10-20T00:00:00Z' }, dir);
    writeQueueItem({ id: 'q-2', workstream: 'ws-b', createdAt: '2026-10-20T00:00:01Z' }, dir);
    expect(contextFreshness(dir).waiting).toBe(2);
  });

  it('counts only the parts a scoped reader may see, approvals as well as the queue', () => {
    writeApproved({ id: 'c-a', workstream: 'ws-a', approvedAt: '2026-10-01T09:00:00Z' }, dir);
    writeApproved({ id: 'c-b', workstream: 'ws-b', approvedAt: '2026-10-20T09:00:00Z' }, dir);
    writeQueueItem({ id: 'q-1', workstream: 'ws-a', createdAt: '2026-10-20T00:00:00Z' }, dir);
    writeQueueItem({ id: 'q-2', workstream: 'ws-b', createdAt: '2026-10-20T00:00:01Z' }, dir);
    expect(contextFreshness(dir, { scope: ['ws-a'] })).toEqual({ lastApprovedAt: '2026-10-01T09:00:00Z', waiting: 1 });
  });

  it('for a role file, counts its own part and the project, not a sibling', () => {
    writeApproved({ id: 'c-p', workstream: null, approvedAt: '2026-09-01T09:00:00Z' }, dir);
    writeApproved({ id: 'c-a', workstream: 'ws-a', approvedAt: '2026-10-01T09:00:00Z' }, dir);
    writeApproved({ id: 'c-b', workstream: 'ws-b', approvedAt: '2026-10-20T09:00:00Z' }, dir);
    expect(contextFreshness(dir, { role: { workstream: 'ws-a' } }).lastApprovedAt).toBe('2026-10-01T09:00:00Z');
    expect(contextFreshness(dir, { role: { workstream: null } }).lastApprovedAt).toBe('2026-10-20T09:00:00Z');
  });

  it('is null, not an error, when the queue cannot be read', () => {
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(join(dir, 'queue', 'broken.json'), '{');
    expect(contextFreshness(dir)).toBeNull();
    expect(freshnessLine(null)).toBeNull();
    expect(withFreshness('# T\nbody', null)).toBe('# T\nbody');
  });
});

describe('the line', () => {
  it('says how long ago, and how much is waiting', () => {
    expect(freshnessLine({ lastApprovedAt: '2026-10-09T09:00:00Z', waiting: 3 }, NOW))
      .toBe('Context last approved 12 days ago; 3 items waiting for review.');
    expect(freshnessLine({ lastApprovedAt: '2026-10-20T15:00:00Z', waiting: 1 }, NOW))
      .toBe('Context last approved yesterday; 1 item waiting for review.');
    expect(freshnessLine({ lastApprovedAt: '2026-10-21T08:00:00Z', waiting: 0 }, NOW))
      .toBe('Context last approved today; nothing waiting for review.');
  });

  it('counts days where it is read, not in UTC', () => {
    const lateLastNight = new Date(2026, 9, 20, 23, 30).toISOString();
    const earlyToday = new Date(2026, 9, 21, 0, 30).toISOString();
    const thisMorning = new Date(2026, 9, 21, 9, 0).getTime();
    expect(freshnessLine({ lastApprovedAt: lateLastNight, waiting: 0 }, thisMorning)).toMatch(/approved yesterday;/);
    expect(freshnessLine({ lastApprovedAt: earlyToday, waiting: 0 }, thisMorning)).toMatch(/approved today;/);
  });

  it('says not recorded rather than guessing', () => {
    expect(freshnessLine({ lastApprovedAt: null, waiting: 0 }, NOW))
      .toBe('Context last approved: not recorded; nothing waiting for review.');
  });
});

describe('a role file as it is read', () => {
  it('carries the line under its title', () => {
    const md = '# Dev Context — Shop\n*Last updated: 2026-10-09*\n\n## Your Role\nBuild it.';
    expect(withFreshness(md, 'Context last approved 12 days ago; nothing waiting for review.'))
      .toBe('# Dev Context — Shop\n\n*Context last approved 12 days ago; nothing waiting for review.*\n\n*Last updated: 2026-10-09*\n\n## Your Role\nBuild it.');
  });

  it('puts it first when there is no title', () => {
    expect(withFreshness('Just text.', 'L.')).toBe('*L.*\n\nJust text.');
  });
});
