import { describe, it, expect, beforeEach, vi } from 'vitest';

// The transit blob talks to Vercel's network; stub it so these tests check what
// request_upload asks of it, and toggle whether a store is configured.
const blobState = vi.hoisted(() => ({ configured: true }));
vi.mock('../src/oauth/blob-transit.js', () => ({
  blobConfigured: () => blobState.configured,
  mintBlobUpload: vi.fn(async ({ taskId, name, contentType, maxBytes }) => ({
    uploadUrl: `https://vercel.com/api/blob/?pathname=teamctx-transit%2F${taskId}%2Fabc%2F${name}`,
    method: 'PUT',
    headers: {
      authorization: 'Bearer vercel_blob_client_Store_TOKEN',
      'x-api-version': '13', 'x-vercel-blob-store-id': 'Store',
      'x-vercel-blob-access': 'public', 'x-content-type': contentType,
    },
    uploadHost: 'vercel.com',
    pathname: `teamctx-transit/${taskId}/abc/${name}`,
    expiresAt: new Date(Date.now() + 600 * 1000).toISOString(),
    __maxBytes: maxBytes,
  })),
}));

import { makeHandlers } from './server.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';
import { consumeUploadTicket } from '../src/oauth/upload-tickets.js';

/**
 * request_upload mints a short-lived URL so a chatbot can send a generated
 * file's bytes straight to teamctx, off the token-costed path (#257). These
 * drive the hosted handler: a valid call returns a PUT URL carrying the
 * canonical task id and a ticket that holds the write credential and the
 * caller's identity; the impossible cases (not hosted, wrong type, too big,
 * accepted task) are refused before any ticket is minted.
 */

const OWNER = 'acme';
const REPO = 'ledger';
const BASE = 'https://team.example.app';

const ALICE = { key: 'github:1001', name: 'Alice Example', login: 'alice', source: 'github' };

const CONFIG = {
  project: 'Ledger', me: 'whoever-ran-init', managerKey: 'github:1001',
  model: 'claude-sonnet-4-6', autoPush: false, roles: [],
  workstreams: [{ id: 'w1', number: 1, name: 'Work' }],
  activeWorkstream: null,
};

function fakeSession({ accepted = false } = {}) {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG), sha: 'a' }],
    ['.teamctx/contributions.jsonl', { content: '', sha: 'b' }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Ledger', records: [{ id: 'p1', type: 'decision', text: 'ship it', status: 'active' }], tasks: [] }), sha: 'p' }],
    ['.teamctx/workstreams/w1.json', { content: JSON.stringify({
      id: 'w1', name: 'Work', records: [],
      tasks: [{ id: 't-1', key: '1.1', title: 'Make the chart', owner: 'Alice Example', workstream: 'w1', status: 'open' }],
    }), sha: 'd' }],
  ]);
  if (accepted) files.set('.teamctx/approved/a1.json', { content: JSON.stringify({ id: 'a1', forTask: 't-1', approvedBy: { name: 'Alice Example' } }), sha: 'x' });
  return {
    owner: OWNER, repo: REPO, ghToken: 'gh-write-token',
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c), sha: null }),
    del: p => files.delete(p),
    listDir: dirPath => {
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
      return [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    },
    commit: async () => ({ committed: true }),
  };
}

const hostedRoot = () => ({ __backend: 'github', owner: OWNER, repo: REPO, ghToken: 'gh-write-token', baseUrl: BASE });
const asUser = (session, actor, fn) => runWithSession(session, () => runWithActor(actor, () => fn(makeHandlers(hostedRoot()))));
const json = async (promise) => JSON.parse((await promise).content[0].text);

beforeEach(() => { __resetMemory(); blobState.configured = true; });

