/**
 * Breaking an assumption, said to somebody who cannot see every part of the work.
 *
 * `contribute` answers what rests on a broken assumption. The walk has to cross
 * every part of the work to be right, and it used to hand all of it back: a
 * member on one workstream could read the decisions and tasks of another just
 * by saying a project assumption no longer held, even with nothing applied.
 * They now see what is in their scope, and a count of the rest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/context.js', async (importOriginal) => ({
  ...(await importOriginal()),
  updateShared: vi.fn(async (workstream) => ({
    workstream,
    summary: 'The SSO assumption no longer holds.',
    operations: [{ type: 'setRecordStatus', id: 'rec-a1', status: 'broken' }],
  })),
}));

const { makeHandlers } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');

const MANAGER = { key: 'github:1001', name: 'Ada', login: 'ada', source: 'github' };
const RAVI = { key: 'git:ravi@x.com', name: 'Ravi', email: 'ravi@x.com', source: 'google' };

const rec = (id, type, text, extra = {}) => ({
  id, type, text, status: 'active', owner: null, attachedTo: { kind: 'project' },
  links: { restsOn: [], bends: null, replaces: null, answers: null }, sourceContributionIds: [], ...extra,
});
const onIt = (id, text, ws, extra = {}) => rec(id, 'decision', text, {
  attachedTo: { kind: 'workstream', id: ws },
  links: { restsOn: ['rec-a1'], bends: null, replaces: null, answers: null },
  ...extra,
});

function session() {
  const config = {
    project: 'Ledger', me: 'Ada', managerKey: 'github:1001', autoPush: false, roles: [],
    workstreams: [
      { id: 'sales', name: 'Sales', parent: null, order: 1 },
      { id: 'expansion', name: 'Expansion', parent: null, order: 2 },
    ],
    // Ravi works on sales only.
    members: [{ key: 'git:ravi@x.com', email: 'ravi@x.com', name: 'Ravi', workstreams: ['sales'] }],
  };
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(config) }],
    ['.teamctx/contributions.jsonl', { content: '' }],
    ['.teamctx/project.json', { content: JSON.stringify({
      name: 'Ledger', goal: { text: 'Ship it' }, tasks: [],
      records: [rec('rec-a1', 'assumption', 'buyers need SSO before a pilot')],
    }) }],
    ['.teamctx/workstreams/sales.json', { content: JSON.stringify({
      id: 'sales', name: 'Sales', tasks: [], records: [onIt('rec-s1', 'build SSO first', 'sales')],
    }) }],
    ['.teamctx/workstreams/expansion.json', { content: JSON.stringify({
      id: 'expansion', name: 'Expansion',
      records: [onIt('rec-e1', 'hold the Acme upsell until SSO ships', 'expansion', { attachedTo: { kind: 'task', id: 'acme-upsell' } })],
      tasks: [{ id: 'acme-upsell', title: 'Plan the Acme upsell', owner: 'Ada', status: 'open' }],
    }) }],
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
const contributeAs = async (actor) => JSON.parse((await runWithSession(session(), () => runWithActor(actor,
  () => makeHandlers(ROOT).contribute({ text: 'Buyers no longer need SSO before a pilot.', workstream: '' })))).content[0].text);

beforeEach(() => __resetMemory());

describe('what a scoped member is told rests on the assumption they broke', () => {
  it('the decisions in their own part of the work, by name', async () => {
    const r = await contributeAs(RAVI);
    expect(r.impact[0].records.map(x => x.text)).toEqual(['build SSO first']);
  });

  it('nothing from a part of the work they are not on: no text, no task', async () => {
    const r = await contributeAs(RAVI);
    const said = JSON.stringify(r);
    expect(said).not.toContain('Acme upsell');
    expect(said).not.toContain('rec-e1');
    expect(r.impact[0].tasks).toEqual([]);
  });

  it('only how many more there are, so somebody still takes a second look', async () => {
    const r = await contributeAs(RAVI);
    expect(r.impact[0].elsewhere).toBe(1);
    expect(r.reportBack).toContain('1 more in parts of the work you are not on');
  });

  it('a manager is told everything, as before', async () => {
    const r = await contributeAs(MANAGER);
    expect(r.impact[0].records.map(x => x.text).sort()).toEqual(['build SSO first', 'hold the Acme upsell until SSO ships']);
    expect(r.impact[0].tasks.map(t => t.title)).toEqual(['Plan the Acme upsell']);
    expect(r.impact[0].elsewhere).toBeUndefined();
  });
});
