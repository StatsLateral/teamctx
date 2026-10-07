import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithActor } from '../../src/actor.js';
import { writeConfig, readConfig, writeProject, readProject, writeWorkstream, readWorkstream, readQueueItem, listQueue, writeQueueItem } from '../../src/storage.js';
import { makeConfig, makeProject, makeRecord, makeWorkstream } from '../../src/test-fixtures/model.js';
import { contributeCore } from './contribute.core.js';
import { approveReview, rejectReview } from './review.core.js';
import { comparisonRecords } from '../../src/contradictions.js';

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../../src/providers/index.js', () => ({ getProvider: () => ({ complete }), knownProviderIds: () => ['anthropic'] }));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const run = fn => runWithActor(manager, fn);
const oldText = 'The entry offer is a pricing audit';
const newText = 'The entry offer is an AI-readiness assessment';
const add = text => ({ type: 'addRecord', record: { type: 'decision', text } });
let dir;
const contribute = opts => run(() => contributeCore({ text: newText, apply: true, teamctxDir: dir, ...opts }));
const approve = (id, replaces) => run(() => approveReview({ id, replaces, teamctxDir: dir }));
function response(operations = [add(newText)], contradictions = [{ operationIndex: 0, recordId: 'old', workstream: null }]) {
  complete.mockResolvedValue(JSON.stringify({ summary: 'Change the entry offer', operations, contradictions }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-contradictions-'));
  writeConfig(makeConfig({ autoPush: false, workstreams: [
    { id: 'launch', name: 'Launch' }, { id: 'pricing', name: 'Pricing', parent: 'launch' }, { id: 'other', name: 'Other' },
  ] }), dir);
  writeProject(makeProject({ records: [makeRecord({ id: 'old', text: oldText })] }), dir);
  for (const id of ['launch', 'pricing', 'other']) writeWorkstream(id, makeWorkstream(id), dir);
  response();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('contradiction review through the real provider and storage paths', () => {
  it.each(['all', 'additive', 'none'])('queues even manager direct apply under %s without spending any number', async reviewPolicy => {
    writeConfig({ ...readConfig(dir), reviewPolicy }, dir);
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    const result = await contribute();
    expect(result.mode).toBe('queued');
    expect(result.applyRefused).toBe(true);
    expect(result.contradictions[0]).toEqual({ operationIndex: 0, proposedText: newText, record: { id: 'old', type: 'decision', text: oldText, workstream: null } });
    expect(readQueueItem(result.id, dir).contradictions).toEqual(result.contradictions);
    expect(readConfig(dir).nextKey).toBeUndefined();
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
  });

  it('refuses unresolved approval without changing any context or counters', async () => {
    const queued = await contribute();
    const before = ['config.json', 'project.json'].map(p => readFileSync(join(dir, p), 'utf8'));
    await expect(approve(queued.id)).rejects.toThrow(/Contradicts.*pricing audit.*AI-readiness assessment/);
    expect(['config.json', 'project.json'].map(p => readFileSync(join(dir, p), 'utf8'))).toEqual(before);
    expect(listQueue(dir)).toHaveLength(1);
  });

  it('approves a manager-selected replacement by id and records the approver', async () => {
    const queued = await contribute();
    const result = await approve(queued.id, ['old']);
    const records = readProject(dir).records;
    expect(records[0].status).toBe('replaced');
    expect(records[1]).toMatchObject({ text: newText, status: 'active', links: { replaces: 'old' }, approvedBy: { key: manager.key } });
    expect(result.operations[0].record.links.replaces).toBe('old');
    expect(result.contradictions).toHaveLength(1);
    expect(listQueue(dir)).toHaveLength(0);
  });

  it('allows an explicit replacement only after queue approval', async () => {
    const op = add(newText); op.record.links = { replaces: 'old' };
    response([op]);
    const queued = await contribute();
    expect(queued.mode).toBe('queued');
    expect(readProject(dir).records[0].status).toBe('active');
    await approve(queued.id);
    expect(readProject(dir).records[0].status).toBe('replaced');
  });

  it('turns a conflicting edit into a replacement, retaining the old record in history', async () => {
    response([{ type: 'editRecord', id: 'old', changes: { text: newText } }]);
    const queued = await contribute();
    await approve(queued.id, ['old']);
    const records = readProject(dir).records;
    expect(records[0]).toMatchObject({ id: 'old', text: oldText, status: 'replaced' });
    expect(records[1]).toMatchObject({ text: newText, status: 'active' });
    expect(records[1].id).not.toBe('old');
  });

  it('reports the replacement as a new record, not as the one it replaced', async () => {
    // The stored data was always right; the approval result was not. It
    // carried the old record's id in the proposal, so it named the new
    // decision as the old one while the tree held it under another id.
    response([{ type: 'editRecord', id: 'old', changes: { text: newText } }]);
    const queued = await contribute();
    const r = await approve(queued.id, ['old']);
    const proposed = r.operations.find(o => o.type === 'addRecord').record;
    expect(proposed.id).toBeUndefined();
    expect(proposed.status).toBeUndefined();
    expect(proposed).toMatchObject({ text: newText, links: expect.objectContaining({ replaces: 'old' }) });
  });

  it('rejects a flagged contribution without spending any number', async () => {
    const queued = await contribute();
    const rejected = await run(() => rejectReview({ id: queued.id, reason: 'Keep pricing audits', teamctxDir: dir }));
    expect(rejected.reason).toBe('Keep pricing audits');
    expect(readProject(dir).records).toHaveLength(1);
    expect(readConfig(dir).nextKey).toBeUndefined();
    expect(listQueue(dir)).toHaveLength(0);
    const archived = JSON.parse(readFileSync(join(dir, 'rejected', `${queued.id}.json`), 'utf8'));
    expect(archived.contradictions[0].record.text).toBe(oldText);
  });

  it('compares the project and ancestor chain, excluding siblings, inactive records and assumptions', async () => {
    writeWorkstream('launch', makeWorkstream('launch', { records: [makeRecord({ id: 'parent-rule', type: 'rule', text: 'Annual contracts only' })] }), dir);
    writeWorkstream('pricing', makeWorkstream('pricing', { records: [makeRecord({ id: 'local-choice', text: 'Charge annually' }), makeRecord({ type: 'assumption' }), makeRecord({ id: 'retired', status: 'replaced' })] }), dir);
    writeWorkstream('other', makeWorkstream('other', { records: [makeRecord({ id: 'sibling', text: 'Secret other work' })] }), dir);
    const comparisons = comparisonRecords({ config: readConfig(dir), target: 'pricing', teamctxDir: dir });
    expect(comparisons.map(r => r.id)).toEqual(['old', 'parent-rule', 'local-choice']);
    response([add(newText)], [{ operationIndex: 0, recordId: 'parent-rule', workstream: 'launch' }]);
    await contribute({ workstreamId: 'pricing' });
    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('Annual contracts only');
    expect(prompt).toContain(oldText);
    expect(prompt).not.toContain('Secret other work');
    expect(prompt).not.toContain('"retired"');
  });

  it('prevents a child from replacing an inherited choice and permits approval once it is retired above', async () => {
    const queued = await contribute({ workstreamId: 'pricing' });
    await expect(approve(queued.id, ['old'])).rejects.toThrow(/inherited/);
    expect(readConfig(dir).nextKey).toBeUndefined();
    response([{ type: 'setRecordStatus', id: 'old', status: 'replaced' }], []);
    await contribute();
    await approve(queued.id);
    expect(readProject(dir).records[0].status).toBe('replaced');
    expect(readWorkstream('pricing', dir).records[0].text).toBe(newText);
  });

  it('preserves the index of a conflict after a preceding invalid operation is dropped', async () => {
    response([{ type: 'addRecord', record: { type: 'exception', text: 'Invalid without a rule' } }, add(newText)], [{ operationIndex: 1, recordId: 'old', workstream: null }]);
    const queued = await contribute();
    expect(queued.operations).toHaveLength(1);
    expect(queued.contradictions[0].operationIndex).toBe(0);
    await approve(queued.id, ['old']);
    expect(readProject(dir).records[1].text).toBe(newText);
  });

  it('does not flag unrelated additions or consume an additional provider call', async () => {
    response([{ type: 'addRecord', record: { type: 'rule', text: 'Write daily delivery notes' } }], []);
    const result = await contribute();
    expect(result.mode).toBe('applied');
    expect(result.contradictions).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(readProject(dir).records[0].status).toBe('active');
    expect(readProject(dir).records[1].type).toBe('rule');
  });

  it('does not treat a valid governed exception as contradicting the rule it bends even if the provider flags it', async () => {
    writeProject(makeProject({ records: [makeRecord({ id: 'old', type: 'rule', text: 'Discounts must not exceed 15%' })] }), dir);
    response([{ type: 'addRecord', record: { type: 'exception', text: 'Acme may receive a 20% discount', links: { bends: 'old' }, expiresAt: '2999-01-01' } }]);
    const result = await contribute();
    expect(result.mode).toBe('applied');
    expect(result.contradictions).toBeUndefined();
    expect(readProject(dir).records[0].status).toBe('active');
    expect(readProject(dir).records[1]).toMatchObject({ type: 'exception', links: { bends: 'old' } });
  });

  it('rechecks saved operations if comparison context changes during the provider call', async () => {
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    complete.mockImplementationOnce(async () => {
      entered();
      await new Promise(resolve => { release = resolve; });
      return JSON.stringify({ summary: 'Entry offer', operations: [add(newText)], contradictions: [] });
    }).mockResolvedValue(JSON.stringify({ summary: 'Fresh check', operations: [add('Provider must not change these operations')], contradictions: [{ operationIndex: 0, recordId: 'new-choice', workstream: null }] }));
    const pending = contribute();
    await started;
    writeProject(makeProject({ records: [makeRecord({ id: 'new-choice', text: 'The entry offer must remain a pricing audit' })] }), dir);
    release();
    const result = await pending;
    expect(result.mode).toBe('queued');
    expect(result.operations[0].record.text).toBe(newText);
    expect(result.contradictions[0].record.id).toBe('new-choice');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].prompt).toContain('Previously proposed operations to check');
    expect(readProject(dir).records).toHaveLength(1);
  });

  it('keeps the allowed-exception guard when editing an existing exception', async () => {
    writeProject(makeProject({ records: [
      makeRecord({ id: 'old', type: 'rule', text: 'Discounts must not exceed 15%' }),
      makeRecord({ id: 'allowance', type: 'exception', text: 'Acme may receive 20%', links: { bends: 'old' }, expiresAt: '2999-01-01' }),
    ] }), dir);
    response([{ type: 'editRecord', id: 'allowance', changes: { text: 'Acme may receive 25%' } }]);
    const result = await contribute();
    expect(result.mode).toBe('applied');
    expect(result.contradictions).toBeUndefined();
    expect(readProject(dir).records[1]).toMatchObject({ text: 'Acme may receive 25%', links: { bends: 'old' } });
  });

  it('requires a fresh submission if a flagged record changes before approval', async () => {
    const queued = await contribute();
    const tree = readProject(dir);
    tree.records[0].text = 'The entry offer is a security audit';
    writeProject(tree, dir);
    await expect(approve(queued.id, ['old'])).rejects.toThrow(/changed since this check/);
    expect(listQueue(dir)).toHaveLength(1);
    expect(readConfig(dir).nextKey).toBeUndefined();
  });

  it('requires a completed check before applying a record when comparison records exist', async () => {
    complete.mockResolvedValue(JSON.stringify({ summary: 'Missing check', operations: [add(newText)] }));
    await expect(contribute()).rejects.toThrow(/omitted the contradiction check/);
    expect(readProject(dir).records).toHaveLength(1);
    expect(listQueue(dir)).toHaveLength(0);
  });

  it.each([
    [{ operationIndex: 0, recordId: 'unknown' }],
    [{ operationIndex: 4, recordId: 'old' }],
    [{ operationIndex: 0, recordId: 'old', workstream: 'other' }],
  ])('rejects fabricated comparison references: %j', async hits => {
    response([add(newText)], [hits]);
    await expect(contribute()).rejects.toThrow(/unknown record or operation/);
    expect(readProject(dir).records).toHaveLength(1);
    expect(readConfig(dir).nextKey).toBeUndefined();
  });

  it('requires all conflicting records to be resolved in a multi-operation proposal', async () => {
    writeProject(makeProject({ records: [makeRecord({ id: 'old', text: oldText }), makeRecord({ id: 'old2', text: 'Ship in October' })] }), dir);
    response([add(newText), add('Ship in November')], [{ operationIndex: 0, recordId: 'old' }, { operationIndex: 1, recordId: 'old2' }]);
    const queued = await contribute();
    await expect(approve(queued.id, ['old'])).rejects.toThrow(/Ship in October/);
    await approve(queued.id, ['old', 'old2']);
    expect(readProject(dir).records.map(r => r.status)).toEqual(['replaced', 'replaced', 'active', 'active']);
  });

  it('retains the queue when a replacement cannot validate on approval', async () => {
    const queued = await contribute();
    const item = readQueueItem(queued.id, dir);
    item.operations[0].record.text = '';
    writeQueueItem(item, dir);
    await expect(approve(queued.id, ['old'])).rejects.toThrow(/cannot be applied/);
    expect(readConfig(dir).nextKey).toBeUndefined();
    expect(readProject(dir).records[0].status).toBe('active');
    expect(listQueue(dir)).toHaveLength(1);
  });

  it('approves a resolved conflict even when something else in it went stale', async () => {
    // The manager's answer must not be thrown away because of an unrelated
    // operation. A queue item can sit for days, and an `editRecord` in it can
    // name a record that was legitimately retired in the meantime — that drops,
    // as it should, but the conflict beside it was resolved correctly. Blocking
    // on any dropped operation left the item approvable never, only rejectable.
    writeProject(makeProject({ records: [
      makeRecord({ id: 'old', text: oldText }),
      makeRecord({ id: 'doomed', text: 'Still here when this was written' }),
    ] }), dir);
    response([add(newText), { type: 'editRecord', id: 'doomed', changes: { text: 'reworded' } }],
      [{ operationIndex: 0, recordId: 'old' }]);
    const queued = await contribute();

    // Days pass, and the edited record is retired by somebody else. The edit in
    // the queue item now names nothing and will drop on approval — which is
    // correct, and has nothing to do with the conflict beside it.
    writeProject(makeProject({ records: [makeRecord({ id: 'old', text: oldText })] }), dir);

    await approve(queued.id, ['old']);

    // The conflict landed: the old record retired, the new one active.
    const records = readProject(dir).records;
    expect(records.find(r => r.id === 'old').status).toBe('replaced');
    expect(records.some(r => r.text === newText && r.status === 'active')).toBe(true);
    expect(listQueue(dir)).toHaveLength(0);
  });

  it('still refuses when the resolution itself is what will not apply', async () => {
    // The case the check exists for, unchanged: the conflicting operation is the
    // one that drops.
    const queued = await contribute();
    const item = readQueueItem(queued.id, dir);
    item.operations[0].record.text = '';
    writeQueueItem(item, dir);
    await expect(approve(queued.id, ['old'])).rejects.toThrow(/cannot be applied/);
    expect(listQueue(dir)).toHaveLength(1);
  });

  it('gives the provider explicit instructions about unrelated topics, exceptions and manager authority', async () => {
    await contribute();
    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('cannot both hold for the same subject and scope');
    expect(prompt).toContain('metadata-only edits');
    expect(prompt).toContain('explicit allowed exceptions');
    expect(prompt).toContain('Keep the proposed operation so a manager can decide');
    expect(prompt).not.toContain('add a question');
  });
});
