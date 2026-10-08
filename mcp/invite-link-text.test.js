import { describe, it, expect, beforeEach } from 'vitest';
import { makeHandlers } from './server.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';

// What a manager's assistant is told to hand to somebody it has just added. The
// connector address is for pasting into an assistant, and a person who is told
// it is "a link" opens it in a browser and finds a line of JSON.

const MANAGER = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };

function session() {
  const CONFIG = {
    project: 'Ledger', me: 'Ada', managerKey: 'github:1001', autoPush: false, roles: [],
    deployUrl: 'https://teamctx.example',
    workstreams: [{ id: 'sales', number: 1, name: 'Sales', parent: null, order: 1 }],
    members: [],
  };
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG) }],
    ['.teamctx/contributions.jsonl', { content: '' }],
    ['.teamctx/project.json', { content: JSON.stringify({ name: 'Ledger', goal: { text: 'Ship it' }, records: [], tasks: [] }) }],
    ['.teamctx/workstreams/sales.json', { content: JSON.stringify({ id: 'sales', name: 'Sales', records: [{ id: 'r', type: 'decision', text: 'x', status: 'active', owner: null, attachedTo: { kind: 'project' }, links: { restsOn: [], bends: null, replaces: null, answers: null }, sourceContributionIds: [] }], tasks: [] }) }],
  ]);
  return {
    owner: 'acme', repo: 'ledger', ghToken: 't',
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c) }),
    del: p => files.delete(p),
    listDir: d => { const pre = d.endsWith('/') ? d : `${d}/`; return [...files.keys()].filter(p => p.startsWith(pre) && !p.slice(pre.length).includes('/')).map(p => p.slice(pre.length)).sort(); },
    commit: async () => ({ committed: true }),
  };
}
const ROOT = { __backend: 'github', owner: 'acme', repo: 'ledger', baseUrl: 'https://teamctx.example' };
const as = (s, fn) => runWithSession(s, () => runWithActor(MANAGER, () => fn(makeHandlers(ROOT))));
const json = async (p) => JSON.parse((await p).content[0].text);

beforeEach(() => __resetMemory());

describe('adding somebody, and what the assistant is told to send them', () => {
  it('gives the connector address and a link that opens in a browser, and says which is which', async () => {
    const r = await as(session(), h => json(h.member_add({ ref: 'dana@x.com', name: 'Dana' })));
    expect(r.connectUrl).toContain('/api/mcp/acme/ledger');
    expect(r.viewUrl).toContain('/project/acme/ledger');
    expect(r.reportBack).toContain(r.connectUrl);
    expect(r.reportBack).toContain(r.viewUrl);
    expect(r.reportBack).toMatch(/paste it into|add it as a custom connector/i);
    expect(r.reportBack).toMatch(/not a page to open/i);
  });
});
