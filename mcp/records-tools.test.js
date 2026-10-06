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
    await expect(as(s, MANAGER, h => h.get_context({}))).rejects.toThrow(/Remove the .teamctx folder, then run `teamctx init`/);
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

import { callTool } from './server.js';

describe('arguments a caller sends cannot widen what they see', () => {
  it('list_records ignores a scope or date passed in the arguments', async () => {
    const r = await as(session(), RAVI, h => callTool(h, ROOT, 'list_records', { scope: null, onDay: '1999-01-01', teamctxDir: '/elsewhere' }));
    const records = JSON.parse(r.content[0].text).records;
    expect(records.map(x => x.workstream)).not.toContain('expansion');
    expect(records.map(x => x.workstream)).not.toContain('renewals');
  });
  it('get_record ignores a scope passed in the arguments', async () => {
    const r = await as(session(), RAVI, h => callTool(h, ROOT, 'get_record', { id: 'rec-renewals', scope: null }));
    expect(r.isError).toBe(true);
  });
});

/**
 * The flag reaches every way an AI reads a record.
 *
 * #120's second acceptance criterion asks for a test per read path, and the
 * reason is that these are four separate pieces of wiring. A flag that shows in
 * `my_brief` and not in `get_context` is worse than none: the assistant gets a
 * different answer depending on which question it asked.
 *
 * The case here is the one that makes the wiring hard. The broken assumption
 * sits on the project tree; the decision resting on it sits in a workstream; and
 * Ravi is scoped to `sales` and its children. The mark has to cross the scope
 * line without the assumption's own words crossing it.
 */
describe('a record resting on a broken assumption, however it is read', () => {
  const broken = rec('rec-a1', 'assumption', 'buyers need SSO before a pilot', {
    status: 'broken', brokenAt: '2026-10-05T09:00:00.000Z',
    owner: { key: 'git:o@x', name: 'O' }, reviewBy: '2026-12-01',
  });
  const resting = (extra = {}) => rec('rec-d1', 'decision', 'build SSO first', {
    attachedTo: { kind: 'workstream', id: 'sales' },
    links: { restsOn: ['rec-a1'], bends: null, replaces: null, answers: null },
    ...extra,
  });

  const world = (over = {}) => session({
    project: { name: 'Ledger', goal: { text: 'Ship it' }, records: [broken], tasks: [] },
    workstreams: { sales: { id: 'sales', name: 'sales', records: [resting(over)], tasks: [] } },
  });

  const found = (records) => (records || []).find(x => x.id === 'rec-d1');

  it('is marked in list_records', async () => {
    const r = await as(world(), MANAGER, h => json(h.list_records({})));
    expect(found(r.records).needsReview).toMatch(/rests on a broken assumption/);
  });

  it('is marked in get_record', async () => {
    const r = await as(world(), MANAGER, h => json(h.get_record({ id: 'rec-d1' })));
    expect(r.needsReview).toMatch(/rests on a broken assumption/);
  });

  it('is marked in get_context', async () => {
    const r = await as(world(), MANAGER, h => json(h.get_context()));
    const sales = r.workstreams.find(w => w.id === 'sales');
    expect(found(sales.tree.records).needsReview).toMatch(/rests on a broken assumption/);
  });

  it('is marked in my_brief', async () => {
    // Read as Ravi, who is on `sales`. A brief renders where the reader stands,
    // and the manager standing at project level is not shown a workstream's
    // decisions at all — so asking for the flag there would be asking for the
    // wrong thing rather than testing the wiring.
    const r = await as(world(), RAVI, h => json(h.my_brief()));
    expect(JSON.stringify(r)).toMatch(/rests on a broken assumption/);
  });

  it('is marked for a scoped member who cannot see the assumption', async () => {
    // The whole reason the flag is worked out over every record in the project.
    // Ravi reaches `sales`; the assumption is on the project tree, which they do
    // read — so this also holds when it is somewhere they do not. What matters
    // is that the answer does not depend on where the assumption happens to sit.
    const r = await as(world(), RAVI, h => json(h.list_records({})));
    expect(found(r.records).needsReview).toMatch(/rests on a broken assumption/);
  });

  it('stops being marked once the manager re-confirms it', async () => {
    const r = await as(world({ reviewedAt: '2026-10-05T10:00:00.000Z' }), MANAGER, h => json(h.list_records({})));
    expect(found(r.records).needsReview).toBeUndefined();
  });

  it('says nothing when the assumption still holds', async () => {
    const s = session({
      project: { name: 'Ledger', goal: { text: 'Ship it' }, records: [{ ...broken, status: 'active' }], tasks: [] },
      workstreams: { sales: { id: 'sales', name: 'sales', records: [resting()], tasks: [] } },
    });
    const r = await as(s, MANAGER, h => json(h.list_records({})));
    expect(found(r.records).needsReview).toBeUndefined();
  });

  it('leaves the stored record alone — the mark dresses a response', async () => {
    // Nothing is written to answer a read. If this ever stamped the tree, a
    // record would carry a flag that outlived the reason for it.
    const s = world();
    await as(s, MANAGER, h => json(h.list_records({})));
    const stored = JSON.parse(s.read('.teamctx/workstreams/sales.json').content);
    expect(stored.records[0].needsReview).toBeUndefined();
  });
});

