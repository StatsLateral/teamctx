import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/storage.js', () => ({
  getTeamctxDir: vi.fn(() => '/fake/.teamctx'),
  writeConfig: vi.fn(),
  writeWorkstream: vi.fn(),
  writeWorkstreamMd: vi.fn(),
  readConfig: vi.fn(() => ({})),
  configExists: vi.fn(() => false),
}));
vi.mock('../../src/git.js', () => ({
  checkGitRepo: vi.fn(), commitContext: vi.fn(), pushContext: vi.fn(),
}));
vi.mock('../../src/ai.js', () => ({
  getModelsFor: vi.fn(() => []), getDefaultModelFor: vi.fn(() => 'claude-sonnet-4-6'),
}));
vi.mock('../../src/context.js', () => ({ serializeToMd: vi.fn(() => '# md') }));
vi.mock('../../src/prefs.js', () => ({ writePrefs: vi.fn() }));
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false), mkdirSync: vi.fn(),
  writeFileSync: vi.fn(), readFileSync: vi.fn(() => ''),
}));
vi.mock('../../src/session-context.js', () => ({ getCurrentSession: vi.fn(() => null) }));
// No ambient actor — which is exactly the web flow's situation.
vi.mock('../../src/actor.js', () => ({
  resolveActor: vi.fn(async ({ config }) => ({
    key: `name:${config?.me || 'unknown'}`, name: config?.me || 'unknown', login: null, source: 'config',
  })),
}));

const { initProject } = await import('./init.core.js');

beforeEach(() => vi.clearAllMocks());

describe('the gate a new project is born with', () => {
  it('refuses a display-name identity rather than writing an unusable gate', async () => {
    // The web flow runs init inside a session but with no ambient actor, so the
    // caller resolved to `name:<display name>` — a key the hosted server
    // (`github:<id>`) and a Google sign-in (`git:<email>`) can never present.
    // The project was born with a gate its own creator could not pass.
    await expect(initProject({ projectDir: '/fake', project: 'P', me: 'Ada' }))
      .rejects.toThrow(/no stable identity/i);
  });

  it('takes the identity it is given', async () => {
    const r = await initProject({
      projectDir: '/fake', project: 'P', me: 'Ada',
      managerKey: 'git:ada@example.com',
    });
    expect(r.config.managerKey).toBe('git:ada@example.com');
  });

  it('prefers an email, which every surface can present', async () => {
    // A clone reads it from git config, Google hands it over verified, and a
    // GitHub token reveals it with the user:email scope. `github:<id>` is only
    // presentable on one of the three.
    const r = await initProject({
      projectDir: '/fake', project: 'P', me: 'Ada',
      managerKey: 'git:ada@example.com',
    });
    expect(r.config.managerKey.startsWith('git:')).toBe(true);
  });
});
