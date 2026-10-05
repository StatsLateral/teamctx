import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  writeWorkstreamMd: vi.fn(),
  readTree: vi.fn(() => ({ id: 'main', name: 'M', records: [], tasks: [] })),
  writeTree: vi.fn(),
  readTreeMd: vi.fn(() => ''),
  writeTreeMd: vi.fn(),
  readProject: vi.fn(() => ({ name: '', goal: { text: 'An existing goal' }, records: [], tasks: [] })),
  writeConfig: vi.fn(),
  readConfig: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'main', name: 'M', records: [], tasks: [] })),
  writeTree: vi.fn(),
  writeTreeMd: vi.fn(),
  appendContribution: vi.fn(),
  writeRoleFile: vi.fn(),
  writeQueueItem: vi.fn(),
  readContributions: vi.fn(() => []),
  listWorkstreamIds: vi.fn(() => ['main']),
}));

vi.mock('../../src/context.js', () => ({
  updateShared: vi.fn(async () => ({
    workstream: { id: 'main', name: 'M', records: [{ id: 'w1', type: 'decision', text: 'x', status: 'active' }], tasks: [] },
    summary: 's',
    operations: [{ type: 'addRecord', record: { type: 'decision', text: 'x' } }],
    dropped: [],
  })),
  generateRoleFile: vi.fn(() => Promise.resolve('# role md')),
  serializeToMd: vi.fn(() => '# md'),
}));

vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(),
  pushContext: vi.fn(),
}));

vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'github:42', name: 'Satya', login: 'satya', source: 'github' })),
}));

vi.mock('../../src/prefs.js', () => ({
  readPrefs: vi.fn(async () => ({})),
  writePrefs: vi.fn(),
  resolveActiveWorkstream: vi.fn(async ({ config }) => config?.activeWorkstream || 'main'),
  resolveDisplayName: vi.fn(async ({ actor, config }) => actor?.name || config?.me || 'unknown'),
}));

import { contributeCore, sourceTrailer } from './contribute.core.js';
import { updateShared } from '../../src/context.js';
import { ManagerGateError } from './review.core.js';
import { readConfig, writeTree, writeQueueItem, appendContribution } from '../../src/storage.js';
import { commitContext } from '../../src/git.js';
import { resolveActor } from '../../src/actor.js';

beforeEach(() => vi.clearAllMocks());

describe('contributeCore — manager gate on apply', () => {
  it('does not honour apply=true from somebody who is not the manager', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    const result = await contributeCore({ text: 'note', author: 'satya', apply: true });

    // Nothing reaches shared context, which is the whole gate.
    expect(result.mode).toBe('queued');
    expect(writeTree).not.toHaveBeenCalled();
  });

  it('keeps their words instead of throwing them away with the call', async () => {
    // It used to throw, and the throw happened before the contribution was
    // logged — so a member whose assistant guessed wrong lost their text and had
    // to write it again. The flag is dropped; the contribution is not.
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    const result = await contributeCore({ text: 'the thing I actually said', author: 'satya', apply: true });

    expect(result.mode).toBe('queued');
    expect(result.applyRefused).toBe(true);
    expect(appendContribution).toHaveBeenCalled();
    expect(appendContribution.mock.calls[0][0].text).toBe('the thing I actually said');
  });

  it('says nothing about apply when it was never asked for', async () => {
    // So `applyRefused` means "you asked and did not get it", not "you are not
    // the manager" — which is every ordinary contribution and not worth saying.
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    const result = await contributeCore({ text: 'note', author: 'satya' });
    expect(result.applyRefused).toBeUndefined();
  });

  it('allows apply=true when the resolved caller is the manager', async () => {
    // The gate reads who the caller actually resolves to (Satya, per the actor
    // mock) — not the `author` they hand us, which is attribution only.
    readConfig.mockReturnValue({ project: 'p', me: 'someone', manager: 'Satya', autoPush: false, roles: [] });
    const result = await contributeCore({ text: 'note', apply: true });
    expect(result.mode).toBe('applied');
    expect(writeTree).toHaveBeenCalled();
    expect(commitContext).toHaveBeenCalled();
  });

  it('allows apply=true when no manager is configured (solo mode)', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', autoPush: false, roles: [] });
    const result = await contributeCore({
      text: 'note', author: 'satya', apply: true,
    });
    expect(result.mode).toBe('applied');
    expect(writeTree).toHaveBeenCalled();
  });

  it('does NOT gate the queued path — anyone can enqueue for approval', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    const result = await contributeCore({
      text: 'note', author: 'satya', apply: false,
    });
    expect(result.mode).toBe('queued');
    expect(writeQueueItem).toHaveBeenCalled();
    expect(writeTree).not.toHaveBeenCalled();
  });
});


