/**
 * What a contribution was drawn from leaves a trace only once the contribution
 * actually reaches the project (#168): queued or applied. One that is
 * discarded, or changes nothing, leaves none.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWithActor } from '../../src/actor.js';
import { makeConfig, makeProject, makeWorkstream } from '../../src/test-fixtures/model.js';
import { writeConfig, writeProject, writeWorkstream, readSourceRefs } from '../../src/storage.js';
import { contributeCore } from './contribute.core.js';
import { proposeDiff } from '../../src/ai.js';

vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));
vi.mock('../../src/ai.js', async original => ({ ...(await original()), proposeDiff: vi.fn(), callClaude: vi.fn(async ({ prompt }) => prompt) }));

let dir;
const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const thread = { connector: 'slack', title: 'Pricing thread', link: 'https://acme.slack.com/archives/C1/p1' };
const send = (opts) => runWithActor(manager, () => contributeCore({ text: 'From the thread.', workstreamId: 'sales', teamctxDir: dir, sources: [thread], ...opts }));

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-csrc-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [{ id: 'sales', number: 1, name: 'Sales' }], nextKey: { workstream: 2, tasks: {} } }), dir);
  writeProject(makeProject({ goal: { text: 'Existing project' } }), dir);
  writeWorkstream('sales', makeWorkstream('sales'), dir);
  proposeDiff.mockResolvedValue({ summary: 'Seat pricing agreed', operations: [{ type: 'addRecord', record: { type: 'decision', text: 'Price by seat' } }] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recording what a contribution was drawn from', () => {
  it('records it when the contribution goes to review, with the contribution summary', async () => {
    const r = await send({});
    expect(r.mode).toBe('queued');
    const [ref] = Object.values(readSourceRefs(dir));
    expect(ref.feeds).toMatchObject([{ workstream: 'sales', contribution: r.id, summary: 'Seat pricing agreed', by: { name: 'Manager' } }]);
  });

  it('records it when the manager applies the contribution', async () => {
    const r = await send({ apply: true });
    expect(r.mode).toBe('applied');
    expect(Object.values(readSourceRefs(dir))[0].feeds[0].contribution).toBe(r.id);
  });

  it('records nothing for a contribution that changes nothing', async () => {
    proposeDiff.mockResolvedValue({ summary: 'nothing new', operations: [] });
    expect((await send({})).mode).toBe('no-op');
    expect(readSourceRefs(dir)).toEqual({});
  });

  it('records nothing for a contribution its sender discards', async () => {
    expect((await send({ onProposed: async () => false })).mode).toBe('discarded');
    expect(readSourceRefs(dir)).toEqual({});
  });
});
