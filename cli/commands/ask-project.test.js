/**
 * Asking a question at project level.
 *
 * `ask` read the caller's target as a workstream. At project level that found
 * nothing, so a project with a full tree answered "there is no Why/What/How
 * here yet" — the context was present and the one command meant to read it
 * could not see it. The same read is what gives a workstream the project above
 * its own answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  readConfig: vi.fn(),
  readRoleFile: vi.fn(() => '# role'),
  readTree: vi.fn(),
  readTreeMd: vi.fn(() => '# md'),
  readProject: vi.fn(),
  readContributions: vi.fn(() => []),
  listTasks: vi.fn(() => []),
}));
vi.mock('../../src/context.js', () => ({ answerQuestion: vi.fn(async () => 'an answer') }));
vi.mock('../identity.js', () => ({ currentIdentity: vi.fn(async () => ({ activeWorkstream: null })) }));

const { askCommand } = await import('./ask.js');
const { readConfig, readTree, readTreeMd, readProject, listTasks } = await import('../../src/storage.js');
const { answerQuestion } = await import('../../src/context.js');
const { currentIdentity } = await import('../identity.js');

const PROJECT = { name: 'Ledger', whys: [{ id: 'p1', text: 'no new vendors', whats: [] }] };
const WS = { id: 'delivery', name: 'Delivery', whys: [{ id: 'w1', text: 'ship it', whats: [] }] };

const args = () => answerQuestion.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  readConfig.mockReturnValue({
    project: 'Ledger',
    roles: [{ slug: 'lead', workstream: 'delivery' }, { slug: 'ops', workstream: null }],
  });
  readTree.mockReturnValue(PROJECT);
  readProject.mockReturnValue(PROJECT);
  currentIdentity.mockResolvedValue({ activeWorkstream: null });
});

describe('at project level', () => {
  it('reads the project tree instead of a workstream named null', async () => {
    await askCommand('what are we doing?', {});
    expect(readTree).toHaveBeenCalledWith(null);
    expect(args().workstream).toBe(PROJECT);
  });

  it('reads the project page as the compiled half', async () => {
    await askCommand('what are we doing?', {});
    expect(readTreeMd).toHaveBeenCalledWith(null);
  });

  it('does not pass the project as inherited context as well', async () => {
    // It is already the tree being answered from; passing it twice would put
    // every Why in the prompt twice.
    await askCommand('what are we doing?', {});
    expect(args().project).toBe(null);
  });

  it('scopes open tasks to project level rather than to no workstream', async () => {
    await askCommand('what are we doing?', {});
    expect(listTasks).toHaveBeenCalledWith({ workstream: null });
  });

  it('treats an explicit "main" as the project, since main is gone', async () => {
    await askCommand('what are we doing?', { workstream: 'main' });
    expect(readTree).toHaveBeenCalledWith(null);
  });
});

describe('inside a workstream', () => {
  beforeEach(() => {
    currentIdentity.mockResolvedValue({ activeWorkstream: 'delivery' });
    readTree.mockReturnValue(WS);
  });

  it('answers from that workstream with the project above it', async () => {
    await askCommand('what are we doing?', {});
    expect(readTree).toHaveBeenCalledWith('delivery');
    expect(args().workstream).toBe(WS);
    expect(args().project).toBe(PROJECT);
  });

  it('follows the role to its workstream', async () => {
    currentIdentity.mockResolvedValue({ activeWorkstream: null });
    await askCommand('what are we doing?', { role: 'lead' });
    expect(readTree).toHaveBeenCalledWith('delivery');
    expect(args().roleMd).toBe('# role');
  });

  it('sends a project-level role to the project, not to main', async () => {
    currentIdentity.mockResolvedValue({ activeWorkstream: 'delivery' });
    await askCommand('what are we doing?', { role: 'ops' });
    expect(readTree).toHaveBeenCalledWith(null);
    expect(args().project).toBe(null);
  });
});