/**
 * The moment this was all built for.
 *
 * > "We're assuming: buyers need SSO before a pilot" may be broken. The
 * > decisions "Build SSO first" and "Delay the Acme pilot" rest on it. Review?
 *
 * The manager hears it at the point of deciding, not afterwards, which is why
 * the list rides on the contribute result rather than waiting for a second call.
 * It answers the same for a queued contribution as for an applied one: the walk
 * follows `restsOn` and does not care what state the assumption is in yet.
 */
describe('breaking an assumption says what it takes with it', () => {
  const assumption = rec('rec-a1', 'assumption', 'buyers need SSO before a pilot', {
    owner: { key: 'git:o@x', name: 'O' }, reviewBy: '2026-12-01',
  });
  const onIt = (id, text) => rec(id, 'decision', text, {
    attachedTo: { kind: 'workstream', id: 'sales' },
    links: { restsOn: ['rec-a1'], bends: null, replaces: null, answers: null },
  });

  const world = () => session({
    project: { name: 'Ledger', goal: { text: 'Ship it' }, records: [assumption], tasks: [] },
    workstreams: {
      sales: {
        id: 'sales',
        name: 'sales',
        records: [onIt('rec-d1', 'build SSO first'), onIt('rec-d2', 'delay the Acme pilot')],
        tasks: [],
      },
    },
  });

  const breakIt = () => [{ type: 'setRecordStatus', id: 'rec-a1', status: 'broken' }];

  it('names both decisions on the result of approving the break', async () => {
    const s = world();
    s.write('.teamctx/queue/c-9.json', JSON.stringify({
      id: 'c-9', status: 'pending', author: 'Ada', summary: 'new evidence',
      workstream: null, operations: breakIt(),
    }));
    const r = await as(s, MANAGER, h => json(h.review_approve({ id: 'c-9' })));
    expect(r.impact[0].text).toBe('buyers need SSO before a pilot');
    expect(r.impact[0].records.map(x => x.text).sort())
      .toEqual(['build SSO first', 'delay the Acme pilot']);
  });

  it('says it in the words the assistant reads back', async () => {
    const s = world();
    s.write('.teamctx/queue/c-9.json', JSON.stringify({
      id: 'c-9', status: 'pending', author: 'Ada', summary: 'new evidence',
      workstream: null, operations: breakIt(),
    }));
    const r = await as(s, MANAGER, h => json(h.review_approve({ id: 'c-9' })));
    expect(r.reportBack).toContain('2 things rest on');
    expect(r.reportBack).toContain('build SSO first');
    expect(r.reportBack).toContain('second look');
  });

  it('names the tasks that work is being done on', async () => {
    const s = session({
      project: { name: 'Ledger', goal: { text: 'Ship it' }, records: [assumption], tasks: [] },
      workstreams: {
        sales: {
          id: 'sales',
          name: 'sales',
          records: [rec('rec-d1', 'decision', 'build SSO first', {
            attachedTo: { kind: 'task', id: 'sso-work' },
            links: { restsOn: ['rec-a1'], bends: null, replaces: null, answers: null },
          })],
          tasks: [{ id: 'sso-work', title: 'Build the SSO flow', owner: 'Ravi', status: 'open' }],
        },
      },
    });
    s.write('.teamctx/queue/c-9.json', JSON.stringify({
      id: 'c-9', status: 'pending', author: 'Ada', summary: 'new evidence',
      workstream: null, operations: breakIt(),
    }));
    const r = await as(s, MANAGER, h => json(h.review_approve({ id: 'c-9' })));
    expect(r.impact[0].tasks.map(t => t.title)).toEqual(['Build the SSO flow']);
    expect(r.reportBack).toContain('Build the SSO flow');
  });

  it('says plainly when nothing rests on it', async () => {
    const s = session({
      project: { name: 'Ledger', goal: { text: 'Ship it' }, records: [assumption], tasks: [] },
      workstreams: { sales: { id: 'sales', name: 'sales', records: [], tasks: [] } },
    });
    s.write('.teamctx/queue/c-9.json', JSON.stringify({
      id: 'c-9', status: 'pending', author: 'Ada', summary: 'new evidence',
      workstream: null, operations: breakIt(),
    }));
    const r = await as(s, MANAGER, h => json(h.review_approve({ id: 'c-9' })));
    expect(r.impact[0].records).toEqual([]);
    expect(r.reportBack).toContain('Nothing on record rests on');
  });

  it('carries no impact at all on an ordinary contribution', async () => {
    const s = world();
    s.write('.teamctx/queue/c-9.json', JSON.stringify({
      id: 'c-9', status: 'pending', author: 'Ada', summary: 'a note',
      workstream: null, operations: [{ type: 'setGoal', text: 'Ship it well' }],
    }));
    const r = await as(s, MANAGER, h => json(h.review_approve({ id: 'c-9' })));
    expect(r.impact).toBeUndefined();
    expect(r.reportBack).not.toContain('rest on');
  });

  it('says nothing for a status change that is not a break', async () => {
    const s = world();
    s.write('.teamctx/queue/c-9.json', JSON.stringify({
      id: 'c-9', status: 'pending', author: 'Ada', summary: 'retire it',
      workstream: null, operations: [{ type: 'setRecordStatus', id: 'rec-a1', status: 'closed' }],
    }));
    const r = await as(s, MANAGER, h => json(h.review_approve({ id: 'c-9' })));
    expect(r.impact).toBeUndefined();
  });
});
