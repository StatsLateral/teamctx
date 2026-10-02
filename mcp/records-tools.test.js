import { describe, it, expect, beforeEach } from 'vitest';
import { makeHandlers, TOOLS } from './server.js';
import { runWithSession } from '../src/session-context.js';
import { runWithActor } from '../src/actor.js';
import { __resetMemory } from '../src/oauth/kv.js';

const MANAGER = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };
const RAVI = { key: 'git:ravi@x.com', name: 'Ravi', email: 'ravi@x.com', source: 'google' };

const rec = (id, type, text, extra = {}) => ({
  id, type, text, status: 'active', owner: null, attachedTo: { kind: 'project' },
  links: { restsOn: [], bends: null, replaces: null, answers: null }, sourceContributionIds: [], ...extra,
});

function session({ project, workstreams = {}, config = {} } = {}) {
  const CONFIG = {
    project: 'Ledger', me: 'Ada', managerKey: 'github:1001', autoPush: false, roles: [],
    deployUrl: 'https://teamctx.example',
    workstreams: [
      { id: 'sales', name: 'Sales', parent: null, order: 1 },
      { id: 'outreach', name: 'Outreach', parent: 'sales', order: 1 },
      { id: 'expansion', name: 'Expansion', parent: null, order: 2 },
      { id: 'renewals', name: 'Renewals', parent: 'expansion', order: 1 },
    ],
    members: [{ key: 'git:ravi@x.com', email: 'ravi@x.com', name: 'Ravi', workstreams: ['sales'] }],
    ...config,
  };
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG) }],
    ['.teamctx/contributions.jsonl', { content: '' }],
    ['.teamctx/project.json', { content: JSON.stringify(project ?? { name: 'Ledger', goal: { text: 'Ship it' }, records: [rec('rec-p', 'rule', 'No discounts over 15%')], tasks: [] }) }],
    ...['sales', 'outreach', 'expansion', 'renewals'].map(id => [`.teamctx/workstreams/${id}.json`, {
      content: JSON.stringify(workstreams[id] ?? { id, name: id, records: [rec(`rec-${id}`, 'decision', `${id} decision`)], tasks: [] }),
    }]),
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
const ROOT = { __backend: 'github', owner: 'acme', repo: 'ledger' };
const as = (s, actor, fn) => runWithSession(s, () => runWithActor(actor, () => fn(makeHandlers(ROOT))));
const json = async (p) => JSON.parse((await p).content[0].text);

beforeEach(() => __resetMemory());

describe('governed record tools', () => {
  it('list_records gives a scoped member their workstream, the parts below it and the project — nothing else', async () => {
    const r = await as(session(), RAVI, h => json(h.list_records({})));
    const ws = new Set(r.records.map(x => x.workstream));
    expect([...ws].sort()).toEqual([null, 'outreach', 'sales'].sort());
  });

  it('get_record answers the same for out-of-scope and missing', async () => {
    const out = await as(session(), RAVI, h => h.get_record({ id: 'rec-renewals' }).catch(e => e));
    const missing = await as(session(), RAVI, h => h.get_record({ id: 'rec-nope' }).catch(e => e));
    expect(out.message.replace('rec-renewals', 'ID')).toBe(missing.message.replace('rec-nope', 'ID'));
  });

  it('get_workstream reaches a nested part below the member, never a sibling\'s', async () => {
    const own = await as(session(), RAVI, h => json(h.get_workstream({ id: 'outreach' })));
    expect(own.records[0].text).toBe('outreach decision');
    await expect(as(session(), RAVI, h => h.get_workstream({ id: 'renewals' }))).rejects.toMatchObject({ code: 'WORKSTREAM_OUT_OF_SCOPE' });
  });

  it('the tool list has the new tools and none of the removed ones', () => {
    const names = TOOLS.map(t => t.name);
    for (const n of ['reflect', 'workstream_split', 'suggest_workstream_splits']) expect(names).not.toContain(n);
    for (const n of ['list_records', 'get_record', 'workstream_add']) expect(names).toContain(n);
  });

  it('get_status reports whether there is context and counts records by type', async () => {
    const r = await as(session(), MANAGER, h => json(h.get_status({})));
    expect(r.hasContext).toBe(true);
    expect(r.counts.records.rule).toBe(1);
    expect(r).not.toHaveProperty('totalWhys');
  });

  it('an old-format project answers with the re-init message, not an empty context', async () => {
    const s = session({ project: { name: 'Ledger', whys: [] } });
    await expect(as(s, MANAGER, h => h.get_context({}))).rejects.toThrow(/Run `teamctx init` again/);
  });

  it('get_connect_url says the project is not joinable yet when it has no context', async () => {
    const empty = { id: 'x', name: 'x', records: [], tasks: [] };
    const s = session({
      project: { name: 'Ledger', goal: null, records: [], tasks: [] },
      workstreams: { sales: empty, outreach: empty, expansion: empty, renewals: empty },
    });
    const r = await as(s, MANAGER, h => json(h.get_connect_url({})));
    expect(r.joinable).toBe(false);
    expect(r.joinableReason).toMatch(/nothing written down yet/);
  });
});
