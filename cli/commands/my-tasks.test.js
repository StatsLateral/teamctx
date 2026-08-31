import { describe, it, expect } from 'vitest';
import { listTasksFiltered, MineAndOwnerError } from './task.core.js';

/**
 * "What are my tasks?" — the first thing a member asks, and the one question
 * `list_tasks` could not answer without being told what this project calls them.
 *
 * Storage is stubbed to a fixed list so these are about the filter, not about
 * reading a repo.
 */
import { vi } from 'vitest';
vi.mock('../../src/storage.js', () => ({ listTasks: vi.fn() }));
const { listTasks } = await import('../../src/storage.js');

const ADA_KEY = 'git:ada@example.com';

const TASKS = [
  // Raised by Ada from her clone, before she renamed herself.
  { id: 't-own', owner: 'Ada', ownerKey: ADA_KEY, status: 'open', workstream: 'main' },
  // Raised on another surface, where she resolves to a different display name.
  { id: 't-hosted', owner: 'Ada Lovelace', ownerKey: ADA_KEY, status: 'open', workstream: 'main' },
  // Assigned to her by name before keys existed — no key to match on.
  { id: 't-legacy', owner: 'Ada', status: 'open', workstream: 'main' },
  // Somebody else's.
  { id: 't-mia', owner: 'Mia', status: 'open', workstream: 'main' },
];

const ask = (opts) => {
  listTasks.mockReturnValue(TASKS);
  return listTasksFiltered({ me: 'Ada', myKey: ADA_KEY, ...opts }).tasks.map(t => t.id);
};

describe('asking for your own tasks', () => {
  it('finds the ones raised as yours', () => {
    expect(ask({ mine: true })).toContain('t-own');
  });

  it('still finds them after you change your display name', () => {
    // `teamctx config name` is a supported command; matching a name alone means
    // a member's own work stops being theirs the moment they use it.
    expect(listTasksFiltered({ mine: true, me: 'Ada Lovelace', myKey: ADA_KEY }).tasks.map(t => t.id))
      .toContain('t-own');
  });

  it('finds a task raised on a different surface', () => {
    // The same person is a different display name from a clone and from a chat
    // client, which is what makes the key rather than the name the answer.
    expect(ask({ mine: true })).toContain('t-hosted');
  });

  it('still finds a task that predates the key, by name', () => {
    // No existing task carries a key, and they must not all stop being anyone's.
    expect(ask({ mine: true })).toContain('t-legacy');
  });

  it("leaves out somebody else's", () => {
    expect(ask({ mine: true })).not.toContain('t-mia');
  });

  it('does not claim a task assigned to a name that is not yours', () => {
    expect(listTasksFiltered({ mine: true, me: 'Mia', myKey: 'git:mia@example.com' }).tasks.map(t => t.id))
      .toEqual(['t-mia']);
  });

  it('refuses mine and owner together rather than guessing', () => {
    // They are two ways to ask the same question; silently ranking one over the
    // other is how a caller ends up trusting an empty list.
    listTasks.mockReturnValue(TASKS);
    expect(() => listTasksFiltered({ mine: true, owner: 'Mia', me: 'Ada', myKey: ADA_KEY }))
      .toThrow(MineAndOwnerError);
  });

  it('still filters by owner when mine was not asked for', () => {
    expect(ask({ owner: 'Mia' })).toEqual(['t-mia']);
  });

  it('returns everything when neither was asked for', () => {
    expect(ask({})).toHaveLength(4);
  });
});
