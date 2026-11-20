import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real @vercel/blob talks to Vercel's network; stub it so these tests check
// what teamctx asks of it, not the service itself.
const generateClientTokenFromReadWriteToken = vi.fn();
const list = vi.fn();
const del = vi.fn();
vi.mock('@vercel/blob/client', () => ({ generateClientTokenFromReadWriteToken: (...a) => generateClientTokenFromReadWriteToken(...a) }));
vi.mock('@vercel/blob', () => ({ list: (...a) => list(...a), del: (...a) => del(...a) }));

const {
  blobConfigured, storeIdFromToken, transitPathname,
  mintBlobUpload, fetchTransitBytes, deleteTransitBlob, BLOB_UPLOAD_API,
} = await import('./blob-transit.js');

const env = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_Store123_secretpart' };

beforeEach(() => {
  generateClientTokenFromReadWriteToken.mockReset().mockResolvedValue('vercel_blob_client_Store123_TOKEN');
  list.mockReset();
  del.mockReset();
});

describe('blob transit', () => {
  it('reports whether a store is configured', () => {
    expect(blobConfigured(env)).toBe(true);
    expect(blobConfigured({})).toBe(false);
    expect(blobConfigured(undefined)).toBe(false);
  });

  it('reads the store id from the fourth field of the token', () => {
    expect(storeIdFromToken('vercel_blob_rw_Store123_secretpart')).toBe('Store123');
    expect(storeIdFromToken('')).toBe('');
  });

  it('gives each upload an unguessable path under the task, keeping the name', () => {
    const a = transitPathname('t-1', 'my chart.png');
    const b = transitPathname('t-1', 'my chart.png');
    expect(a).toMatch(/^teamctx-transit\/t-1\/[0-9a-f]{64}\/my_chart\.png$/);
    expect(a).not.toBe(b); // 256 bits of randomness, never repeats
  });

  it('mints a PUT to the Blob ingest API with the client token and the right headers', async () => {
    const out = await mintBlobUpload({
      taskId: 't-1', name: 'big.png', contentType: 'image/png',
      maxBytes: 25 * 1024 * 1024, ttlSeconds: 600, now: 1_000_000, env,
    });

    // The URL is Vercel Blob's ingest, carrying the exact pathname the token is bound to.
    expect(out.uploadUrl.startsWith(`${BLOB_UPLOAD_API}/?pathname=`)).toBe(true);
    expect(decodeURIComponent(out.uploadUrl.split('pathname=')[1])).toBe(out.pathname);
    expect(out.method).toBe('PUT');
    expect(out.uploadHost).toBe('vercel.com');

    // Headers the ingest API needs; the bearer is the minted client token.
    expect(out.headers.authorization).toBe('Bearer vercel_blob_client_Store123_TOKEN');
    expect(out.headers['x-api-version']).toBe('13');
    expect(out.headers['x-vercel-blob-store-id']).toBe('Store123');
    expect(out.headers['x-vercel-blob-access']).toBe('public');
    expect(out.headers['x-content-type']).toBe('image/png');

    // The token is bound to that one path, size and a ten-minute window.
    expect(generateClientTokenFromReadWriteToken).toHaveBeenCalledWith(expect.objectContaining({
      token: env.BLOB_READ_WRITE_TOKEN,
      pathname: out.pathname,
      validUntil: 1_000_000 + 600 * 1000,
      maximumSizeInBytes: 25 * 1024 * 1024,
      ttlDays: 1,
    }));
    expect(out.expiresAt).toBe(new Date(1_000_000 + 600 * 1000).toISOString());
  });

  it('refuses to mint without a configured store', async () => {
    await expect(mintBlobUpload({ taskId: 't-1', name: 'big.png', env: {} }))
      .rejects.toThrow(/not configured/);
  });

  it('fetches the bytes back by exact pathname', async () => {
    list.mockResolvedValue({ blobs: [{ pathname: 'p/x', url: 'https://blob/x', downloadUrl: 'https://blob/x?download=1' }] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

    const got = await fetchTransitBytes({ pathname: 'p/x', env });
    expect(Buffer.from(got.bytes)).toEqual(Buffer.from([1, 2, 3]));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'p/x', token: env.BLOB_READ_WRITE_TOKEN }));
    expect(global.fetch).toHaveBeenCalledWith('https://blob/x?download=1');
  });

  it('returns null when the sandbox never sent the blob', async () => {
    list.mockResolvedValue({ blobs: [] });
    expect(await fetchTransitBytes({ pathname: 'p/x', env })).toBeNull();
  });

  it('ignores a near-match that is not the exact path', async () => {
    list.mockResolvedValue({ blobs: [{ pathname: 'p/x-evil', url: 'https://blob/evil' }] });
    expect(await fetchTransitBytes({ pathname: 'p/x', env })).toBeNull();
  });

  it('deletes the transit blob, and never throws when it cannot', async () => {
    list.mockResolvedValue({ blobs: [{ pathname: 'p/x', url: 'https://blob/x' }] });
    await deleteTransitBlob({ pathname: 'p/x', env });
    expect(del).toHaveBeenCalledWith('https://blob/x', { token: env.BLOB_READ_WRITE_TOKEN });

    list.mockRejectedValue(new Error('network'));
    await expect(deleteTransitBlob({ pathname: 'p/x', env })).resolves.toBeUndefined();
  });
});
