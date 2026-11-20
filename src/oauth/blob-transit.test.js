import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real @vercel/blob talks to Vercel's network; stub it so these tests check
// what teamctx asks of it, not the service itself.
const generateClientTokenFromReadWriteToken = vi.fn();
const list = vi.fn();
const del = vi.fn();
const get = vi.fn();
vi.mock('@vercel/blob/client', () => ({ generateClientTokenFromReadWriteToken: (...a) => generateClientTokenFromReadWriteToken(...a) }));
vi.mock('@vercel/blob', () => ({ list: (...a) => list(...a), del: (...a) => del(...a), get: (...a) => get(...a) }));

const {
  blobConfigured, blobAccess, storeIdFromToken, transitPathname,
  mintBlobUpload, fetchTransitBytes, deleteTransitBlob, BLOB_UPLOAD_API,
} = await import('./blob-transit.js');

const env = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_Store123_secretpart' };

beforeEach(() => {
  generateClientTokenFromReadWriteToken.mockReset().mockResolvedValue('vercel_blob_client_Store123_TOKEN');
  list.mockReset();
  del.mockReset();
  get.mockReset();
});

describe('blob transit', () => {
  it('reports whether a store is configured', () => {
    expect(blobConfigured(env)).toBe(true);
    expect(blobConfigured({})).toBe(false);
    expect(blobConfigured(undefined)).toBe(false);
  });

  it('defaults the store access to private, honouring BLOB_ACCESS=public', () => {
    expect(blobAccess(env)).toBe('private');
    expect(blobAccess({})).toBe('private');
    expect(blobAccess(undefined)).toBe('private');
    expect(blobAccess({ BLOB_ACCESS: 'public' })).toBe('public');
    expect(blobAccess({ BLOB_ACCESS: 'PUBLIC' })).toBe('private'); // only exact 'public'
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
    expect(out.headers['x-vercel-blob-access']).toBe('private');
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

  it('names the public access mode on the PUT when the store is public', async () => {
    const out = await mintBlobUpload({
      taskId: 't-1', name: 'big.png', maxBytes: 1024, now: 1_000_000,
      env: { ...env, BLOB_ACCESS: 'public' },
    });
    expect(out.headers['x-vercel-blob-access']).toBe('public');
  });

  it('refuses to mint without a configured store', async () => {
    await expect(mintBlobUpload({ taskId: 't-1', name: 'big.png', env: {} }))
      .rejects.toThrow(/not configured/);
  });

  it('reads the bytes back with the store token and access mode', async () => {
    get.mockResolvedValue({ statusCode: 200, stream: new Response(new Uint8Array([1, 2, 3])).body });

    const got = await fetchTransitBytes({ pathname: 'p/x', env });
    expect(Buffer.from(got.bytes)).toEqual(Buffer.from([1, 2, 3]));
    expect(get).toHaveBeenCalledWith('p/x', expect.objectContaining({
      access: 'private', token: env.BLOB_READ_WRITE_TOKEN, useCache: false,
    }));
  });

  it('reads a public store back with public access', async () => {
    get.mockResolvedValue({ statusCode: 200, stream: new Response(new Uint8Array([9])).body });
    await fetchTransitBytes({ pathname: 'p/x', env: { ...env, BLOB_ACCESS: 'public' } });
    expect(get).toHaveBeenCalledWith('p/x', expect.objectContaining({ access: 'public' }));
  });

  it('returns null when the sandbox never sent the blob', async () => {
    get.mockResolvedValue(null);
    expect(await fetchTransitBytes({ pathname: 'p/x', env })).toBeNull();
  });

  it('returns null when there is no readable stream', async () => {
    get.mockResolvedValue({ statusCode: 304, stream: null });
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
