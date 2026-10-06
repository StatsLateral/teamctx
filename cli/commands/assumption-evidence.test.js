/**
 * Evidence against an assumption, through the real storage and review paths.
 *
 * Only the model is stubbed — the provider returns what a model would — so what
 * is tested is everything teamctx does with that: where the evidence's facts
 * come from, that it always reaches the manager, and that approving it lands
 * the evidence and the break together and says what rested on the assumption.
 *
 * Whether the model proposes evidence against the *right* assumption, and only
 * that one, is model behaviour. It is checked against the real model in the
 * sandbox; a stub can only check that teamctx does not make it worse.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithActor } from '../../src/actor.js';
import {
  writeConfig, readConfig, writeProject, readProject, readQueueItem, listQueue,
} from '../../src/storage.js';
import { makeConfig, makeProject, makeRecord } from '../../src/test-fixtures/model.js';
import { contributeCore } from './contribute.core.js';
import { approveReview } from './review.core.js';

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../../src/providers/index.js', () => ({ getProvider: () => ({ complete }), knownProviderIds: () => ['anthropic'] }));
vi.mock('../../src/git.js', () => ({ commitContext: vi.fn(async () => ({ committed: true })), pushContext: vi.fn() }));

const manager = { key: 'git:manager@x', name: 'Manager', email: 'manager@x', source: 'git' };
const member = { key: 'git:priya@x', name: 'Priya', email: 'priya@x', source: 'git' };
const NOTE = 'The last three enterprise prospects all piloted without SSO.';

let dir;
const as = (actor, fn) => runWithActor(actor, fn);
const contribute = (actor = manager, opts = {}) => as(actor, () => contributeCore({ text: NOTE, teamctxDir: dir, source: 'mcp', ...opts }));
const approve = id => as(manager, () => approveReview({ id, teamctxDir: dir }));

/** What a model returns when it reads the note as evidence against `a1`. */
function modelSaysEvidence(extra = {}) {
  complete.mockResolvedValue(JSON.stringify({
    summary: 'Evidence that buyers do not need SSO before a pilot',
    operations: [
      { type: 'addEvidence', id: 'a1', evidence: { text: 'all piloted without SSO', ...extra } },
      { type: 'setRecordStatus', id: 'a1', status: 'broken' },
    ],
    contradictions: [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'teamctx-evidence-'));
  writeConfig(makeConfig({ autoPush: false, managerKey: 'git:manager@x', members: [{ key: 'git:priya@x', email: 'priya@x', name: 'Priya' }] }), dir);
  writeProject(makeProject({
    goal: { text: 'Win enterprise pilots' },
    records: [
      makeRecord({ id: 'a1', key: 'A-1', type: 'assumption', text: 'Buyers need SSO before a pilot', owner: { key: 'k', name: 'O' }, reviewBy: '2026-12-01' }),
      makeRecord({ id: 'd1', key: 'D-1', type: 'decision', text: 'Build SSO first', links: { restsOn: ['a1'] } }),
      makeRecord({ id: 'd2', key: 'D-2', type: 'decision', text: 'Delay the Acme pilot', links: { restsOn: ['a1'] } }),
    ],
  }), dir);
  modelSaysEvidence();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a contribution the model reads as evidence against an assumption', () => {
  it('goes to the manager, and changes nothing until they decide', async () => {
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    const r = await contribute(member);
    expect(r.mode).toBe('queued');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
  });

  it.each(['all', 'additive', 'none'])('queues even the manager asking to apply, under %s', async reviewPolicy => {
    // The inference — that this note argues against that assumption — is the
    // thing a person has to check. The manager's own `apply` is a request to
    // skip a queue, not a review of the inference.
    writeConfig({ ...readConfig(dir), reviewPolicy }, dir);
    const r = await contribute(manager, { apply: true });
    expect(r.mode).toBe('queued');
    expect(r.applyRefused).toBe(true);
    expect(readProject(dir).records.find(x => x.id === 'a1').status).toBe('active');
  });

  it('records who said it, where and when from the contribution, not from the model', async () => {
    // The model tried to say this came from somebody else, through a channel
    // that does not exist, on a different day. None of it survives.
    modelSaysEvidence({ by: 'The CEO', source: 'board-minutes', at: '1999-01-01T00:00:00.000Z' });
    const r = await contribute(member);
    const queued = readQueueItem(r.id, dir).operations.find(o => o.type === 'addEvidence');
    expect(queued.evidence.text).toBe('all piloted without SSO');
    expect(queued.evidence.by).toBe('Priya');
    expect(queued.evidence.source).toBe('mcp');
    expect(queued.evidence.at).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(queued.evidence.at)).toBeGreaterThan(Date.parse('2026-01-01'));
  });

});

describe('approving it', () => {
  it('lands the evidence and the break together', async () => {
    const r = await contribute(member);
    await approve(r.id);
    const a = readProject(dir).records.find(x => x.id === 'a1');
    expect(a.status).toBe('broken');
    expect(a.evidence).toEqual([expect.objectContaining({ text: 'all piloted without SSO', by: 'Priya', source: 'mcp' })]);
    expect(listQueue(dir)).toHaveLength(0);
  });

  it('flags what rested on it, which is #120 taking over', async () => {
    const r = await contribute(member);
    await approve(r.id);
    const records = readProject(dir).records;
    // Still active: nothing that rested on the assumption changes status without
    // the manager. #120's flag is derived on read from here.
    expect(records.find(x => x.id === 'd1').status).toBe('active');
    expect(records.find(x => x.id === 'a1').brokenAt).toBeTruthy();
  });
});

describe('what teamctx refuses to make worse', () => {
  it('drops evidence the model aimed at a decision, rather than writing it', async () => {
    // A decision does not break; it is replaced. Evidence against one is a
    // contradiction — #121's business, not this.
    complete.mockResolvedValue(JSON.stringify({
      summary: 's', contradictions: [],
      operations: [{ type: 'addEvidence', id: 'd1', evidence: { text: 'x' } }],
    }));
    const r = await contribute(member);
    expect(r.dropped.map(d => d.reason).join(' ')).toMatch(/against an assumption/);
    expect(r.operations.some(o => o.type === 'addEvidence')).toBe(false);
  });

  it('drops evidence against an assumption that is not there', async () => {
    complete.mockResolvedValue(JSON.stringify({
      summary: 's', contradictions: [],
      operations: [{ type: 'addEvidence', id: 'invented', evidence: { text: 'x' } }],
    }));
    const r = await contribute(member);
    expect(r.dropped.map(d => d.reason).join(' ')).toMatch(/no record/);
  });

  it('leaves an ordinary contribution alone', async () => {
    // A task, which nothing governs: under `none` it applies as it always did.
    // Evidence forcing a queue must not leak into contributions without any.
    complete.mockResolvedValue(JSON.stringify({
      summary: 's', contradictions: [],
      operations: [{ type: 'addTask', title: 'Draft the pilot agreement' }],
    }));
    writeConfig({ ...readConfig(dir), reviewPolicy: 'none' }, dir);
    const r = await contribute(member);
    expect(r.mode).toBe('applied');
  });
});
