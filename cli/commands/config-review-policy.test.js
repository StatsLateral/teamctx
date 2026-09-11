/**
 * The command wrapper, which had no coverage at all — which is how a file that
 * did not parse shipped green. `config.core.js` decides; this prints, and what
 * it prints is the only thing a person ever sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  writeWorkstreamMd: vi.fn(),
  readWorkstream: vi.fn(() => ({ id: 'w', name: 'W', whys: [] })),
  listWorkstreamIds: vi.fn(() => []), readConfig: vi.fn(), writeConfig: vi.fn() }));
vi.mock('./config.core.js', () => ({ setConfig: vi.fn(), setReviewPolicy: vi.fn() }));
vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async () => ({ key: 'github:1001', name: 'Ada' })),
}));
vi.mock('../../src/prefs.js', () => ({
  writePrefs: vi.fn(), resolveDisplayName: vi.fn(async () => 'Ada'),
  resolveIdentity: vi.fn(async () => ({ name: 'Ada', source: 'github' })),
}));
vi.mock('../../src/ai.js', () => ({
  getModelsFor: vi.fn(() => []), getDefaultModelFor: vi.fn(() => 'claude-sonnet-4-6'),
}));

const { configReviewPolicyCommand } = await import('./config.js');
const { readConfig } = await import('../../src/storage.js');
const { setReviewPolicy } = await import('./config.core.js');

let out = [];
let errs = [];
beforeEach(() => {
  vi.clearAllMocks();
  out = []; errs = [];
  vi.spyOn(console, 'log').mockImplementation(m => out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation(m => errs.push(String(m)));
});
afterEach(() => vi.restoreAllMocks());

const printed = () => out.join('\n');

describe('showing the policy', () => {
  it('names the current one and says what it means in plain words', async () => {
    readConfig.mockReturnValue({ project: 'p', reviewPolicy: 'additive' });
    await configReviewPolicyCommand();
    expect(printed()).toContain('Review policy: additive');
    expect(printed()).toContain('additions land; edits and deletes wait for you');
    expect(setReviewPolicy).not.toHaveBeenCalled();
  });

  it('reports "all" for a project that has never set one', async () => {
    readConfig.mockReturnValue({ project: 'p' });
    await configReviewPolicyCommand();
    expect(printed()).toContain('Review policy: all');
  });

  it('lists every option, and marks the one in force', async () => {
    readConfig.mockReturnValue({ project: 'p', reviewPolicy: 'none' });
    await configReviewPolicyCommand();
    ['all', 'additive', 'none'].forEach(p => expect(printed()).toContain(p));
    expect(printed()).toMatch(/none\s+everything lands immediately\s*←/);
  });

  it('says it is the manager\'s to change, since reading it is not', async () => {
    readConfig.mockReturnValue({ project: 'p' });
    await configReviewPolicyCommand();
    expect(printed()).toContain('manager only');
  });

  it('renders real line breaks, not the characters backslash-n', async () => {
    // The break that shipped was in exactly these strings.
    readConfig.mockReturnValue({ project: 'p' });
    await configReviewPolicyCommand();
    expect(printed()).not.toContain('\\n');
  });
});

describe('setting the policy', () => {
  it('confirms the change and what it was', async () => {
    setReviewPolicy.mockResolvedValue({ from: 'all', to: 'additive' });
    await configReviewPolicyCommand('additive');
    expect(setReviewPolicy).toHaveBeenCalledWith('additive');
    expect(printed()).toContain('Review policy set to additive');
    expect(printed()).toContain('was: all');
  });

  it('tells the reader to push, since everyone else reads it from the repo', async () => {
    setReviewPolicy.mockResolvedValue({ from: 'all', to: 'none' });
    await configReviewPolicyCommand('none');
    expect(printed()).toContain('.teamctx/config.json');
  });

  it('says nothing changed rather than claiming a change', async () => {
    setReviewPolicy.mockResolvedValue({ from: 'additive', to: 'additive' });
    await configReviewPolicyCommand('additive');
    expect(printed()).toContain('already additive');
    expect(printed()).not.toContain('was:');
  });

  it('prints the refusal and exits non-zero when it is not your call', async () => {
    setReviewPolicy.mockRejectedValue(new Error('only the configured manager (github:1001) may approve or reject.'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    await configReviewPolicyCommand('none');
    expect(errs.join('\n')).toContain('only the configured manager');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
