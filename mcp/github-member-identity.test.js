/**
 * A member who signs in with GitHub is the person the roster names.
 *
 * The manager added Ashutosh by address. He signs in with a GitHub account whose
 * login is `satyagya1`, and whose verified address is the one he was added with.
 * He was named after the login — so tasks assigned to "Ashutosh" never reached
 * him, his work was credited to "satyagya1", and an assistant, left to guess who
 * that was, took the name for the manager's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/context.js', async (orig) => ({
  ...(await orig()),
  updateShared: vi.fn(async (workstream) => ({
    workstream: { ...workstream, whys: [...(workstream.whys || []), { id: 'n1', text: 'flights booked' }] },
    summary: 'adds flights',
    operations: [{ type: 'addWhy', text: 'flights booked' }],
  })),
}));

const { makeHandlers } = await import('./server.js');
const { runWithSession } = await import('../src/session-context.js');
const { runWithActor, actorFromGithubUser } = await import('../src/actor.js');
const { __resetMemory } = await import('../src/oauth/kv.js');
const { resolveIdentity } = await import('../src/prefs.js');

const ROOT = { __backend: 'github', owner: 'acme', repo: 'webhacks' };

const CONFIG = {
  project: 'Webhacks',
  me: 'Satyagya',
  managerKey: 'git:satyagyasingh@gmail.com',
  autoPush: false,
  roles: [],
  reviewPolicy: 'all',
  workstreams: [],
  activeWorkstream: null,
  workstreamsMigrated: true,
  projectLayerMigrated: true,
  members: [
    { key: 'git:satyagyas@gmail.com', name: 'Ashutosh', email: 'satyagyas@gmail.com', login: null },
    { key: 'git:ssatyagya@gmail.com', name: 'Smita', email: 'ssatyagya@gmail.com', login: null },
  ],
};

/** Ashutosh, as a GitHub sign-in hands him over: a login and no profile name. */
const ASHUTOSH = actorFromGithubUser({ id: 77, login: 'satyagya1', name: null, email: 'satyagyas@gmail.com' });

function fakeSession() {
  const files = new Map([
    ['.teamctx/config.json', { content: JSON.stringify(CONFIG) }],
    ['.teamctx/contributions.jsonl', { content: '' }],
    ['.teamctx/project.json', { content: JSON.stringify({
      name: 'Webhacks',
      whys: [{ id: 'p1', text: 'Satyagya is Manager/Event Lead' }],
      tasks: [
        { id: 'judge-flights', title: 'Sort flights for Piyush Garg', owner: 'Ashutosh', status: 'open', createdAt: '2026-09-17' },
        { id: 'college-grant', title: 'Secure the college grant', owner: 'Satyagya', ownerKey: 'git:satyagyasingh@gmail.com', status: 'open', createdAt: '2026-09-17' },
      ],
    }) }],
  ]);
  const commits = [];
  return {
    owner: 'acme', repo: 'webhacks', ghToken: 'gho', commits,
    read: p => files.get(p) || null,
    write: (p, c) => files.set(p, { content: String(c) }),
    del: p => files.delete(p),
    listDir: () => [],
    commit: async msg => { commits.push(msg); return { committed: true }; },
  };
}

const as = (actor, fn) => runWithSession(fakeSession(), () => runWithActor(actor, () => fn(makeHandlers(ROOT))));
const json = async p => JSON.parse((await p).content[0].text);

beforeEach(() => __resetMemory());

describe('a GitHub sign-in the roster names', () => {
  it('is called what the manager called them, not their GitHub login', async () => {
    const brief = await as(ASHUTOSH, h => json(h.my_brief()));
    expect(brief.me).toBe('Ashutosh');
    expect(brief.you).toEqual({ name: 'Ashutosh', email: 'satyagyas@gmail.com' });
  });

  it('sees the tasks assigned to that name, and not the manager\'s', async () => {
    const brief = await as(ASHUTOSH, h => json(h.my_brief()));
    const ids = brief.tasks.open.flatMap(g => g.tasks.map(t => t.id));
    expect(ids).toEqual(['judge-flights']);
  });

  it('is told plainly who they are, so nothing has to be guessed from the project', async () => {
    const r = await as(ASHUTOSH, h => json(h.my_brief()));
    expect(r.reportBack).toMatch(/^Tell the user: they are Ashutosh on this project\./);
  });

  it('has their work credited to that name', async () => {
    const r = await as(ASHUTOSH, h => json(h.contribute({ text: 'Flights booked for Piyush.' })));
    expect(r.author).toBe('Ashutosh');
  });

  it('is matched by GitHub login too, where the roster recorded one', async () => {
    const byLogin = actorFromGithubUser({ id: 78, login: 'smita-gh', name: 'S. G.', email: 'other@example.com' });
    const config = { ...CONFIG, members: [{ key: 'github:smita-gh', name: 'Smita', login: 'smita-gh', email: null }] };
    expect(await resolveIdentity({ actor: byLogin, config })).toEqual({ name: 'Smita', source: 'roster' });
  });
});

describe('what does not change', () => {
  it('a GitHub sign-in the roster does not name keeps their GitHub name', async () => {
    const stranger = actorFromGithubUser({ id: 9, login: 'visitor', name: 'Visitor', email: 'visitor@example.com' });
    expect(await resolveIdentity({ actor: stranger, config: CONFIG })).toEqual({ name: 'Visitor', source: 'github' });
  });

  it('a name the person chose for themselves still wins', async () => {
    const { writePrefs } = await import('../src/prefs.js');
    await runWithSession(fakeSession(), async () => {
      await writePrefs(ASHUTOSH, { name: 'Ashu' });
      expect(await resolveIdentity({ actor: ASHUTOSH, config: CONFIG })).toEqual({ name: 'Ashu', source: 'override' });
    });
  });

  it('a clone keeps the name from its own git config', async () => {
    const fromClone = { key: 'git:satyagyas@gmail.com', name: 'ashutosh-laptop', email: 'satyagyas@gmail.com', source: 'git' };
    expect(await resolveIdentity({ actor: fromClone, config: CONFIG })).toEqual({ name: 'ashutosh-laptop', source: 'git' });
  });

  it('the manager, signed in with GitHub and on no roster, keeps their own name', async () => {
    const manager = actorFromGithubUser({ id: 1, login: 'satyagyasingh', name: 'Satyagya', email: 'satyagyasingh@gmail.com' });
    const brief = await as(manager, h => json(h.my_brief()));
    expect(brief.me).toBe('Satyagya');
    expect(brief.tasks.open.flatMap(g => g.tasks.map(t => t.id))).toEqual(['college-grant']);
  });
});
