import { describe, it, expect, beforeEach } from 'vitest';
import { makeHandlers } from './server.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';

// A person on the roster is regular (internal) unless a manager marks them
// external: an advisor or contractor who shares some of the work.

const MANAGER = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };
const RAVI = { key: 'git:ravi@x.com', name: 'Ravi', email: 'ravi@x.com', source: 'google' };

function session(members = []) {
  const CONFIG = {
    project: 'Ledger', me: 'Ada', managerKey: 'github:1001', autoPush: false, roles: [],
    deployUrl: 'https://teamctx.example',
    workstreams: [{ id: 'sales', number: 1, name: 'Sales', parent: null, order: 1 }],
    members,
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
    config: () => JSON.parse(files.get('.teamctx/config.json').content),
  };
}
const ROOT = { __backend: 'github', owner: 'acme', repo: 'ledger' };
const as = (s, actor, fn) => runWithSession(s, () => runWithActor(actor, () => fn(makeHandlers(ROOT))));
const json = async (p) => JSON.parse((await p).content[0].text);
const ravi = { key: 'git:ravi@x.com', name: 'Ravi', email: 'ravi@x.com', workstreams: ['sales'] };

beforeEach(() => __resetMemory());

describe('marking a person external', () => {
  it('marks a member external and keeps their scope', async () => {
    const s = session([ravi]);
    const r = await as(s, MANAGER, h => json(h.member_external({ ref: 'ravi@x.com' })));
    const stored = s.config().members.find(m => m.name === 'Ravi');
    expect(stored.external).toBe(true);
    expect(stored.workstreams).toEqual(['sales']);
    expect(r.reportBack).toMatch(/Ravi is now external/);
  });

  it('puts them back to regular, and stores nothing for a regular member', async () => {
    const s = session([{ ...ravi, external: true }]);
    const r = await as(s, MANAGER, h => json(h.member_external({ ref: 'ravi@x.com', external: false })));
    expect('external' in s.config().members.find(m => m.name === 'Ravi')).toBe(false);
    expect(r.reportBack).toMatch(/Ravi is now a regular team member/);
  });

  it('is the manager\'s alone', async () => {
    const s = session([ravi]);
    await expect(as(s, RAVI, h => h.member_external({ ref: 'ravi@x.com' }))).rejects.toThrow(/only the configured manager|manager/i);
    expect(s.config().members[0].external).toBeUndefined();
  });

  it('refuses someone who is not on the roster, and an agent', async () => {
    const s = session([ravi, { key: 'agent:a1', name: 'Nightly', kind: 'agent' }]);
    await expect(as(s, MANAGER, h => h.member_external({ ref: 'nobody@x.com' }))).rejects.toThrow(/not on the project|not found|no member/i);
    await expect(as(s, MANAGER, h => h.member_external({ ref: 'Nightly' }))).rejects.toThrow(/agent/i);
  });

  it('can be set when adding someone', async () => {
    const s = session([]);
    await as(s, MANAGER, h => json(h.member_add({ ref: 'dana@x.com', name: 'Dana', external: true })));
    expect(s.config().members.find(m => m.name === 'Dana').external).toBe(true);
  });
});
