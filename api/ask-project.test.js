/**
 * The hosted ask page after the project layer.
 *
 * It read `shared`, a compatibility shim that always pointed at the workstream
 * called `main`. That workstream no longer exists, so the page answered every
 * question from an empty tree while the project's own tree sat unread.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/storage.js', () => ({
  readConfig: vi.fn(),
  readRoleFile: vi.fn(() => '# role'),
  readTree: vi.fn(),
  readTreeMd: vi.fn(() => '# md'),
  readProject: vi.fn(),
  readContributions: vi.fn(() => []),
}));
vi.mock('../src/context.js', () => ({ answerQuestion: vi.fn(async () => 'an answer') }));

const { default: handler } = await import('./ask.js');
const { readConfig, readTree, readTreeMd, readProject } = await import('../src/storage.js');
const { answerQuestion } = await import('../src/context.js');

const PROJECT = { name: 'Ledger', whys: [{ id: 'p1', text: 'no new vendors', whats: [] }] };
const WS = { id: 'delivery', name: 'Delivery', whys: [] };

const res = () => {
  const r = { statusCode: 200, body: '', headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};
const post = async (body) => {
  const r = res();
  await handler({ method: 'POST', body }, r);
  return r;
};
const args = () => answerQuestion.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  readConfig.mockReturnValue({
    project: 'Ledger',
    roles: [{ slug: 'lead', name: 'Lead', workstream: 'delivery' }],
  });
  readTree.mockReturnValue(PROJECT);
  readProject.mockReturnValue(PROJECT);
});

describe('a question with no role', () => {
  it('answers from the project tree', async () => {
    await post({ question: 'what are we doing?' });
    expect(readTree).toHaveBeenCalledWith(null);
    expect(args().workstream).toBe(PROJECT);
  });

  it('reads the project page, not a workstream page', async () => {
    await post({ question: 'what are we doing?' });
    expect(readTreeMd).toHaveBeenCalledWith(null);
  });

  it('does not also pass the project as inherited context', async () => {
    await post({ question: 'what are we doing?' });
    expect(args().project).toBe(null);
  });
});

describe('a question asked as a role', () => {
  it('answers from that role\'s workstream with the project above it', async () => {
    readTree.mockReturnValue(WS);
    await post({ question: 'q?', role: 'lead' });
    expect(readTree).toHaveBeenCalledWith('delivery');
    expect(args().project).toBe(PROJECT);
    expect(args().roleMd).toBe('# role');
  });

  it('sends a role that sits at project level to the project', async () => {
    readConfig.mockReturnValue({
      project: 'Ledger', roles: [{ slug: 'ops', name: 'Ops', workstream: null }],
    });
    await post({ question: 'q?', role: 'ops' });
    expect(readTree).toHaveBeenCalledWith(null);
    expect(args().project).toBe(null);
  });
});
