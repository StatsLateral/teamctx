import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('./review.core.js', () => ({
  listPendingReviews: vi.fn(), approveReview: vi.fn(), rejectReview: vi.fn(),
  ManagerGateError: class extends Error {}, QueueItemNotFoundError: class extends Error {},
}));
import { listPendingReviews, approveReview } from './review.core.js';
import { reviewListCommand, reviewApproveCommand } from './review.js';

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('CLI contradiction review', () => {
  it('prints both full statements even when the queue summary column is truncated', async () => {
    listPendingReviews.mockResolvedValue([{
      id: 'q-1', author: 'Priya', summary: 's'.repeat(90), operations: [{}],
      contradictions: [{ operationIndex: 0, proposedText: 'The entry offer is an AI-readiness assessment', record: { type: 'decision', text: 'The entry offer is a pricing audit' } }],
    }]);
    await reviewListCommand();
    const output = console.log.mock.calls.flat().join('\n');
    expect(output).toContain("Contradicts 'We decided: The entry offer is a pricing audit'");
    expect(output).toContain("proposed: 'The entry offer is an AI-readiness assessment'");
  });

  it('forwards repeatable --replaces selections while retaining the ordinary approval call', async () => {
    approveReview.mockResolvedValue({ rolesRegenerated: [], pushed: false, pushError: null });
    await reviewApproveCommand('q-1', { replaces: ['D-1', 'R-2'] });
    expect(approveReview).toHaveBeenLastCalledWith({ id: 'q-1', replaces: ['D-1', 'R-2'] });
    await reviewApproveCommand('q-2');
    expect(approveReview).toHaveBeenLastCalledWith({ id: 'q-2' });
  });
});
