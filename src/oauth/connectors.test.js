import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, __resetSecrets, __dumpMemory, kvGet, keys } from './kv.js';
import {
  readConnection, writeConnection, removeConnection, connectionsFor, pickConnection,
} from './connectors.js';

beforeEach(() => { __resetMemory(); __resetSecrets(); });

describe('a person\'s own connection', () => {
  it('reads back what was written', async () => {
    await writeConnection({ email: 'Priya@Acme.com', provider: 'gdrive', accessToken: 'at-1', refreshToken: 'rt-1', account: 'priya@acme.com' });
    const rec = await readConnection({ email: 'priya@acme.com', provider: 'gdrive' });
    expect(rec).toMatchObject({ provider: 'gdrive', accessToken: 'at-1', refreshToken: 'rt-1', account: 'priya@acme.com' });
    expect(rec.connectedAt).toBeTruthy();
  });

  it('is keyed by email case-insensitively', async () => {
    await writeConnection({ email: 'priya@acme.com', provider: 'gdrive', accessToken: 'at-1' });
    expect(await readConnection({ email: 'PRIYA@ACME.COM', provider: 'gdrive' })).toMatchObject({ accessToken: 'at-1' });
  });

  it('keeps one record per provider and lists them in the index', async () => {
    await writeConnection({ email: 'p@a.com', provider: 'gdrive', accessToken: 'g' });
    await writeConnection({ email: 'p@a.com', provider: 'dropbox', accessToken: 'd' });
    expect((await connectionsFor('p@a.com')).sort()).toEqual(['dropbox', 'gdrive']);
  });

  it('overwrites in place on reconnect, without duplicating the index entry', async () => {
    await writeConnection({ email: 'p@a.com', provider: 'gdrive', accessToken: 'old' });
    await writeConnection({ email: 'p@a.com', provider: 'gdrive', accessToken: 'new', refreshToken: 'r2' });
    expect(await readConnection({ email: 'p@a.com', provider: 'gdrive' })).toMatchObject({ accessToken: 'new', refreshToken: 'r2' });
    expect(await connectionsFor('p@a.com')).toEqual(['gdrive']);
  });

  it('stores the token encrypted at rest, never in the clear', async () => {
    await writeConnection({ email: 'p@a.com', provider: 'gdrive', accessToken: 'SUPERSECRET-TOKEN', refreshToken: 'SECRET-REFRESH' });
    const dump = __dumpMemory();
    expect(dump).not.toContain('SUPERSECRET-TOKEN');
    expect(dump).not.toContain('SECRET-REFRESH');
    // …yet reads back.
    expect((await readConnection({ email: 'p@a.com', provider: 'gdrive' })).accessToken).toBe('SUPERSECRET-TOKEN');
  });

  it('refuses to write without the parts it needs', async () => {
    await expect(writeConnection({ provider: 'gdrive', accessToken: 'x' })).rejects.toThrow(/email/);
    await expect(writeConnection({ email: 'p@a.com', accessToken: 'x' })).rejects.toThrow(/provider/);
    await expect(writeConnection({ email: 'p@a.com', provider: 'gdrive' })).rejects.toThrow(/access token/);
  });
});

describe('removing a connection', () => {
  it('drops the record and the index entry, and reports it was there', async () => {
    await writeConnection({ email: 'p@a.com', provider: 'gdrive', accessToken: 'g' });
    expect(await removeConnection({ email: 'p@a.com', provider: 'gdrive' })).toBe(true);
    expect(await readConnection({ email: 'p@a.com', provider: 'gdrive' })).toBeNull();
    expect(await connectionsFor('p@a.com')).toEqual([]);
    // the cleared record leaves nothing readable
    expect(await kvGet(keys.connectorToken('p@a.com', 'gdrive'))).toBeNull();
  });

  it('reports false when there was nothing to remove', async () => {
    expect(await removeConnection({ email: 'p@a.com', provider: 'gdrive' })).toBe(false);
  });
});

describe('which connection a read runs on', () => {
  it('uses the member\'s own connection when they have one', async () => {
    await writeConnection({ email: 'member@a.com', provider: 'gdrive', accessToken: 'mine' });
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    const r = await pickConnection({ email: 'member@a.com', provider: 'gdrive', primaryEmail: 'boss@a.com' });
    expect(r).toMatchObject({ accessToken: 'mine', via: 'own' });
  });

  it('falls back to the primary manager\'s connection when the member has none', async () => {
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    const r = await pickConnection({ email: 'member@a.com', provider: 'gdrive', primaryEmail: 'boss@a.com' });
    expect(r).toMatchObject({ accessToken: 'boss', via: 'project' });
  });

  it('returns null when neither the member nor the manager has connected', async () => {
    expect(await pickConnection({ email: 'member@a.com', provider: 'gdrive', primaryEmail: 'boss@a.com' })).toBeNull();
  });

  it('considers only the member when no primary manager is given', async () => {
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    expect(await pickConnection({ email: 'member@a.com', provider: 'gdrive' })).toBeNull();
  });

  it('does not double-count when the member is the primary manager', async () => {
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    const r = await pickConnection({ email: 'boss@a.com', provider: 'gdrive', primaryEmail: 'boss@a.com' });
    expect(r).toMatchObject({ accessToken: 'boss', via: 'own' });
  });
});
