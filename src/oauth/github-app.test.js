/**
 * The GitHub App token helper (#110): reads the App identity from the
 * environment and mints an installation token, with the JWT and caching left to
 * @octokit/auth-app (mocked here — we test the wiring, not the crypto).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authFn = vi.fn(async ({ type, installationId }) => (
  type === 'app' ? { token: 'jwt_for_app' } : { token: `ghs_token_${installationId}`, expiresAt: '2026-01-01T00:00:00Z' }
));
const createAppAuth = vi.fn(() => authFn);
vi.mock('@octokit/auth-app', () => ({ createAppAuth }));

const {
  githubAppFromEnv, githubAppConfigured, githubAppInstallUrl,
  installationTokenFor, appJwt, installationForRepo, _resetAppAuthCache,
} = await import('./github-app.js');

const ENV = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----' };
const ENV_SLUG = { ...ENV, GITHUB_APP_SLUG: 'teamctx-access' };

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
  });

  it('is only "configured" for the UI when the slug is set too', () => {
    // Without the slug the install URL cannot be built, so the App must not be
    // advertised as installable.
    expect(githubAppConfigured(ENV)).toBe(false);
    expect(githubAppConfigured(ENV_SLUG)).toBe(true);
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

  it('rebuilds auth when the private key is rotated under the same App id', async () => {
    await installationTokenFor(1, ENV);
    // Same GITHUB_APP_ID, new key: a stale cached instance would keep signing
    // with the old key and get 401s, so it must be rebuilt.
    await installationTokenFor(1, { ...ENV, GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----\nxyz\n-----END KEY-----' });
    expect(createAppAuth).toHaveBeenCalledTimes(2);
    expect(createAppAuth).toHaveBeenLastCalledWith({ appId: '12345', privateKey: '-----BEGIN KEY-----\nxyz\n-----END KEY-----' });
  });
});

describe('githubAppInstallUrl', () => {
  it('is null without a slug, and carries state through when there is one', () => {
    expect(githubAppInstallUrl('s', ENV)).toBeNull();
    const url = githubAppInstallUrl('nonce-acme-ledger', ENV_SLUG);
    expect(url).toBe('https://github.com/apps/teamctx-access/installations/new?state=nonce-acme-ledger');
  });
});

describe('appJwt', () => {
  it('returns a JWT authenticated as the App, or null when unconfigured', async () => {
    expect(await appJwt({})).toBeNull();
    expect(await appJwt(ENV)).toBe('jwt_for_app');
    expect(authFn).toHaveBeenCalledWith({ type: 'app' });
  });
});

describe('installationForRepo', () => {
  it('returns the installation id GitHub reports for the repo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 808 }) })));
    expect(await installationForRepo('acme', 'ledger', ENV)).toBe(808);
    vi.unstubAllGlobals();
  });

  it('is null when the App is not installed on the repo (404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    expect(await installationForRepo('acme', 'ledger', ENV)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('throws on an unexpected GitHub error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(installationForRepo('acme', 'ledger', ENV)).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });

  it('is null when the App is not configured, making no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await installationForRepo('acme', 'ledger', {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
