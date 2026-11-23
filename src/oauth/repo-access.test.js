/**
 * Resolving a project's lent credential (#110): a GitHub App installation is
 * preferred, a legacy lent OAuth token is the fallback, and a failed mint does
 * not quietly drop to the broader legacy token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvStore = new Map();
const kvGet = vi.fn(async (key) => (kvStore.has(key) ? kvStore.get(key) : null));
vi.mock('./kv.js', () => ({
  kvGet,
  keys: {
    projectInstallation: (o, r) => `install:${o}/${r}`,
    projectGhCred: (o, r) => `cred:${o}/${r}`,
  },
}));
const installationTokenFor = vi.fn(async (id) => (id === 'bad' ? null : `ghs_${id}`));
vi.mock('./github-app.js', () => ({ installationTokenFor }));

const { projectRepoCredential, projectRepoToken, projectLendsAccess } = await import('./repo-access.js');

beforeEach(() => {
  kvStore.clear();
  vi.clearAllMocks();
});

describe('projectRepoCredential', () => {
  it('prefers a GitHub App installation, minting a fresh token', async () => {
    kvStore.set('install:acme/ledger', { installationId: 77, installedByEmail: 'm@x' });
    kvStore.set('cred:acme/ledger', { token: 'legacy' }); // present, but not used
    const cred = await projectRepoCredential('acme', 'ledger');
    expect(cred).toMatchObject({ token: 'ghs_77', via: 'installation' });
    // Scoped to this repo, so an "all repositories" install still mints a token
    // that reaches only this one.
    expect(installationTokenFor).toHaveBeenCalledWith(77, expect.anything(), ['ledger']);
  });

  it('falls back to the legacy lent token when there is no installation', async () => {
    kvStore.set('cred:acme/ledger', { token: 'legacy' });
    const cred = await projectRepoCredential('acme', 'ledger');
    expect(cred).toMatchObject({ token: 'legacy', via: 'lent' });
    expect(installationTokenFor).not.toHaveBeenCalled();
  });

  it('does not fall back to the broader legacy token when the install mint returns nothing', async () => {
    kvStore.set('install:acme/ledger', { installationId: 'bad' });
    kvStore.set('cred:acme/ledger', { token: 'legacy' });
    // A removed install must read as no access, not silently widen to the lent token.
    expect(await projectRepoCredential('acme', 'ledger')).toBeNull();
  });

  it('fails closed when minting throws — an uninstalled app cuts access', async () => {
    installationTokenFor.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    kvStore.set('install:acme/ledger', { installationId: 55 });
    kvStore.set('cred:acme/ledger', { token: 'legacy' });
    expect(await projectRepoCredential('acme', 'ledger')).toBeNull();
  });

  it('is null when a project lends nothing', async () => {
    expect(await projectRepoCredential('acme', 'ledger')).toBeNull();
    expect(await projectRepoToken('acme', 'ledger')).toBeNull();
  });
});

describe('projectLendsAccess', () => {
  it('is true for an installation or a legacy token, without minting', async () => {
    kvStore.set('install:a/b', { installationId: 9 });
    expect(await projectLendsAccess('a', 'b')).toBe(true);
    expect(installationTokenFor).not.toHaveBeenCalled();
    kvStore.clear();
    kvStore.set('cred:a/b', { token: 't' });
    expect(await projectLendsAccess('a', 'b')).toBe(true);
    kvStore.clear();
    expect(await projectLendsAccess('a', 'b')).toBe(false);
  });
});
