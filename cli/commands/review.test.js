import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readTree: vi.fn(() => ({ id: 'main', name: 'M', whys: [] })),
  writeTree: vi.fn(),
  readTreeMd: vi.fn(() => ''),
  writeTreeMd: vi.fn(),
  readProject: vi.fn(() => ({ name: '', whys: [] })),
  readConfig: vi.fn(),
  readWorkstream: vi.fn(),
  writeTree: vi.fn(),
  writeTreeMd: vi.fn(),
  writeRoleFile: vi.fn(),
  listQueue: vi.fn(),
  readQueueItem: vi.fn(),
  deleteQueueItem: vi.fn(),
  writeRejected: vi.fn(),
  readContributions: vi.fn(() => []),
}));

vi.mock('../../src/context.js', () => ({
  serializeToMd: vi.fn(() => '# md'),
  generateRoleFile: vi.fn(() => Promise.resolve('# role md')),
}));

vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(),
  pushContext: vi.fn(),
}));

import { reviewApproveCommand } from './review.js';
import {
  readConfig, readWorkstream, writeTree, writeTreeMd,
  writeRoleFile, readQueueItem, deleteQueueItem, readContributions, readTree,
} from '../../src/storage.js';
import { generateRoleFile, serializeToMd } from '../../src/context.js';
import { commitContext } from '../../src/git.js';

beforeEach(() => vi.clearAllMocks());

describe('reviewApproveCommand — workstream-aware', () => {
  const twoWsConfig = {
    project: 'p', me: 'satya', roles: [
      { slug: 'engineer', name: 'Backend', workstream: 'tech' },
      { slug: 'marketer', name: 'GTM', workstream: 'growth' },
    ],
    workstreams: [
      { id: 'main', name: 'p' },
      { id: 'tech', name: 'Tech' },
      { id: 'growth', name: 'Growth' },
    ],
    autoPush: false,
  };

  it('applies operations to the queue item\'s target workstream (not main)', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    readQueueItem.mockReturnValue({
      id: 'c-1', workstream: 'tech', author: 'satya', tagged: null,
      operations: [{ type: 'addWhy', text: 'New tech Why', summary: 's' }],
    });
    readWorkstream.mockReturnValue({ id: 'tech', name: 'Tech', whys: [] });

    await reviewApproveCommand('c-1');

    expect(readTree.mock.calls[0][0]).toBe('tech');
    const [wsIdArg, wsObjArg] = writeTree.mock.calls[0];
    expect(wsIdArg).toBe('tech');
    expect(wsObjArg.whys).toHaveLength(1);
    expect(wsObjArg.whys[0].text).toBe('New tech Why');
    expect(writeTreeMd.mock.calls[0][0]).toBe('tech');
  });

  it('regenerates only role files bound to the target workstream', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    readQueueItem.mockReturnValue({
      id: 'c-2', workstream: 'tech', author: 'satya', tagged: null,
      operations: [{ type: 'addWhy', text: 'x', summary: 's' }],
    });
    readWorkstream.mockReturnValue({ id: 'tech', name: 'Tech', whys: [] });

    await reviewApproveCommand('c-2');

    const regeneratedSlugs = writeRoleFile.mock.calls.map(c => c[0]);
    expect(regeneratedSlugs).toEqual(['engineer']);
    expect(regeneratedSlugs).not.toContain('marketer');
  });

  it('threads the contributions list into serializeToMd and generateRoleFile', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    readQueueItem.mockReturnValue({
      id: 'c-3', workstream: 'tech', author: 'satya', tagged: 'decision',
      operations: [{ type: 'addWhy', text: 'y', summary: 's' }],
    });
    readWorkstream.mockReturnValue({ id: 'tech', name: 'Tech', whys: [] });
    const fakeContribs = [{ id: 'c-3', author: 'satya', ts: '2026-07-21', tagged: 'decision' }];
    readContributions.mockReturnValue(fakeContribs);

    await reviewApproveCommand('c-3');

    // The trailing options carry the inherited project tree, so a role file
    // regenerated on approval shows the project context above the workstream's.
    expect(serializeToMd).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), 'satya', fakeContribs, expect.objectContaining({ project: expect.anything() }));
    expect(generateRoleFile).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'p', twoWsConfig, fakeContribs, expect.objectContaining({ project: expect.anything() }));
  });

  it('applies a queue item with no workstream to the project', async () => {
    // Legacy items and project-level ones look the same on the queue: neither
    // names a workstream. Defaulting to `main` would send both to a file that
    // no longer exists, losing the contribution at the last step.
    readConfig.mockReturnValue(twoWsConfig);
    readQueueItem.mockReturnValue({
      id: 'c-legacy', author: 'satya', tagged: null,
      operations: [{ type: 'addWhy', text: 'legacy', summary: 's' }],
    });
    readTree.mockReturnValue({ name: 'p', whys: [] });

    await reviewApproveCommand('c-legacy');

    expect(readTree.mock.calls[0][0]).toBe(null);
    expect(writeTree.mock.calls[0][0]).toBe(null);
  });

  it('deletes the queue item and commits with a workstream tag', async () => {
    readConfig.mockReturnValue(twoWsConfig);
    readQueueItem.mockReturnValue({
      id: 'c-4', workstream: 'tech', author: 'satya', tagged: 'decision',
      operations: [{ type: 'addWhy', text: 'z', summary: 's' }],
    });
    readWorkstream.mockReturnValue({ id: 'tech', name: 'Tech', whys: [] });

    await reviewApproveCommand('c-4');

    expect(deleteQueueItem.mock.calls[0][0]).toBe('c-4');
    const commitMsg = commitContext.mock.calls[0][0];
    expect(commitMsg).toContain('[decision]');
    expect(commitMsg).toContain('(tech)');
  });
});
