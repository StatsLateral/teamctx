/**
 * The GitHub App token helper (#110): reads the App identity from the
 * environment and mints an installation token, with the JWT and caching left to
 * @octokit/auth-app (mocked here — we test the wiring, not the crypto).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authFn = vi.fn(async ({ installationId }) => ({ token: `ghs_token_${installationId}`, expiresAt: '2026-01-01T00:00:00Z' }));
const createAppAuth = vi.fn(() => authFn);
vi.mock('@octokit/auth-app', () => ({ createAppAuth }));

const { githubAppFromEnv, githubAppConfigured, installationTokenFor, _resetAppAuthCache } = await import('./github-app.js');

const ENV = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----' };

beforeEach(() => {
  vi.clearAllMocks();
  _resetAppAuthCache();
});

describe('githubAppFromEnv', () => {
  it('is null when the App is not configured', () => {
    expect(githubAppFromEnv({})).toBeNull();
    expect(githubAppFromEnv({ GITHUB_APP_ID: '1' })).toBeNull();
    expect(githubAppConfigured({})).toBe(false);
  });

  it('reads the id and key, and restores a key whose newlines were escaped', () => {
    const app = githubAppFromEnv({ GITHUB_APP_ID: 7, GITHUB_APP_PRIVATE_KEY: 'line1\\nline2' });
    expect(app).toEqual({ appId: '7', privateKey: 'line1\nline2' });
    expect(githubAppConfigured(ENV)).toBe(true);
  });

  it('leaves a key that already has real newlines alone', () => {
    expect(githubAppFromEnv(ENV).privateKey).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----');
  });
});

describe('installationTokenFor', () => {
  it('returns null when the App is not configured', async () => {
    expect(await installationTokenFor(42, {})).toBeNull();
    expect(createAppAuth).not.toHaveBeenCalled();
  });

  it('returns null for a missing installation id', async () => {
    expect(await installationTokenFor(null, ENV)).toBeNull();
  });

  it('mints a token for the installation, building auth from the App identity', async () => {
    const token = await installationTokenFor('99', ENV);
    expect(token).toBe('ghs_token_99');
    expect(createAppAuth).toHaveBeenCalledWith({ appId: '12345', privateKey: ENV.GITHUB_APP_PRIVATE_KEY });
    expect(authFn).toHaveBeenCalledWith({ type: 'installation', installationId: 99 });
  });

  it('reuses one auth instance across calls, so the library can cache', async () => {
    await installationTokenFor(1, ENV);
    await installationTokenFor(2, ENV);
    expect(createAppAuth).toHaveBeenCalledTimes(1);
    expect(authFn).toHaveBeenCalledTimes(2);
  });
});
