/**
 * Binary file bytes through the hosted session (#247): an output file is
 * staged as raw bytes, committed as its own base64 (not via UTF-8, which would
 * corrupt it), read back byte-for-byte, and never downloaded with the context.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubSession } from './github.js';
import { runWithSession } from '../session-context.js';
import { writeOutputFile, readOutputFileBytes } from '../storage.js';

afterEach(() => vi.unstubAllGlobals());

// A PNG signature, a NUL, and bytes above 0x7f: a UTF-8 round-trip mangles all
// three, so byte-identity here is the whole point.
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f, 0x80]);

function freshSession() {
  const s = new GithubSession({ owner: 'team', repo: 'project', ref: 'main', ghToken: 'test-token' });
  s.prefetched = true;
  s.baseCommitSha = 'original';
  s.baseTreeSha = 'original-tree';
  return s;
}

/** Mock fetch for prefetch, returning a tree with one config blob and one output file blob. */
function prefetchFetch({ fileSha = 'file-sha', fetched }) {
  return vi.fn(async (url) => {
    if (url.includes('/git/refs/heads/main')) return { ok: true, status: 200, json: async () => ({ object: { sha: 'commit-sha' } }) };
    if (url.includes('/git/commits/commit-sha')) return { ok: true, status: 200, json: async () => ({ tree: { sha: 'tree-sha' } }) };
    if (url.includes('/git/trees/tree-sha')) {
      return { ok: true, status: 200, json: async () => ({ tree: [
        { type: 'blob', path: '.teamctx/config.json', sha: 'config-sha' },
        { type: 'blob', path: '.teamctx/outputs/t1/files/o1-banner.png', sha: fileSha },
      ] }) };
    }
    if (url.includes('/git/blobs/')) {
      fetched?.push(url);
      if (url.endsWith('config-sha')) return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: Buffer.from('{}', 'utf8').toString('base64') }) };
      if (url.endsWith(fileSha)) return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: BYTES.toString('base64') }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe('output file bytes on the hosted session', () => {
  it('does not download output file bytes with the context, only lists them', async () => {
    const fetched = [];
    vi.stubGlobal('fetch', prefetchFetch({ fetched }));
    const s = new GithubSession({ owner: 'team', repo: 'project', ref: 'main', ghToken: 't' });
    await s.prefetch();
    // The file blob is known (in the tree) but not loaded; the config blob is.
    expect(s.unloaded.has('.teamctx/outputs/t1/files/o1-banner.png')).toBe(true);
    expect(s.files.has('.teamctx/outputs/t1/files/o1-banner.png')).toBe(false);
    expect(s.files.has('.teamctx/config.json')).toBe(true);
    expect(fetched.some(u => u.endsWith('file-sha'))).toBe(false);
  });

  it('commits staged bytes as their own base64, byte-for-byte', async () => {
    const s = freshSession();
    runWithSession(s, () => {
      const path = writeOutputFile('t1', 'o1-banner.png', BYTES, '/virtual');
      expect(path).toBe('outputs/t1/files/o1-banner.png');
    });
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts?.body) bodies.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 201, json: async () => ({ sha: 'new' }) };
    }));
    await s.commit('attach banner');
    const blob = bodies.find(b => b.url.endsWith('/git/blobs'));
    expect(blob.body.encoding).toBe('base64');
    // Decoding the committed base64 gives back the exact bytes, unmangled.
    expect(Buffer.from(blob.body.content, 'base64').equals(BYTES)).toBe(true);
  });

  it('reads a committed file back byte-for-byte for the download route', async () => {
    const fetched = [];
    vi.stubGlobal('fetch', prefetchFetch({ fetched }));
    const s = new GithubSession({ owner: 'team', repo: 'project', ref: 'main', ghToken: 't' });
    await s.prefetch();
    const got = await runWithSession(s, () => readOutputFileBytes('t1', 'o1-banner.png', '/virtual'));
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(BYTES)).toBe(true);
    expect(fetched.some(u => u.endsWith('file-sha'))).toBe(true); // fetched only now, on demand
  });

  it('reads back bytes staged earlier in the same request', async () => {
    const s = freshSession();
    const got = await runWithSession(s, async () => {
      writeOutputFile('t1', 'o1-banner.png', BYTES, '/virtual');
      return readOutputFileBytes('t1', 'o1-banner.png', '/virtual');
    });
    expect(got.equals(BYTES)).toBe(true);
  });

  it('returns null for a file that is not there', async () => {
    const s = freshSession();
    const got = await runWithSession(s, () => readOutputFileBytes('t1', 'missing.png', '/virtual'));
    expect(got).toBeNull();
  });

  it('writeBytes refuses anything but a byte array', () => {
    const s = freshSession();
    expect(() => s.writeBytes('.teamctx/x', 'a string')).toThrow(/Uint8Array/);
  });
});
