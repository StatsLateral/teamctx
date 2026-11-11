import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, __resetSecrets, __dumpMemory, kvGet, keys } from './kv.js';
import {
  readConnection, writeConnection, removeConnection, connectionsFor, pickConnection,
  shareConnection, unshareConnection, connectionSharedWith, connectorSharesBy,
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

describe('sharing a connection with a project', () => {
  it('records the share and lists it, idempotently', async () => {
    await shareConnection({ owner: 'o', repo: 'r', email: 'Boss@A.com', provider: 'gdrive' });
    await shareConnection({ owner: 'o', repo: 'r', email: 'boss@a.com', provider: 'gdrive' }); // again
    expect(await connectionSharedWith({ owner: 'o', repo: 'r', email: 'boss@a.com', provider: 'gdrive' })).toBe(true);
    expect(await connectorSharesBy('boss@a.com')).toEqual([{ slug: 'o/r', provider: 'gdrive' }]);
  });

  it('keeps shares separate per project and per provider', async () => {
    await shareConnection({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'gdrive' });
    await shareConnection({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'dropbox' });
    await shareConnection({ owner: 'o', repo: 's', email: 'b@a.com', provider: 'gdrive' });
    expect(await connectionSharedWith({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'dropbox' })).toBe(true);
    expect(await connectionSharedWith({ owner: 'o', repo: 's', email: 'b@a.com', provider: 'dropbox' })).toBe(false);
    expect((await connectorSharesBy('b@a.com')).length).toBe(3);
  });

  it('unshares one project+provider without touching the others', async () => {
    await shareConnection({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'gdrive' });
    await shareConnection({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'dropbox' });
    expect(await unshareConnection({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'gdrive' })).toBe(true);
    expect(await connectionSharedWith({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'gdrive' })).toBe(false);
    expect(await connectionSharedWith({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'dropbox' })).toBe(true);
    expect(await connectorSharesBy('b@a.com')).toEqual([{ slug: 'o/r', provider: 'dropbox' }]);
  });

  it('reports false when unsharing something that was not shared', async () => {
    expect(await unshareConnection({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'gdrive' })).toBe(false);
  });

  it('never stores a token in the share pointer', async () => {
    await writeConnection({ email: 'b@a.com', provider: 'gdrive', accessToken: 'TOKEN-SECRET' });
    await shareConnection({ owner: 'o', repo: 'r', email: 'b@a.com', provider: 'gdrive' });
    const rec = await kvGet(keys.projectConnectors('o', 'r'));
    expect(JSON.stringify(rec)).not.toContain('TOKEN-SECRET');
  });
});

describe('which connection a read runs on', () => {
  it('uses the member\'s own connection when they have one', async () => {
    await writeConnection({ email: 'member@a.com', provider: 'gdrive', accessToken: 'mine' });
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    const r = await pickConnection({ email: 'member@a.com', provider: 'gdrive', owner: 'o', repo: 'r', primaryEmail: 'boss@a.com' });
    expect(r).toMatchObject({ accessToken: 'mine', via: 'own' });
  });

  it('falls back to the primary manager\'s connection only where they shared it', async () => {
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    await shareConnection({ owner: 'o', repo: 'r', email: 'boss@a.com', provider: 'gdrive' });
    const r = await pickConnection({ email: 'member@a.com', provider: 'gdrive', owner: 'o', repo: 'r', primaryEmail: 'boss@a.com' });
    expect(r).toMatchObject({ accessToken: 'boss', via: 'project' });
  });

  it('does not use the manager\'s connection on a project they did not share it with', async () => {
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    // shared with o/r, but the read is for o/other
    await shareConnection({ owner: 'o', repo: 'r', email: 'boss@a.com', provider: 'gdrive' });
    expect(await pickConnection({ email: 'member@a.com', provider: 'gdrive', owner: 'o', repo: 'other', primaryEmail: 'boss@a.com' })).toBeNull();
  });

  it('returns null when neither the member nor a shared manager connection exists', async () => {
    await shareConnection({ owner: 'o', repo: 'r', email: 'boss@a.com', provider: 'gdrive' }); // shared but never connected
    expect(await pickConnection({ email: 'member@a.com', provider: 'gdrive', owner: 'o', repo: 'r', primaryEmail: 'boss@a.com' })).toBeNull();
  });

  it('considers only the member when no project is given', async () => {
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    await shareConnection({ owner: 'o', repo: 'r', email: 'boss@a.com', provider: 'gdrive' });
    expect(await pickConnection({ email: 'member@a.com', provider: 'gdrive', primaryEmail: 'boss@a.com' })).toBeNull();
  });

  it('does not double-count when the member is the primary manager', async () => {
    await writeConnection({ email: 'boss@a.com', provider: 'gdrive', accessToken: 'boss' });
    const r = await pickConnection({ email: 'boss@a.com', provider: 'gdrive', owner: 'o', repo: 'r', primaryEmail: 'boss@a.com' });
    expect(r).toMatchObject({ accessToken: 'boss', via: 'own' });
  });
});
