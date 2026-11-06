/**
 * Files as task outputs (#244): a file the person attaches is stored in the
 * repository beside its record, with the record keeping its name, type, size
 * and hash but never its bytes.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, listOutputs, readOutputFile } from '../../src/storage.js';
import { addTask, saveOutput, saveFileOutput } from './task.core.js';
import { sha256Hex, MAX_PAGE_UPLOAD_BYTES } from '../../src/file-output.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(13)]);
const pdf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'binary');

let dir;
let task;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const as = (actor, fn) => runWithActor(actor, fn);
const attach = (actor, args) => as(actor, () => saveFileOutput({ id: task.id, teamctxDir: dir, ...args }));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-fileout-'));
  writeConfig(makeConfig({
    autoPush: false,
    members: [{ key: member.key, name: member.name, email: member.email }],
    workstreams: [{ id: 'sales', number: 1, name: 'Sales' }],
    nextKey: { workstream: 2, tasks: {} },
  }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  ({ task } = await as(manager, () => addTask({ title: 'Design the banner', workstream: 'sales', teamctxDir: dir })));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('attaching a file output', () => {
  it('stores the bytes in the repo and records name, type, size and hash — not the bytes', async () => {
    const { output } = await attach(member, { bytes: png, name: 'banner.png', notes: 'first cut', source: 'cli' });
    expect(output).toMatchObject({
      task: task.id, kind: 'file', title: 'banner.png', state: 'working',
      notes: 'first cut', source: 'cli', author: { key: member.key, name: 'Priya' },
    });
    expect(output.body).toBeUndefined();
    expect(output.file).toMatchObject({ name: 'banner.png', type: 'image/png', size: png.length, sha256: sha256Hex(png) });
    expect(output.file.path).toBe(`outputs/${task.id}/files/${output.id}-banner.png`);
    // The bytes are on disk, byte-for-byte, and the record itself holds none.
    expect(readOutputFile(task.id, `${output.id}-banner.png`, dir).equals(png)).toBe(true);
    expect(JSON.stringify(output)).not.toContain('IHDR');
    expect(existsSync(join(dir, output.file.path))).toBe(true);
  });

  it('keeps file and text outputs side by side, oldest first', async () => {
    const a = (await as(member, () => saveOutput({ id: task.id, teamctxDir: dir, body: 'the brief' }))).output;
    const b = (await attach(member, { bytes: pdf, name: 'draft.pdf' })).output;
    const saved = listOutputs(task.id, dir);
    expect(saved.map(o => o.id)).toEqual([a.id, b.id]);
    expect(saved.map(o => o.kind || 'text')).toEqual(['text', 'file']);
  });

  it('lets a file build on an earlier output', async () => {
    const first = (await attach(member, { bytes: png, name: 'v1.png' })).output;
    const second = (await attach(member, { bytes: pdf, name: 'v2.pdf', basedOn: first.id })).output;
    expect(second.basedOn).toBe(first.id);
  });

  it('refuses basedOn pointing at an output that is not there', async () => {
    await expect(attach(member, { bytes: png, name: 'x.png', basedOn: 'o-nope' })).rejects.toThrow(/no output/);
  });

  it('never overwrites, even across two uploads of the same name', async () => {
    const a = (await attach(member, { bytes: png, name: 'same.png' })).output;
    const b = (await attach(member, { bytes: png, name: 'same.png' })).output;
    expect(a.id).not.toBe(b.id);
    expect(readdirSync(join(dir, 'outputs', task.id, 'files'))).toHaveLength(2);
  });

  it('passes the route limit through, refusing an over-limit file', async () => {
    const big = Buffer.alloc(MAX_PAGE_UPLOAD_BYTES + 1);
    await expect(attach(member, { bytes: big, name: 'huge.png', maxBytes: MAX_PAGE_UPLOAD_BYTES }))
      .rejects.toThrow(/too large/);
    // Nothing was written when the file was refused.
    expect(existsSync(join(dir, 'outputs', task.id, 'files'))).toBe(false);
  });

  it('refuses bytes whose type does not match the name, writing nothing', async () => {
    await expect(attach(member, { bytes: pdf, name: 'trick.png' })).rejects.toThrow(/does not match/);
    expect(existsSync(join(dir, 'outputs', task.id, 'files'))).toBe(false);
  });
});