describe('request_upload', () => {
  it('returns a PUT URL for the canonical task, and a ticket carrying the credential and caller', async () => {
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.request_upload({ id: '1.1', name: 'chart.png', title: 'Chart', notes: 'v1' })));

    expect(r.method).toBe('PUT');
    expect(r.maxBytes).toBe(4 * 1024 * 1024);
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now());
    // The canonical id, not the number the caller passed.
    expect(r.uploadUrl).toMatch(new RegExp(`^${BASE}/project/acme/ledger/task/t-1/upload/[A-Za-z0-9_-]+$`));
    expect(r.reportBack).toMatch(/curl --upload-file/);
    // The host to allow is derived from this deployment's address, not hard-coded,
    // and named in the guidance so a blocked sandbox knows exactly what to allow.
    expect(r.uploadHost).toBe('team.example.app');
    expect(r.reportBack).toContain('team.example.app');
    expect(r.reportBack).toMatch(/allowed websites/i);

    // The ticket behind the URL holds what the endpoint needs.
    const token = r.uploadUrl.split('/').pop();
    const ticket = await consumeUploadTicket(token, { owner: OWNER, repo: REPO, taskId: 't-1' });
    expect(ticket).toMatchObject({
      owner: OWNER, repo: REPO, taskId: 't-1', name: 'chart.png',
      title: 'Chart', notes: 'v1', ghToken: 'gh-write-token',
    });
    expect(ticket.actor).toMatchObject({ name: 'Alice Example' });
  });

  it('is only available on the hosted connector', async () => {
    const handlers = makeHandlers(process.cwd());
    await expect(handlers.request_upload({ id: 't-1', name: 'x.png' }))
      .rejects.toThrow(/hosted connector|teamctx task attach/);
  });

  it('refuses a disallowed file type before minting anything', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.request_upload({ id: '1.1', name: 'evil.exe' })))
      .rejects.toThrow(/not an allowed output type/);
  });

  it('refuses a declared size over the hosted ceiling, pointing at a cloud link', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.request_upload({ id: '1.1', name: 'big.png', size: 30 * 1024 * 1024 })))
      .rejects.toThrow(/hosted upload allows.*task_attach_link/s);
  });

  it('sends a file over the direct cap through the two-step transit path', async () => {
    const session = fakeSession();
    const r = await asUser(session, ALICE, h => json(h.request_upload({ id: '1.1', name: 'big.png', size: 8 * 1024 * 1024, title: 'Big' })));

    // The PUT goes to the Blob ingest, not teamctx, and carries the mint's headers.
    expect(r.uploadUrl).toContain('vercel.com/api/blob');
    expect(r.uploadHost).toBe('vercel.com');
    expect(r.headers.authorization).toMatch(/^Bearer /);
    expect(r.maxBytes).toBe(25 * 1024 * 1024);
    // A separate finalize call on this deployment, named so a blocked sandbox can allow it.
    expect(r.finalizeUrl).toMatch(new RegExp(`^${BASE}/project/acme/ledger/task/t-1/finalize/[A-Za-z0-9_-]+$`));
    expect(r.finalizeHost).toBe('team.example.app');
    expect(r.reportBack).toMatch(/curl -X PUT/);
    expect(r.reportBack).toMatch(/curl -X POST/);
    expect(r.reportBack).toContain('vercel.com');
    expect(r.reportBack).toContain('team.example.app');
    expect(r.reportBack).toMatch(/BOTH/);

    // The ticket behind finalize is a transit ticket bound to the blob path.
    const token = r.finalizeUrl.split('/').pop();
    const ticket = await consumeUploadTicket(token, { owner: OWNER, repo: REPO, taskId: 't-1' });
    expect(ticket).toMatchObject({
      transport: 'blob', name: 'big.png', title: 'Big', ghToken: 'gh-write-token',
      blobPathname: 'teamctx-transit/t-1/abc/big.png',
    });
  });

  it('refuses a large file when no transit store is configured', async () => {
    blobState.configured = false;
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.request_upload({ id: '1.1', name: 'big.png', size: 8 * 1024 * 1024 })))
      .rejects.toThrow(/not configured.*task_attach_link/s);
  });

  it('refuses an unknown task', async () => {
    const session = fakeSession();
    await expect(asUser(session, ALICE, h => h.request_upload({ id: '9.9', name: 'x.png' })))
      .rejects.toThrow(/No task matches/);
  });

  it('refuses an accepted task', async () => {
    const session = fakeSession({ accepted: true });
    await expect(asUser(session, ALICE, h => h.request_upload({ id: '1.1', name: 'x.png' })))
      .rejects.toThrow();
  });
});