describe('contributeCore — attribution', () => {
  it('attributes to the calling actor, not the shared config.me', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note' });
    expect(r.author).toBe('Satya');
    expect(appendContribution).toHaveBeenCalledWith(
      expect.objectContaining({ author: 'Satya', authorKey: 'github:42' }),
      undefined,
    );
  });

  it('still honours an explicit author, and records no key for it', async () => {
    // Scripts and imports pass an author deliberately; that is not a claim
    // about who is calling, so it must not be recorded as an identity.
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note', author: 'importer' });
    expect(r.author).toBe('importer');
    expect(appendContribution).toHaveBeenCalledWith(
      expect.not.objectContaining({ authorKey: expect.anything() }),
      undefined,
    );
  });

  it('falls back to config.me when nothing can identify the caller', async () => {
    resolveActor.mockResolvedValueOnce({ key: 'name:alice', name: 'alice', login: null, source: 'config' });
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note' });
    expect(r.author).toBe('alice');
  });
});


describe('contributeCore — the apply gate ignores the claimed author', () => {
  it('does not honour apply=true on a legacy name gate even when author matches', async () => {
    // The resolved caller is Satya (see the actor mock). Claiming to be the
    // manager must not grant the right to write straight to shared context —
    // anyone can set any display name as their own.
    readConfig.mockReturnValue({ project: 'p', me: 'someone', manager: 'priya', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note', author: 'priya', apply: true });
    expect(r.mode).toBe('queued');
    expect(r.applyRefused).toBe(true);
    expect(writeTree).not.toHaveBeenCalled();
  });

  it('does not honour apply=true on an identity gate the caller is not in', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'someone', managerKey: 'github:9999', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note', apply: true });
    expect(r.mode).toBe('queued');
    expect(r.applyRefused).toBe(true);
    expect(writeTree).not.toHaveBeenCalled();
  });

  it('allows apply=true when the resolved caller is a manager', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'someone', managerKey: 'github:42', autoPush: false, roles: [] });
    const r = await contributeCore({ text: 'note', apply: true });
    expect(r.mode).toBe('applied');
  });
});

describe('provenance reaches the git history', () => {
  it('names the source in the commit body, not the subject', () => {
    // `git log .teamctx/` is the audit trail — it is what `teamctx stats` will
    // walk. A Slack source is far too long for a subject line, and truncating
    // it would destroy the only property worth recording: that you can follow
    // it back to the artifact.
    expect(sourceTrailer('import:slack:C0BPPEJVBV4/p1786543526387459'))
      .toBe('\n\nSource: import:slack:C0BPPEJVBV4/p1786543526387459');
  });

  it('says nothing for a typed contribution', () => {
    // Noting `cli` on every commit would be noise on the common case.
    expect(sourceTrailer('cli')).toBe('');
    expect(sourceTrailer(undefined)).toBe('');
  });

  it('covers every non-default source, not just the one that existed first', () => {
    // Only `mcp` was ever named, so web and imported contributions were
    // indistinguishable from typed ones in the history.
    for (const s of ['mcp', 'web', 'import:docs/plan.md', 'import:slack:C1/p2']) {
      expect(sourceTrailer(s), `${s} should be recorded`).toContain(`Source: ${s}`);
    }
  });

  it('records the source on the queued commit', async () => {
    // Imports go through the queued path, so this is the commit that exists
    // for an imported contribution until a manager approves it.
    readConfig.mockReturnValue({ project: 'p', me: 'alice', autoPush: false, roles: [] });
    await contributeCore({ text: 'note', source: 'import:slack:C1/p2' });
    expect(commitContext).toHaveBeenCalledWith(
      expect.stringContaining('Source: import:slack:C1/p2'),
      undefined,
    );
  });
});

describe('what the AI proposed that did not validate', () => {
  it('reports what was dropped and why, keeps it out of the queue item, and never writes it', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', managerKey: 'github:1', autoPush: false, roles: [], reviewPolicy: 'all' });
    updateShared.mockResolvedValueOnce({
      workstream: { id: 'main', name: 'M', records: [], tasks: [] },
      summary: 's',
      operations: [{ type: 'addTask', title: 'kept' }],
      dropped: [{ op: { type: 'addRecord', record: { type: 'assumption', text: 'no owner' } }, reason: 'owner: must have required property' }],
    });
    const r = await contributeCore({ text: 't' });
    expect(r.mode).toBe('queued');
    expect(r.dropped).toEqual([{ reason: 'owner: must have required property' }]);
    const queued = writeQueueItem.mock.calls.at(-1)[0];
    expect(queued.operations).toEqual([{ type: 'addTask', title: 'kept' }]);
    expect(JSON.stringify(queued.dropped)).not.toContain('no owner');
  });
});
