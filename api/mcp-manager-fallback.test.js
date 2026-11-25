/**
 * The hosted staleness route (#248) uses a manager's shared cloud connection as
 * the fallback for a member who has not connected one of their own. `managersOf`
 * gives a manager *key* (`git:<email>` / `github:<id>`), but a connection is
 * matched by address — so the route resolves the key to an address before it
 * reaches `pickConnection`. Passing the raw key never matched; this guards that.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const { managerFallbackEmail } = await import('./mcp/[owner]/[repo].js');
const { writeConnection, shareConnection, pickConnection } = await import('../src/oauth/connectors.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const MAYA = 'maya@example.com';
const PRIYA = 'priya@example.com';
const CONFIG = { managerKey: `git:${MAYA}` };

describe('managerFallbackEmail — a manager key becomes the address a connection is matched by', () => {
  it('resolves a git: key to its email', () => {
    expect(managerFallbackEmail({ managerKey: 'git:maya@example.com' })).toBe('maya@example.com');
  });
  it('is null for a github: key, which carries no address here', () => {
    expect(managerFallbackEmail({ managerKey: 'github:1001' })).toBeNull();
  });
  it('is null when there is no manager', () => {
    expect(managerFallbackEmail({})).toBeNull();
    expect(managerFallbackEmail(null)).toBeNull();
  });
});

describe('the shared-connection fallback, through the resolved address', () => {
  beforeEach(() => __resetMemory());

  async function managerConnectsAndShares() {
    await writeConnection({ email: MAYA, provider: 'gdrive', accessToken: 'a', refreshToken: 'r', account: MAYA });
    await shareConnection({ owner: 'o', repo: 'r', email: MAYA, provider: 'gdrive' });
  }

  it("finds the manager's shared connection for a member who has none of their own", async () => {
    await managerConnectsAndShares();
    const conn = await pickConnection({
      email: PRIYA, provider: 'gdrive', owner: 'o', repo: 'r',
      primaryEmail: managerFallbackEmail(CONFIG),
    });
    expect(conn?.via).toBe('project');
    expect(conn?.account).toBe(MAYA);
  });

  it('would not find it if the raw manager key were used (the bug this fixes)', async () => {
    await managerConnectsAndShares();
    const withRawKey = await pickConnection({
      email: PRIYA, provider: 'gdrive', owner: 'o', repo: 'r',
      primaryEmail: CONFIG.managerKey, // 'git:maya@example.com' — an address, not
    });
    expect(withRawKey).toBeNull();
  });
});
