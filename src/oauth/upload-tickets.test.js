import { describe, it, expect, beforeEach } from 'vitest';
import { __resetMemory, __resetSecrets, __dumpMemory, keys } from './kv.js';
import {
  createUploadTicket, consumeUploadTicket, UPLOAD_TICKET_TTL_SECONDS,
} from './upload-tickets.js';

beforeEach(() => { __resetMemory(); __resetSecrets(); });

const base = {
  owner: 'Acme', repo: 'Ledger', taskId: 't-1',
  actor: { key: 'git:a@b.com', name: 'Ann', email: 'a@b.com', source: 'google' },
  name: 'chart.png', ghToken: 'gho_WRITE', maxBytes: 4 * 1024 * 1024,
};

describe('upload tickets', () => {
  it('mints a ticket and consumes it exactly once', async () => {
    const { token, expiresAt, record } = await createUploadTicket(base);
    expect(token).toBeTruthy();
    expect(record.name).toBe('chart.png');
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const first = await consumeUploadTicket(token, { owner: 'Acme', repo: 'Ledger', taskId: 't-1' });
    expect(first).toMatchObject({ taskId: 't-1', name: 'chart.png', ghToken: 'gho_WRITE' });

    // Spent: a second attempt finds nothing.
    expect(await consumeUploadTicket(token, { owner: 'Acme', repo: 'Ledger', taskId: 't-1' })).toBeNull();
  });

  it('matches the project case-insensitively, as GitHub does', async () => {
    const { token } = await createUploadTicket(base);
    const got = await consumeUploadTicket(token, { owner: 'acme', repo: 'ledger', taskId: 't-1' });
    expect(got).not.toBeNull();
  });

  it('refuses a ticket spent against a different task or project', async () => {
    const { token } = await createUploadTicket(base);
    // Wrong task: the ticket is burned (atomic take) but not honoured.
    expect(await consumeUploadTicket(token, { owner: 'Acme', repo: 'Ledger', taskId: 't-OTHER' })).toBeNull();
    // And now it is gone for the right task too — single use regardless.
    expect(await consumeUploadTicket(token, { owner: 'Acme', repo: 'Ledger', taskId: 't-1' })).toBeNull();
  });

  it('does not store the write credential in the clear', async () => {
    await createUploadTicket(base);
    expect(__dumpMemory()).not.toContain('gho_WRITE');
  });

  it('keeps the ticket under its own namespaced, hashed key', async () => {
    await createUploadTicket(base);
    const dumped = JSON.parse(__dumpMemory()).map(([k]) => k);
    const key = dumped.find(k => k.startsWith('teamctx:upload:'));
    expect(key).toBeTruthy();
    // The raw token is never the key; only its hash (64 hex chars) is.
    expect(key).toMatch(/^teamctx:upload:[0-9a-f]{64}$/);
  });

  it('is written with a TTL of ten minutes, not stored forever', async () => {
    const { token } = await createUploadTicket(base);
    expect(UPLOAD_TICKET_TTL_SECONDS).toBe(600);
    // Each in-memory entry is [key, { value, expiresAt }]; the ticket must carry
    // an expiry roughly ten minutes out, never null (which would be immortal).
    const [, entry] = JSON.parse(__dumpMemory()).find(([k]) => k.startsWith('teamctx:upload:'));
    expect(entry.expiresAt).toBeTruthy();
    const secondsLeft = (entry.expiresAt - Date.now()) / 1000;
    expect(secondsLeft).toBeGreaterThan(UPLOAD_TICKET_TTL_SECONDS - 30);
    expect(secondsLeft).toBeLessThanOrEqual(UPLOAD_TICKET_TTL_SECONDS);
    // Live right now, before the TTL lapses.
    expect(await consumeUploadTicket(token)).not.toBeNull();
  });

  it('refuses to mint without the pieces it needs', async () => {
    await expect(createUploadTicket({ ...base, owner: '' })).rejects.toThrow(/project/);
    await expect(createUploadTicket({ ...base, taskId: '' })).rejects.toThrow(/task/);
    await expect(createUploadTicket({ ...base, name: '' })).rejects.toThrow(/name/);
    await expect(createUploadTicket({ ...base, ghToken: '' })).rejects.toThrow(/credential/);
  });

  it('returns null for an unknown or empty token', async () => {
    expect(await consumeUploadTicket('')).toBeNull();
    expect(await consumeUploadTicket('nope')).toBeNull();
  });

  it('defaults to a direct ticket; a blob ticket records its transit pathname', async () => {
    const direct = await createUploadTicket(base);
    expect(direct.record.transport).toBe('direct');
    expect(direct.record.blobPathname).toBeNull();

    const blob = await createUploadTicket({ ...base, transport: 'blob', blobPathname: 'teamctx-transit/t-1/abc/chart.png' });
    expect(blob.record.transport).toBe('blob');
    expect(blob.record.blobPathname).toBe('teamctx-transit/t-1/abc/chart.png');
    const got = await consumeUploadTicket(blob.token, { owner: 'Acme', repo: 'Ledger', taskId: 't-1' });
    expect(got).toMatchObject({ transport: 'blob', blobPathname: 'teamctx-transit/t-1/abc/chart.png' });
  });

  it('refuses a blob ticket with no transit pathname', async () => {
    await expect(createUploadTicket({ ...base, transport: 'blob' })).rejects.toThrow(/blob pathname/);
  });
});
