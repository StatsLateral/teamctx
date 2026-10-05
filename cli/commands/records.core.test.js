import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeConfig, writeProject, writeWorkstream, withRecordKeys, readWorkstream } from '../../src/storage.js';
import { listRecords, getRecord, RecordNotFoundError } from './records.core.js';
import { scopeFor } from '../../src/member-scope.js';
import { makeRecord, makeConfig } from '../../src/test-fixtures/model.js';

let dir;
const config = makeConfig({
  workstreams: [
    { id: 'sales', name: 'Sales', parent: null, order: 1 },
    { id: 'outreach', name: 'Outreach', parent: 'sales', order: 1 },
    { id: 'expansion', name: 'Expansion', parent: null, order: 2 },
  ],
  members: [{ key: 'git:m@x', email: 'm@x', name: 'M', workstreams: ['sales'] }],
});
const memberScope = () => scopeFor(config, { key: 'git:m@x', email: 'm@x' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-rec-'));
  mkdirSync(join(dir, 'workstreams'));
  writeConfig(config, dir);
  writeProject({ name: 'P', goal: null, records: [makeRecord({ id: 'rec-p', type: 'rule', text: 'Project rule' })], tasks: [] }, dir);
  writeWorkstream('sales', { id: 'sales', name: 'Sales', records: [makeRecord({ id: 'rec-s', type: 'decision', text: 'Sales decision' })], tasks: [] }, dir);
  writeWorkstream('outreach', { id: 'outreach', name: 'Outreach', records: [
    makeRecord({ id: 'rec-o', type: 'assumption', text: 'Budget in Q3', reviewBy: '2026-09-01' }),
    makeRecord({ id: 'rec-old', type: 'decision', text: 'Old', status: 'replaced' }),
  ], tasks: [] }, dir);
  writeWorkstream('expansion', { id: 'expansion', name: 'Expansion', records: [
    makeRecord({ id: 'rec-e', type: 'decision', text: 'Expansion secret' }),
    makeRecord({ id: 'rec-x', type: 'exception', text: 'Soon over', expiresAt: '2026-10-10', links: { bends: 'rec-p' } }),
  ], tasks: [] }, dir);
});

describe('listRecords', () => {
  it('resolves a key only among records the caller may read', () => {
    withRecordKeys(dir, () => {});
    const visible = readWorkstream('sales', dir).records[0];
    const hidden = readWorkstream('expansion', dir).records[0];
    expect(getRecord({ teamctxDir: dir, scope: memberScope(), id: visible.key }).id).toBe(visible.id);
    expect(() => getRecord({ teamctxDir: dir, scope: memberScope(), id: hidden.key })).toThrow(RecordNotFoundError);
  });
  it('gives a scoped member their workstream, the parts below it and the project — nothing else', () => {
    const ws = new Set(listRecords({ teamctxDir: dir, scope: memberScope(), onDay: '2026-10-02' }).map(r => r.workstream));
    expect([...ws].sort()).toEqual([null, 'outreach', 'sales'].sort());
  });
  it('lists active records only, unless a status is asked for', () => {
    const ids = listRecords({ teamctxDir: dir, onDay: '2026-10-02' }).map(r => r.id);
    expect(ids).not.toContain('rec-old');
    expect(listRecords({ teamctxDir: dir, status: 'replaced' }).map(r => r.id)).toEqual(['rec-old']);
  });
  it('numbers each record by the workstream it sits in', () => {
    const r = listRecords({ teamctxDir: dir, onDay: '2026-10-02' }).find(x => x.id === 'rec-o');
    expect(r.number).toBe('1.1');
  });
  it('lists what is due: assumptions past review, exceptions expiring within 14 days', () => {
    const ids = listRecords({ teamctxDir: dir, due: true, onDay: '2026-10-02' }).map(r => r.id).sort();
    expect(ids).toEqual(['rec-o', 'rec-x']);
  });
  it('filters by type', () => {
    expect(listRecords({ teamctxDir: dir, type: 'rule', onDay: '2026-10-02' }).map(r => r.id)).toEqual(['rec-p']);
  });
});

describe('getRecord', () => {
  it('returns an in-scope record with where it sits', () => {
    expect(getRecord({ teamctxDir: dir, scope: memberScope(), id: 'rec-o' })).toMatchObject({ id: 'rec-o', workstream: 'outreach' });
  });
  it('answers the same for out-of-scope and missing, so nothing leaks', () => {
    const msg = (id) => { try { getRecord({ teamctxDir: dir, scope: memberScope(), id }); } catch (e) { return [e.constructor, e.message.replace(id, 'ID')]; } };
    expect(msg('rec-e')).toEqual(msg('rec-nope'));
    expect(msg('rec-e')[0]).toBe(RecordNotFoundError);
  });
});
