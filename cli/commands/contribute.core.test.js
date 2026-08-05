import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'main', name: 'M', whys: [] })),
  writeWorkstream: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  appendContribution: vi.fn(),
  writeRoleFile: vi.fn(),
  writeQueueItem: vi.fn(),
  readContributions: vi.fn(() => []),
  listWorkstreamIds: vi.fn(() => ['main']),
}));

vi.mock('../../src/context.js', () => ({
  updateShared: vi.fn(async () => ({
    workstream: { id: 'main', name: 'M', whys: [{ id: 'w1', text: 'x' }] },
    summary: 's',
    operations: [{ type: 'addWhy', text: 'x' }],
  })),
  generateRoleFile: vi.fn(() => Promise.resolve('# role md')),
  serializeToMd: vi.fn(() => '# md'),
}));

vi.mock('../../src/git.js', () => ({
  commitContext: vi.fn(),
  pushContext: vi.fn(),
}));

import { contributeCore } from './contribute.core.js';
import { ManagerGateError } from './review.core.js';
import { readConfig, writeWorkstream, writeQueueItem } from '../../src/storage.js';
import { commitContext } from '../../src/git.js';

beforeEach(() => vi.clearAllMocks());

describe('contributeCore — manager gate on apply', () => {
  it('refuses apply=true when caller is not the configured manager', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    await expect(contributeCore({
      text: 'note', author: 'satya', apply: true,
    })).rejects.toBeInstanceOf(ManagerGateError);
    expect(writeWorkstream).not.toHaveBeenCalled();
    expect(commitContext).not.toHaveBeenCalled();
  });

  it('allows apply=true when caller matches the configured manager', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'priya', manager: 'priya', autoPush: false, roles: [] });
    const result = await contributeCore({
      text: 'note', author: 'priya', apply: true,
    });
    expect(result.mode).toBe('applied');
    expect(writeWorkstream).toHaveBeenCalled();
    expect(commitContext).toHaveBeenCalled();
  });

  it('allows apply=true when no manager is configured (solo mode)', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', autoPush: false, roles: [] });
    const result = await contributeCore({
      text: 'note', author: 'satya', apply: true,
    });
    expect(result.mode).toBe('applied');
    expect(writeWorkstream).toHaveBeenCalled();
  });

  it('does NOT gate the queued path — anyone can enqueue for approval', async () => {
    readConfig.mockReturnValue({ project: 'p', me: 'satya', manager: 'priya', autoPush: false, roles: [] });
    const result = await contributeCore({
      text: 'note', author: 'satya', apply: false,
    });
    expect(result.mode).toBe('queued');
    expect(writeQueueItem).toHaveBeenCalled();
    expect(writeWorkstream).not.toHaveBeenCalled();
  });
});
