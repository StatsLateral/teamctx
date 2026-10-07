/**
 * Where a project stands, for somebody who would rather look than ask.
 *
 * Everything shown here is already in the repository; what is checked is that
 * the page reads it with the right credential, shows only what the person is
 * allowed to see, and keeps the manager's queue to the manager.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map(), prefetchError: null, gone: new Set(), unknown: new Set(), moved: new Map() }));

vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  listPushableRepos: async () => [],
  listUserOrgs: async () => [],
  repoExistence: async (token, owner, name) => (repo.gone.has(`${owner}/${name}`) ? { state: 'gone' } : repo.unknown.has(`${owner}/${name}`) ? { state: 'unknown' } : { state: 'exists', fullName: repo.moved.get(`${owner}/${name}`) ?? null }),
  GithubSession: class {
    constructor({ owner, repo: name, ghToken }) {
      Object.assign(this, { owner, repo: name, ghToken });
      repo.usedToken = ghToken;
    }

    async prefetch() { if (repo.prefetchError) throw new Error(repo.prefetchError); }

    read(p) { return repo.files.has(p) ? { content: repo.files.get(p) } : null; }

    write() {}

    del() {}

    listDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...repo.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(p => p.slice(prefix.length)).sort();
    }

    async commit() { return { committed: true }; }
  },
}));

const { kvSet, kvGet, keys, __resetMemory } = await import('../src/oauth/kv.js');
const { readProjectView } = await import('../src/oauth/project-view.js');
// The remembered verdict on a repository, so a test can let it lapse.
const __resetKnown = () => kvSet(keys.repoState('maya@example.com', 'acme', 'old-demo'), null);

let server, base;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://team.example.app';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-secret';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const MANAGER = { id: '7', login: 'maya', name: 'Maya', email: 'maya@example.com', token: 'gho-maya' };
const MEMBER_GOOGLE = { id: null, login: null, name: 'Priya', email: 'priya@example.com', token: null, source: 'google' };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', number: 1, name: 'Product' }, { id: 'tech', number: 2, name: 'Tech' }],
  roles: [],
  members: [
    { key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com', workstreams: ['product'] },
    { key: 'git:dev@example.com', name: 'Dev', email: 'dev@example.com' },
    { key: 'agent:a1', name: 'Nightly report', kind: 'agent' },
  ],
};

function project() {
  repo.files = new Map([
    ['.teamctx/config.json', JSON.stringify(CONFIG)],
    ['.teamctx/contributions.jsonl', [
      JSON.stringify({ id: 'c-prod', author: 'Priya', source: 'mcp', text: 'pricing notes', workstream: 'product' }),
      JSON.stringify({ id: 'c-tech', author: 'Dev', source: 'cli', text: 'uptime notes', workstream: 'tech' }),
      JSON.stringify({ id: 'c-loose', author: 'Nobody', source: 'cli', text: 'unreferenced', workstream: null }),
    ].join('\n')],
    ['.teamctx/project.json', JSON.stringify({ name: 'Ledger', records: [{ id: 'p1', type: 'decision', text: 'ship it', status: 'active' }], tasks: [] })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product',
      records: [{ id: 'w1', type: 'decision', text: 'price it', status: 'active', detail: 'how we price', sourceContributionIds: ['c-prod'] }],
      tasks: [{ id: 'pricing-page', key: '1.1', title: 'Draft the pricing page', owner: 'Priya', status: 'open', sourceContributionIds: ['c-prod'] }],
    })],
    ['.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech',
      records: [{ id: 't1', type: 'decision', text: 'keep the servers up', status: 'active', sourceContributionIds: ['c-tech'] }],
      tasks: [
        { id: 'migrate-db', key: '2.1', title: 'Migrate the database', owner: 'Dev', status: 'open' },
        { id: 'old-thing', key: '2.2', title: 'Something finished', owner: 'Dev', status: 'done' },
      ],
    })],
    ['.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', number: '1.2', status: 'pending', author: 'Priya', summary: 'adds the pricing tiers', workstream: 'product',
    })],
  ]);
  repo.prefetchError = null;
}

/**
 * The page as somebody reads it: not the drawer's on-demand text, the data the
 * assistant buttons use, scripts, styles or icons. "Not on the page" means not
 * here; the drawer shows context only when it is asked to.
 */
const onPage = (html) => html
  .replace(/<aside class="drawer"[\s\S]*?<\/aside>/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<svg[\s\S]*?<\/svg>/g, '');

async function visit(path, user) {
  if (user) await kvSet(keys.session('s'), user);
  const res = await fetch(`${base}${path}`, {
    method: 'GET', redirect: 'manual', headers: user ? { cookie: 'teamctx_sid=s' } : {},
  });
  return { status: res.status, location: decodeURIComponent(res.headers.get('location') || ''), body: await res.text() };
}

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

function rowPrompt(body, id = 't-pricing-page') {
  return new RegExp(`id="${id}"[^>]*data-prompt="([^"]+)"`).exec(body)[1];
}

beforeEach(() => {
  __resetMemory();
  repo.gone = new Set();
  repo.unknown = new Set();
  repo.moved = new Map();
  project();
});

describe('the manager looking at a project', () => {
  it('sees the parts of the work and who is on each', async () => {
    const { status, body } = await visit('/project/acme/ledger', MANAGER);
    expect(status).toBe(200);
    expect(body).toMatch(/Product[\s\S]*Priya/);
    expect(body).toMatch(/Tech[\s\S]*Dev/);
  });

  it('sees every open task and who has it, and a count of what is done', async () => {
    const { body } = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    expect(body).toContain('Draft the pricing page');
    expect(body).toContain('Migrate the database');
    expect(onPage(body)).not.toContain('Something finished');
    expect(body).toContain('Show history (1 done)');
  });

  it('sees what is waiting on them', async () => {
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toContain('Waiting on you');
    expect(body).toContain('adds the pricing tiers');
  });

  it('reads the project with their own GitHub token', async () => {
    await visit('/project/acme/ledger', MANAGER);
    expect(repo.usedToken).toBe('gho-maya');
  });
});

describe('a member looking at the same project', () => {
  it('reads it through the access the project lends', async () => {
    await lend();
    const { status } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(status).toBe(200);
    expect(repo.usedToken).toBe('gh-lent');
  });

  it('sees only the part of the work they are on', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger?tab=tasks', MEMBER_GOOGLE);
    expect(body).toContain('Draft the pricing page');
    expect(body).not.toContain('Migrate the database');
    // Scope is the sidebar now: the parts they are on are there to open, and
    // the ones they are not on are not on the page at all.
    expect(body).toContain('>Product<');
    expect(body).not.toContain('>Tech<');
  });

  it('is not shown the approval queue, which is the manager\'s', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('Waiting on you');
    expect(body).not.toContain('adds the pricing tiers');
  });

  it('is refused on a project whose roster does not name them', async () => {
    await lend();
    const { status, body } = await visit('/project/acme/ledger', { ...MEMBER_GOOGLE, email: 'stranger@example.com' });
    expect(status).toBe(403);
    expect(body).toMatch(/not on the acme\/ledger roster/);
  });

  it('is told plainly when the project lends no access to read it with', async () => {
    const { status, body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(status).toBe(403);
    expect(body).toMatch(/has not lent GitHub access/);
  });
});

describe('who counts as the manager', () => {
  it('is nobody, on a project with no gate — the roster still decides', async () => {
    // `canApprove` answers yes to everyone where no gate is pinned. Used here,
    // that let any Google account read any project that lends access.
    repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, managerKey: undefined, members: [] }));
    await lend();
    const { status, body } = await visit('/project/acme/ledger', { ...MEMBER_GOOGLE, email: 'stranger@example.com' });
    expect(status).toBe(403);
    expect(body).toMatch(/not on the acme\/ledger roster/);
  });

  it('is not somebody who named themselves after a legacy display-name gate', async () => {
    repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, managerKey: undefined, manager: 'Maya', members: [] }));
    await lend();
    const { status } = await visit('/project/acme/ledger', { ...MEMBER_GOOGLE, name: 'Maya', email: 'stranger@example.com' });
    expect(status).toBe(403);
  });

  it('is the address on the gate, however they signed in', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', { ...MEMBER_GOOGLE, email: 'maya@example.com' });
    // Being the manager shows in what the page gives them, not in a line
    // telling them so.
    expect(body).toContain('Waiting on you');
  });
});

describe('what the page does with what the repo says', () => {
  it("escapes a project name, which is somebody else's text", async () => {
    repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, project: '</title><script>alert(1)</script>' }));
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;/title&gt;&lt;script&gt;');
  });
});

describe('getting there', () => {
  it('lists the projects somebody is on', async () => {
    await kvSet(keys.connectedProjects('maya@example.com'), { projects: ['acme/ledger'] });
    const { body } = await visit('/projects', MANAGER);
    expect(body).toContain('href="/project/acme/ledger"');
  });

  it('says so when there are none yet', async () => {
    expect((await visit('/projects', MANAGER)).body).toMatch(/Nothing on your list yet/);
  });

  it('leads back to the list from a project', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('href="/projects">← All projects');
  });

  it('sends a signed-out visitor to sign in, and back again', async () => {
    const r = await visit('/project/acme/ledger');
    expect(r.status).toBe(303);
    expect(r.location).toBe('/signin?returnTo=/project/acme/ledger');
  });

  it('reports a repository it cannot read, rather than failing silently', async () => {
    repo.prefetchError = 'github: repo acme/ledger not found (or PAT lacks access)';
    const { status, body } = await visit('/project/acme/ledger', MANAGER);
    expect(status).toBe(403);
    expect(body).toMatch(/could not be read/);
  });

  describe('a project whose repository was deleted on GitHub', () => {
    const list = async (user = MANAGER) => (await visit('/projects', user)).body;
    const known = (...slugs) => kvSet(keys.connectedProjects('maya@example.com'), { projects: slugs });

    it('is left off the list, and the ones that still exist stay', async () => {
      await known('acme/ledger', 'acme/old-demo', 'acme/other-test');
      repo.gone = new Set(['acme/old-demo', 'acme/other-test']);
      const body = await list();
      expect(body).toContain('acme/ledger');
      expect(body).not.toContain('acme/old-demo');
      expect(body).not.toContain('acme/other-test');
    });

    it('is not removed from what teamctx remembers: it comes back if the repository does', async () => {
      await known('acme/ledger', 'acme/old-demo');
      repo.gone = new Set(['acme/old-demo']);
      expect(await list()).not.toContain('acme/old-demo');
      expect((await kvGet(keys.connectedProjects('maya@example.com'))).projects).toEqual(['acme/ledger', 'acme/old-demo']);
      repo.gone = new Set();
      __resetKnown();
      await known('acme/ledger', 'acme/old-demo');
      expect(await list()).toContain('acme/old-demo');
    });

    it('says there is nothing on the list when every project is gone', async () => {
      await known('acme/old-demo');
      repo.gone = new Set(['acme/old-demo']);
      expect(await list()).toMatch(/Nothing on your list yet/);
    });

    it('is shown under its current name when the repository was renamed or moved, not listed twice', async () => {
      await known('oldorg/ledger', 'acme/ledger');
      repo.moved = new Map([['oldorg/ledger', 'acme/ledger']]);
      const body = await list();
      expect(body).not.toContain('oldorg/ledger');
      expect(body.match(/acme\/ledger/g).length).toBeGreaterThan(0);
      expect(body).toMatch(/href="\/project\/acme\/ledger"/);
    });

    it('stays on the list when GitHub cannot say, which is not the same as gone', async () => {
      await known('acme/ledger', 'acme/flaky');
      repo.unknown = new Set(['acme/flaky']);
      const body = await list();
      expect(body).toContain('acme/ledger');
      expect(body).toContain('acme/flaky');
    });
  });
});

describe('the goal and why it matters, opening the page', () => {
  const setGoal = (goal) => repo.files.set('.teamctx/project.json', JSON.stringify({ name: 'Ledger', goal, records: [], tasks: [] }));
  const block = (body) => /<div class="goal-block" id="goal-block">[\s\S]*?<\/div>/.exec(body)?.[0];

  it('shows the goal, then why it matters, directly under the title', async () => {
    setGoal({ text: 'Open conversations at four health systems', why: 'Buyers ignore cold outreach' });
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const goal = block(body);
    expect(goal).toContain('<p class="goal-text">Open conversations at four health systems</p>');
    expect(goal).toContain('<p class="goal-why">Buyers ignore cold outreach</p>');
    expect(goal.indexOf('goal-text')).toBeLessThan(goal.indexOf('goal-why'));
    expect(body.indexOf('<h1>')).toBeLessThan(body.indexOf('id="goal-block"'));
    expect(body.indexOf('id="goal-block"')).toBeLessThan(body.indexOf('class="layout"'));
  });

  it('shows only the goal when there is no why, with no placeholder', async () => {
    setGoal({ text: 'Open conversations' });
    const goal = block((await visit('/project/acme/ledger', MANAGER)).body);
    expect(goal).toContain('goal-text');
    expect(goal).not.toContain('goal-why');
  });

  it('shows nothing when the project has no goal yet', async () => {
    setGoal(null);
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).not.toContain('id="goal-block"');
  });

  it('escapes both lines, which are somebody else’s text', async () => {
    setGoal({ text: '<script>alert(1)</script>', why: '<img src=x onerror="alert(2)">' });
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toContain('<img src=x onerror');
    expect(block(body)).toContain('&lt;script&gt;');
  });

  it('shows it once, and not as a row in the work', async () => {
    setGoal({ text: 'Reach ten enterprise pilots', why: 'Because' });
    for (const path of ['/project/acme/ledger', '/project/acme/ledger?tab=review']) {
      const { body } = await visit(path, MANAGER);
      expect(onPage(body).match(/Reach ten enterprise pilots/g), path).toHaveLength(1);
    }
  });

  it('is shown to a member too: the goal belongs to the project, not to a part of it', async () => {
    setGoal({ text: 'Reach ten enterprise pilots' });
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(block(body)).toContain('Reach ten enterprise pilots');
  });

  it('is limited to three lines in all, the goal two at most and the why what is left', async () => {
    const { whyLinesLeft } = await import('../src/views/project.js');
    expect([1, 2, 3, 6].map(whyLinesLeft)).toEqual([2, 1, 1, 1]);
    setGoal({ text: 'A goal', why: 'A why' });
    const { body } = await visit('/project/acme/ledger', MANAGER);
    // The no-JavaScript answer, then the script that does it properly.
    expect(body).toMatch(/\.goal-text\{[^}]*-webkit-line-clamp:2/);
    expect(body).toMatch(/\.goal-why\{[^}]*-webkit-line-clamp:1/);
    expect(body).toContain('var whyLinesLeft = (goalLines) => Math.max(1, 3 - Math.min(2, goalLines))');
    expect(body).toContain('document.fonts.ready.then(fit)');
    expect(body).toContain("window.addEventListener('resize', fit)");
  });

  it('does not cut what is stored: the whole text is in the page, only the display is clamped', async () => {
    const long = 'word '.repeat(300).trim();
    setGoal({ text: long, why: long });
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(block(body).split(long).length - 1).toBe(2);
  });
});

describe('what the data function hands back', () => {

  it('gives a member the trees they are on, and no others', async () => {
    await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(Object.keys(view.trees)).toEqual(['product']);
    expect(JSON.stringify(view.trees)).not.toContain('keep the servers up');
  });

  it('keeps a member scoped when the roster knows them by GitHub id', async () => {
    // The gate admits somebody on a key their address has proved, so the scope
    // lookup has to recognise the same key. If only the gate did, the member
    // would be let in and then not found — and a member nobody can find has no
    // scope, meaning every tree in the payload.
    repo.files.set('.teamctx/config.json', JSON.stringify({
      ...CONFIG,
      members: [{ key: 'github:4242', name: 'Priya', workstreams: ['product'] }],
    }));
    await lend();
    await kvSet(keys.githubIdentities('priya@example.com'), { ids: ['4242'] });
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(Object.keys(view.trees)).toEqual(['product']);
    expect(JSON.stringify(view.trees)).not.toContain('keep the servers up');
  });

  it('gives the manager all of them', async () => {
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MANAGER });
    expect(Object.keys(view.trees).sort()).toEqual(['product', 'tech']);
  });

  it('always carries the project tree, which everybody inherits', async () => {
    await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(view.projectTree.records[0].text).toBe('ship it');
  });

  it('carries the contributions behind the trees it sent, and no more', async () => {
    await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(Object.keys(view.contributions)).toEqual(['c-prod']);
  });
});

describe('the space above the work', () => {
  it('is a back link and the name, with the repository line gone', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const header = body.slice(body.indexOf('class="crumb"'), body.indexOf('class="layout"'));
    expect(header).toContain('All projects');
    expect(header).toContain('Ledger');
    expect(header).not.toContain('class="muted slug"');
    expect(header).not.toContain('acme/ledger');
    // Whether you manage the project is not news to you, and it cost a line
    // that pushed the work below where the eye lands.
    expect(header).not.toMatch(/you manage this project|you are on this project/);
  });

  it('does not tell a member their standing either', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('you are on this project');
  });
});

/**
 * Settings: the project's plumbing, pinned at the foot of the left column.
 *
 * The one thing in it that matters today is the address an assistant is
 * connected with. It is shown shortened (a person copies it, they do not read
 * it) and the button copies the whole thing.
 */
describe('the Settings block', () => {
  const block = (body) => /<section class="settings"[\s\S]*?<\/section>/.exec(body)?.[0];
  const FULL = 'https://team.example.app/api/mcp/acme/ledger';

  it('holds the connector address, shortened, with the whole address in the tooltip', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const settings = block(body);
    expect(settings).toContain('class="section-title">Settings<');
    expect(settings).toMatch(/<span class="mcp-url" id="mcp-url" title="https:\/\/team\.example\.app\/api\/mcp\/acme\/ledger"[^>]*>team\.example\.app\/…\/acme\/ledger<\/span>/);
  });

  it('copies the whole address, never the shortened text', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const button = /<button type="button" class="copy-url"[^>]*>/.exec(body)[0];
    expect(button).toContain(`data-url="${FULL}"`);
    expect(button).toContain('aria-label="Copy the MCP URL"');
    expect(body).toContain('Add this as a custom connector in Claude, ChatGPT or Copilot');
    expect(body).toContain('copyText(b.dataset.url)');
  });

  it('is read-only text: no input or textarea carries the address', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    // The page has task filters (selects), but no field holding the address.
    expect(body).not.toMatch(/<(input|textarea)[^>]*(mcp|api\/mcp)/);
    expect(block(body)).not.toMatch(/<(input|textarea)/);
  });

  it('falls back to the browser copy command where there is no clipboard API', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('navigator.clipboard && navigator.clipboard.writeText');
    expect(body).toContain("document.execCommand('copy')");
    // The check mark returns to the copy icon after about 1.6 seconds.
    expect(body).toContain("b.classList.add('done')");
    expect(body).toContain('}, 1600);');
  });

  it('is shown to a member too: the address grants nothing, the connector still signs them in', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(block(body)).toContain(`data-url="${FULL}"`);
  });

  it('escapes a repository name that needs it', async () => {
    const view = await import('../src/views/project.js');
    const html = view.projectPage({
      user: { name: 'x' },
      view: {
        project: 'P', owner: 'a"b', repo: '<c>', isManager: false, workstreams: [], projectTree: {}, trees: {},
        contributions: {}, tasks: { open: [], done: [] }, pending: null,
      },
      selected: null, origin: 'https://h.test',
    });
    expect(html).not.toContain('<c>');
    expect(html).toContain('/api/mcp/a%22b/%3Cc%3E');
  });

  it('is left out when the page does not know its own address, rather than guessed', async () => {
    const view = await import('../src/views/project.js');
    const html = view.projectPage({
      user: { name: 'x' },
      view: { project: 'P', owner: 'a', repo: 'b', isManager: false, workstreams: [], projectTree: {}, trees: {}, contributions: {}, tasks: { open: [], done: [] }, pending: null },
      selected: null, origin: null,
    });
    expect(html).not.toContain('class="settings"');
  });

  it('sits at the foot of a pinned left column, after the work and inside the same column', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const rail = /<aside>\s*<div class="rail-work">[\s\S]*?<section class="settings"[\s\S]*?<\/aside>/.exec(body)?.[0];
    expect(rail).toBeTruthy();
    expect(rail.indexOf('The work')).toBeLessThan(rail.indexOf('class="settings"'));
    expect(body).toMatch(/\.layout>aside\{position:sticky;top:12px;display:flex;flex-direction:column;[^}]*max-height:calc\(100vh - 24px\)\}/);
    expect(body).toMatch(/\.rail-work\{[^}]*overflow-y:auto/);
    expect(body).toMatch(/\.settings\{flex:none/);
  });

  it('is fitted to the screen on scroll, resize and when fonts load, with 260px as the least', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain("window.addEventListener('scroll', fitRail");
    expect(body).toContain("window.addEventListener('resize', fitRail)");
    expect(body).toContain('document.fonts.ready.then(fitRail)');
    expect(body).toContain('Math.max(260, window.innerHeight - top - 12)');
  });

  it('is an ordinary section after the work under 900px: one column, no pinning', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const narrow = body.slice(body.indexOf('@media(max-width:900px)'));
    expect(narrow).toMatch(/\.layout\{grid-template-columns:1fr\}/);
    expect(narrow).toMatch(/\.layout>aside\{position:static;min-height:0;max-height:none\}/);
    expect(narrow).toMatch(/\.rail-work\{overflow:visible\}/);
    expect(body).toContain("window.matchMedia('(min-width: 901px)')");
  });

  it('sits beside the tree and the drawers, which still work', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('class="tree"');
    expect(body).toContain('id="drawer"');
    expect(body).not.toContain('id="lane-pick"');
  });

  it('counts the team and the agents beneath the address', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const settings = /<section class="settings"[\s\S]*?<\/section>/.exec(body)[0];
    expect(settings).toContain('<p class="stline">2 team members</p>');
    expect(settings).toContain('<p class="stline">1 agent</p>');
  });
});

describe('knowing you are the manager', () => {
  it('says so beside the name, not in a line of its own', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/<h1>Ledger <span class="role-chip">Manager<\/span><\/h1>/);
  });

  it('says nothing of the sort to somebody who is not', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toMatch(/<span class="role-chip">/);
  });
});

describe('what a copied prompt asks for', () => {
  // Written this way so the newline cannot be mistaken for the escape
  // sequence of whatever rewrote this file last.
  const NL = String.fromCharCode(10);

  it('asks about the one task, not the project around it', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = rowPrompt(body);
    expect(prompt).toContain('tell me about that one thing');
    expect(prompt).toContain('what is still open for it');
    expect(prompt).toContain('Do not summarise the rest of the project');
  });

  it("asks for it in a colleague's words, not in the project's", async () => {
    // What came back read like a tour of the data model: headings, field names,
    // and a walk back up the tree, to somebody who asked about one line on a
    // page and does not care how it is stored.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = rowPrompt(body);
    expect(prompt).toContain('the way a colleague would');
    expect(prompt).toContain('Do not explain how the project stores any of this');
    expect(prompt).toContain('do not walk me back up the structure');
    // What to talk about, and nothing about how to lay it out. Banning headings
    // and lists was the wrong lever: the subject was wrong, not the shape, and a
    // model told how to format itself loses formatting it would have chosen well.
    expect(prompt).not.toMatch(/heading|bullet/i);
  });

  it('opens with the question and keeps the instructions below it', async () => {
    // A hundred words in a single line is correct and frightening: the person
    // who has just pasted it cannot see its shape, so they delete it. And what
    // they see first should be their own question, not teamctx clearing its
    // throat.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = rowPrompt(body);
    const text = prompt.replace(/&#10;/g, NL);
    expect(text.split(NL).length).toBeGreaterThan(8);
    // The question first, in the words somebody would use out loud, and
    // everything the assistant has to do below it, addressed to the assistant.
    expect(text.startsWith('Tell me more about task 1.1: &quot;Draft the pricing page&quot;.')).toBe(true);
    expect(text).toContain(`${NL}${NL}Instructions for the AI agent:${NL}- `);
    // Every instruction on a line of its own.
    expect(text.split(NL).filter(l => l.startsWith('- ')).length).toBeGreaterThan(4);
  });

  it('keeps those newlines inside the attribute, not in the markup', async () => {
    // A raw newline in an attribute would survive the browser but split the
    // button across lines; an entity keeps both the markup and the clipboard
    // right. If this ever regresses, every prompt-reading test above, which
    // matches up to the closing quote, starts reading half a prompt.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toContain('&#10;');
    expect(body).not.toMatch(new RegExp(`data-prompt="[^"]*${NL}`));
  });
});

describe('stored fields are never trusted as markup', () => {
  it('a record type crafted to break out of an attribute is not rendered as one', async () => {
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', tasks: [],
      records: [{ id: 'evil', type: 'x" onfocus="alert(1)" autofocus x="', text: 'hello', status: 'active', attachedTo: { kind: 'workstream', id: 'product' }, links: {} }],
    }));
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).not.toContain('onfocus="alert(1)"');
  });
});

/**
 * A link that points at nothing leaves nothing behind.
 *
 * `ws` has always fallen back when it names a part of the work that is not
 * there, or not this reader's. `item` did not: it rode along in the view
 * toggle's own links, so a value that pointed at nothing was written back into
 * the page anyway — which is the one thing this route says it never does.
 */
/**
 * Context lives in the assistant, and the drawer is the plain-English view of it.
 *
 * The project's and a workstream's decisions, rules and assumptions are not
 * listed on the page. A drawer shows them when asked, in wording only, and
 * carries the same assistant actions as a task. What it shows, and what the
 * assistant is handed, is scoped to the reader.
 */
/**
 * The page's own JavaScript has to be JavaScript.
 *
 * It is built from template strings, where an escape is processed twice, so a
 * "\n" meant for the browser can arrive as a real newline inside a string and
 * stop every script on the page. Nothing server-side notices, so this parses
 * each inline script the page sends.
 */
describe('the scripts on the page', () => {
  const inlineScripts = (html) => [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(Boolean);

  it.each([
    ['/project/acme/ledger'],
    ['/project/acme/ledger?ws=product'],
    ['/project/acme/ledger?tab=review'],
  ])('parse, on %s', async (path) => {
    const { body } = await visit(path, MANAGER);
    const scripts = inlineScripts(body);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  });

  it('keep the newlines they join prompts with as escapes, not as line breaks inside a string', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain("scoped.full + '\\n---\\n'");
  });
});

describe('the project and workstream drawers', () => {
  const FULL_PROJECT = { name: 'Ledger', goal: { text: 'Reach ten pilots', why: 'Pilots turn into revenue and referrals' }, tasks: [],
    records: [
      { id: 'p1', type: 'decision', text: 'Fixed price for pilots', status: 'active', detail: 'Easier to approve' },
      { id: 'p2', type: 'rule', text: 'No discounts over 15%', status: 'active' },
      { id: 'p3', type: 'exception', text: 'Acme may get 20%', status: 'active', expiresAt: '2999-01-01', links: { bends: 'p2' } },
      { id: 'p4', type: 'assumption', text: 'Buyers need SSO', status: 'active', owner: { name: 'O' }, reviewBy: '2999-01-01' },
    ] };
  beforeEach(() => repo.files.set('.teamctx/project.json', JSON.stringify(FULL_PROJECT)));
  const panel = (body, id) => new RegExp(`<section class="dpanel" id="${id}"[\\s\\S]*?</section>`).exec(body)?.[0];
  const promptMap = (body) => JSON.parse(/<script type="application\/json" id="prompts">([\s\S]*?)<\/script>/.exec(body)[1]);

  it('opens from an icon beside the goal and one beside each workstream\'s heading', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/<button type="button" class="ctx-open" data-panel="dp-project" aria-label="Read the full goal and why it matters"/);
    expect(body).toMatch(/data-panel="dp-ws-product" aria-label="Context for Product"/);
    expect(body).toMatch(/data-panel="dp-ws-tech" aria-label="Context for Tech"/);
  });

  it('puts no context icon in the tree: the tree is for choosing, the headings are for reading', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(/<ul class="tree">[\s\S]*?<\/ul>\s*<\/li><\/ul>/.exec(body)[0]).not.toContain('ctx-open');
  });

  it('puts the goal and why in full, then the project context in plain English', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const project = panel(body, 'dp-project');
    expect(project).toContain('data-title="Project · Summary and context"');
    expect(project).toContain('Reach ten pilots');
    expect(project).toContain('Pilots turn into revenue and referrals');
    for (const heading of ['We decided', 'Rules', "We're assuming"]) expect(project).toContain(`<h3>${heading}</h3>`);
    expect(project).toContain('Fixed price for pilots');
    expect(project).toContain('Why: Easier to approve');
    expect(project).toContain('Buyers need SSO');
    expect(project.indexOf('Reach ten pilots')).toBeLessThan(project.indexOf('We decided'));
  });

  it('always shows an exception together with the rule it bends', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const project = panel(body, 'dp-project');
    expect(project.indexOf('No discounts over 15%')).toBeLessThan(project.indexOf('Allowed: Acme may get 20%'));
    expect(project).toContain('instead of the rule: No discounts over 15%');
  });

  it('says only the words: no number, id or letter key', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const project = panel(body, 'dp-project');
    expect(project).not.toMatch(/\bp[1-4]\b|\b[TDRAXQ]-\d+\b|rec-/);
  });

  it('gives a workstream its own context and says the project context also applies', async () => {
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', tasks: [],
      records: [{ id: 'w1', type: 'decision', text: 'Price by seat', status: 'active' }],
    }));
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const ws = panel(body, 'dp-ws-product');
    expect(ws).toContain('data-title="Workstream 1"');
    expect(ws).toContain('<p class="statement">Product</p>');
    expect(ws).toContain('Context for this part of the work');
    expect(ws).toContain('Price by seat');
    expect(ws).toContain('The project context also applies.');
    expect(ws).not.toContain('Fixed price for pilots');
    expect(panel(body, 'dp-ws-tech')).not.toContain('Price by seat');
  });

  it('says so when a part of the work has nothing yet', async () => {
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({ id: 'tech', name: 'Tech', records: [], tasks: [] }));
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(panel(body, 'dp-ws-tech')).toContain('Nothing has been decided for this part of the work yet.');
  });

  it('is scoped: a member is sent only their part, and the index counts what they cannot see', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(panel(body, 'dp-ws-product')).toBeTruthy();
    expect(panel(body, 'dp-ws-tech')).toBeUndefined();
    const prompts = promptMap(body);
    expect(Object.keys(prompts.ws)).toEqual(['product']);
    expect(prompts.project.full).toContain('- 1 part you cannot see');
    const everything = JSON.stringify(prompts) + panel(body, 'dp-project');
    expect(everything).not.toContain('keep the servers up');
    expect(everything).not.toContain('Migrate the database');
    expect(everything).not.toContain('Tech');
  });

  it('puts a task in the sentence that leads to its workstream\'s context', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toContain('Your assistant reads the approved context for this task.');
    expect(body).toContain('id="d-ctx-open"');
    expect(body).toMatch(/id="t-pricing-page"[^>]*data-ws="product"/);
  });

  it('carries the prompt data as inert JSON that stored text cannot break out of', async () => {
    repo.files.set('.teamctx/project.json', JSON.stringify({ ...FULL_PROJECT, goal: { text: '</script><script>alert(1)</script>', why: 'x' } }));
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).not.toContain('</script><script>alert(1)');
    expect(promptMap(body).project.full).toContain('</script><script>alert(1)</script>');
  });
});

describe('the assistant block in the drawer', () => {
  const block = (body) => /<section class="assist"[\s\S]*?<\/section>/.exec(body)[0];

  it('is three assistant icons and a copy icon, each a button with its own name', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const assist = block(body);
    const buttons = [...assist.matchAll(/<button type="button" class="chatico" data-go="(\w+)" aria-label="([^"]+)" title="([^"]+)">/g)];
    expect(buttons.map(m => [m[1], m[2]])).toEqual([
      ['claude', 'Open in Claude'],
      ['chatgpt', 'Open in ChatGPT'],
      ['copilot', 'Copy the prompt, then open Copilot'],
      ['copy', 'Copy full prompt'],
    ]);
    expect(buttons[3][3]).toBe('Copy the full prompt (works in any chatbot)');
  });

  it('has no text buttons for these actions, and no old copy button', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(block(body)).not.toMatch(/>\s*(Open in Claude|Open in ChatGPT|Copy full prompt|Copy, then open Copilot)\s*</);
    expect(body).not.toContain('Copy a prompt for your assistant');
    expect(body).not.toContain('id="copy"');
  });

  it('keeps the connected / paste switch, the Copilot note and the prompt preview', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const assist = block(body);
    expect(assist).toContain('Assistant is connected to teamctx');
    expect(assist).toContain('Paste the context in');
    expect(assist).toMatch(/name="amode" value="connected" checked/);
    expect(assist).toContain('Copilot cannot be prefilled by link, so its icon copies the prompt first.');
    expect(assist).toContain('See the prompt first');
    expect(assist).toContain('id="d-prompt"');
  });

  it('uses the assistants\' own marks inline, with no request to a third party', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const assist = block(body);
    expect(assist.match(/<svg/g).length).toBe(4);
    expect(assist).toContain('fill="#D97757"');
    expect(assist).toContain('fill="currentColor"');
    expect(assist).not.toMatch(/<img|https?:\/\/[^"' ]*\.(svg|png)/);
  });

  it('runs the same decision the tests check', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('var assistantPlan = (kind, mode, prompts) => {');
    expect(body).toContain("window.open(plan.open, '_blank', 'noopener')");
    expect(body).toContain("navigator.clipboard && navigator.clipboard.writeText");
    expect(body).toContain("document.execCommand('copy')");
  });

  it('is in every drawer: one block shared by tasks, queue items and both context levels', async () => {
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body.match(/class="assist"/g)).toHaveLength(1);
    expect(body).toMatch(/id="d-task"[\s\S]*id="dp-project"[\s\S]*class="assist"/);
  });
});

/**
 * No letter key anywhere a person can read.
 *
 * The page, its drawers and the prompts behind them are crawled for both roles,
 * with legacy-looking `key` fields planted on records and in the queue, because
 * stored text is somebody else's and must never be shown as if it were a number.
 */
describe('no old-style key on any page', () => {
  const OLD_KEY = /\b[TDRAXQ]-\d+\b/;
  const PATHS = ['/project/acme/ledger', '/project/acme/ledger?ws=product', '/project/acme/ledger?tab=review',
    '/project/acme/ledger?task=1.1', '/project/acme/ledger?review=1.2', '/project/acme/ledger?ws=tech&tab=tasks'];

  beforeEach(() => {
    repo.files.set('.teamctx/project.json', JSON.stringify({
      name: 'Ledger', tasks: [],
      records: [{ id: 'p1', key: 'D-1', type: 'decision', text: 'ship it', status: 'active' }],
    }));
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', number: '1.2', status: 'pending', author: 'Priya', summary: 'adds the pricing tiers', workstream: 'product',
      operations: [
        { type: 'addRecord', record: { type: 'rule', text: 'Annual only', key: 'R-9' } },
        { type: 'addTask', title: 'Quote them', key: 'T-14' },
      ],
    }));
  });

  it('holds for the manager', async () => {
    for (const path of PATHS) expect((await visit(path, MANAGER)).body, path).not.toMatch(OLD_KEY);
  });

  it('holds for a member', async () => {
    await lend();
    for (const path of PATHS) expect((await visit(path, MEMBER_GOOGLE)).body, path).not.toMatch(OLD_KEY);
  });
});

describe('an item that names nothing', () => {
  it('is not carried into the page, by id or by number', async () => {
    const byId = await visit('/project/acme/ledger?ws=product&item=task-gone', MANAGER);
    const byNumber = await visit('/project/acme/ledger?ws=product&item=9.9', MANAGER);
    expect(byId.body).not.toContain('task-gone');
    expect(onPage(byNumber.body)).not.toMatch(/9\.9/);
  });

  it('is dropped even when it would pass the id rules', async () => {
    // The check is whether it reaches something, not whether it looks plausible.
    const { body } = await visit('/project/acme/ledger?ws=product&item=pricing.but.not', MANAGER);
    expect(body).not.toContain('pricing.but.not');
  });

  it('is out of scope for a member, so it is dropped for them', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger?item=migrate-db', MEMBER_GOOGLE);
    expect(body).not.toContain('migrate-db');
    expect(body).not.toMatch(/class="item[^"]*marked/);
  });
});

/**
 * The page's flag crosses scope; the assumption behind it does not.
 *
 * This is the one read path where the two halves of #120 pull against each
 * other. Working out what rests on a broken assumption needs every record in the
 * project, and #108's standing guarantee is that an out-of-scope tree is absent
 * from the payload rather than hidden by the markup. So the records are read
 * wide, used to answer one question, and only the mark is written onto the
 * records being sent.
 */
describe('a record resting on a broken assumption, on the page', () => {
  const breakIt = () => {
    // The assumption lives in `tech`, which a member on `product` never sees.
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech',
      records: [{
        id: 'a1', type: 'assumption', text: 'the vendor keeps their uptime promise',
        status: 'broken', brokenAt: '2026-10-05T09:00:00.000Z',
        owner: { key: 'git:o@x', name: 'O' }, reviewBy: '2026-12-01',
        attachedTo: { kind: 'workstream', id: 'tech' }, links: {},
      }],
      tasks: [],
    }));
  };
  const restOnIt = (over = {}) => {
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product',
      records: [{
        id: 'w1', type: 'decision', text: 'price it', status: 'active',
        attachedTo: { kind: 'workstream', id: 'product' },
        links: { restsOn: ['a1'] }, sourceContributionIds: ['c-prod'], ...over,
      }],
      tasks: [],
    }));
  };

  it('marks the decision for the manager', async () => {
    breakIt(); restOnIt();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MANAGER });
    expect(view.trees.product.records[0].needsReview).toMatch(/rests on a broken assumption/);
  });

  it('marks it for a member who cannot see the assumption at all', async () => {
    breakIt(); restOnIt(); await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(Object.keys(view.trees)).toEqual(['product']);
    expect(view.trees.product.records[0].needsReview).toMatch(/rests on a broken assumption/);
  });

  it('still keeps the assumption and its tree out of what that member is sent', async () => {
    // The guarantee the wide read must not break: the words of the broken
    // assumption, and the tree it lives in, are absent — only the sentence
    // crossed. Its *id* is in the payload, and was before any of this: it is in
    // the decision's own `links.restsOn`, which is the decision's content rather
    // than something the flag carried over.
    breakIt(); restOnIt(); await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    const sent = JSON.stringify(view);
    expect(sent).not.toContain('the vendor keeps their uptime promise');
    expect(Object.keys(view.trees)).toEqual(['product']);
  });

  it('is not listed on the page, and neither is the assumption it rests on', async () => {
    breakIt(); restOnIt();
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(onPage(body)).not.toContain('price it');
    expect(onPage(body)).not.toContain('the vendor keeps their uptime promise');
    expect(onPage(body)).not.toContain('rests on a broken assumption');
  });

  it('says nothing on an ordinary project where nothing has broken', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).not.toContain('rests on a broken assumption');
  });

  it('still tells the manager what a queued break would take with it', async () => {
    breakIt(); restOnIt();
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', summary: 'Break it', workstream: 'tech',
      operations: [{ type: 'setRecordStatus', id: 'a1', status: 'broken' }],
    }));
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech', tasks: [],
      records: [{ id: 'a1', type: 'assumption', text: 'the vendor keeps their uptime promise', status: 'active', owner: { key: 'k', name: 'O' }, reviewBy: '2026-12-01', attachedTo: { kind: 'workstream', id: 'tech' }, links: {} }],
    }));
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toContain("1 thing rests on 'the vendor keeps their uptime promise': price it");
  });
});

/**
 * Evidence on the manager's queue (#122).
 *
 * The row is the assumption the evidence argues against, with the evidence said
 * in words and the impact of breaking it beside it — so the manager decides with
 * all three in front of them. Before this, an `addEvidence` operation rendered
 * as nothing: the one change in the queue that most needs judgement, hidden.
 */
describe('evidence against an assumption, in the queue', () => {
  const queueEvidence = (quote = 'all piloted without SSO', by = 'Priya') => {
    repo.files.set('.teamctx/project.json', JSON.stringify({
      name: 'Ledger',
      records: [
        { id: 'a1', type: 'assumption', text: 'Buyers need SSO before a pilot', status: 'active', owner: { key: 'k', name: 'O' }, reviewBy: '2026-12-01', links: {} },
        { id: 'd1', type: 'decision', text: 'Build SSO first', status: 'active', links: { restsOn: ['a1'] } },
      ],
      tasks: [],
    }));
    repo.files.set('.teamctx/queue/c-ev.json', JSON.stringify({
      id: 'c-ev', status: 'pending', author: by, summary: 'Evidence about SSO', workstream: null, source: 'mcp',
      operations: [
        { type: 'addEvidence', id: 'a1', evidence: { text: quote, by, source: 'mcp', at: '2026-10-06T09:00:00.000Z' },
          against: { id: 'a1', type: 'assumption', text: 'Buyers need SSO before a pilot' } },
        { type: 'setRecordStatus', id: 'a1', status: 'broken' },
      ],
    }));
  };

  it('says it in the words the issue asks for', async () => {
    queueEvidence();
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toContain("Evidence against 'We're assuming: Buyers need SSO before a pilot'");
    expect(body).toContain('all piloted without SSO');
    expect(body).toContain('from Priya via mcp');
  });

  it('shows what breaking it would take with it, before the manager decides', async () => {
    queueEvidence();
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).toContain("1 thing rests on 'Buyers need SSO before a pilot': Build SSO first");
  });

  it('escapes the quote, which is somebody else’s words', async () => {
    queueEvidence('<img src=x onerror="alert(1)">');
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(body).not.toContain('<img src=x onerror');
    expect(body).toContain('&lt;img');
  });

  it('is the manager’s alone — a member sees none of it', async () => {
    queueEvidence();
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('Evidence against');
    expect(body).not.toContain('all piloted without SSO');
  });
});

/**
 * One page: the tree on the left says which part of the work to look at, and the
 * main column shows what is waiting and every part's open tasks, each under its
 * own heading. No tabs, no dropdowns, no filter button, no pager.
 */
const node = (body, name) => new RegExp(`<a class="node[^"]*"[^>]*>(?:(?!</a>)[\\s\\S])*?<span class="nm">${name}</span>[\\s\\S]*?</a>`).exec(body)?.[0];

describe('the project page is one page', () => {
  const nested = (over = {}) => repo.files.set('.teamctx/config.json', JSON.stringify({
    ...CONFIG,
    workstreams: [
      { id: 'product', number: 1, name: 'Product', parent: null, order: 1 },
      { id: 'pricing', number: 2, name: 'Pricing', parent: 'product', order: 1 },
      { id: 'tech', number: 3, name: 'Tech', parent: null, order: 2 },
    ],
    ...over,
  }));
  const withPricing = (tasks) => repo.files.set('.teamctx/workstreams/pricing.json', JSON.stringify({ id: 'pricing', name: 'Pricing', records: [], tasks }));
  const section = (body, id) => new RegExp(`<section class="wsec" id="ws-${id}">[\\s\\S]*?</section>`).exec(body)?.[0];

  it('opens on the whole project: every part with an open task, each under its own heading', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(section(body, 'product')).toContain('<span class="wsn">1</span>Product');
    expect(section(body, 'tech')).toContain('<span class="wsn">2</span>Tech');
    expect(body).toContain('Draft the pricing page');
    expect(body).toContain('Migrate the database');
  });

  it('has no tabs, no dropdowns, no filter button and no pager, for anyone', async () => {
    await lend();
    for (const [who, path] of [[MANAGER, '/project/acme/ledger'], [MANAGER, '/project/acme/ledger?ws=product'], [MEMBER_GOOGLE, '/project/acme/ledger']]) {
      const page = onPage((await visit(path, who)).body);
      expect(page, path).not.toMatch(/class="tabs"|<select|class="apply"|class="pager"|>Filter<|Where<|Owner</);
    }
  });

  it('lands old links with a tab, a filter or a page on the same page', async () => {
    const plain = await visit('/project/acme/ledger', MANAGER);
    const old = await visit('/project/acme/ledger?tab=review&taskWs=tech&taskOwner=Dev&page=3&ipage=2&view=list', MANAGER);
    expect(old.status).toBe(200);
    expect(old.body).toBe(plain.body);
  });

  it('shows no decision, rule, assumption or exception: those are read through the assistant', async () => {
    for (const path of ['/project/acme/ledger', '/project/acme/ledger?ws=product']) {
      const page = onPage((await visit(path, MANAGER)).body);
      for (const text of ['ship it', 'price it', 'keep the servers up']) expect(page, path).not.toContain(text);
      expect(page, path).not.toMatch(/Project context — inherited|Governed by|class="list"/);
    }
  });

  it('never carries a part of the work the reader is not on, not even hidden', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('keep the servers up');
    expect(body).not.toContain('Migrate the database');
  });

  describe('the tree', () => {
    it('starts with Overall Project and the number of open tasks, never the project\'s own name', async () => {
      const { body } = await visit('/project/acme/ledger', MANAGER);
      const root = node(body, 'Overall Project');
      expect(root).toContain('class="node root on"');
      expect(root).toContain('aria-current="page"');
      expect(root).toContain('<span class="cnt">2</span>');
      expect(body.match(/<a class="node/g).length).toBe(3);
    });

    it('numbers each part flat, as stored, and nests the ones inside another', async () => {
      nested(); withPricing([]);
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(body).toMatch(/<span class="num">1<\/span><span class="nm">Product<\/span>[\s\S]*?<\/a><ul>[\s\S]*?<span class="num">2<\/span><span class="nm">Pricing<\/span>/);
      expect(body).toMatch(/<span class="num">3<\/span><span class="nm">Tech<\/span>/);
      expect(body).not.toMatch(/<span class="num">1\.1<\/span><span class="nm">/);
    });

    it('counts the open tasks at a part and inside it', async () => {
      nested();
      withPricing([{ id: 'quote', key: '2.1', title: 'Quote the tiers', owner: 'Priya', status: 'open' }, { id: 'quote2', key: '2.2', title: 'Quote more', owner: 'Priya', status: 'open' }]);
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(node(body, 'Product')).toContain('<span class="cnt">3</span>');
      expect(node(body, 'Pricing')).toContain('<span class="cnt">2</span>');
      expect(node(body, 'Overall Project')).toContain('<span class="cnt">4</span>');
    });

    it('marks a part with a dot when something waiting is at or under it, and only then', async () => {
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(node(body, 'Product')).toContain('class="dot"');
      expect(node(body, 'Tech')).not.toContain('class="dot"');
      expect(node(body, 'Overall Project')).toContain('class="dot"');
    });

    it('marks a part with a dot for an assumption past its review date, and keeps it for the manager\'s queue', async () => {
      repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({
        id: 'tech', name: 'Tech', tasks: [],
        records: [{ id: 'a1', type: 'assumption', text: 'x', status: 'active', owner: { name: 'O' }, reviewBy: '2000-01-01' }],
      }));
      await lend();
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(node(body, 'Tech')).toContain('class="dot"');
    });

    it('shows a member only the parts they are on, and no dot for what is the manager\'s', async () => {
      await lend();
      const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
      expect(body).toContain('<span class="nm">Product</span>');
      expect(body).not.toContain('<span class="nm">Tech</span>');
      expect(node(body, 'Product')).not.toContain('class="dot"');
    });

    it('links each part to itself, and the whole project to the page', async () => {
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(node(body, 'Overall Project')).toContain('href="/project/acme/ledger"');
      expect(node(body, 'Product')).toContain('href="/project/acme/ledger?ws=product"');
    });
  });

  describe('choosing a part', () => {
    it('shows that part and what is inside it, and nothing else', async () => {
      nested(); withPricing([{ id: 'quote', key: '2.1', title: 'Quote the tiers', owner: 'Priya', status: 'open' }]);
      const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
      expect(node(body, 'Product')).toContain('class="node on"');
      expect(node(body, 'Overall Project')).toContain('class="node root"');
      expect(onPage(body)).toContain('Draft the pricing page');
      expect(onPage(body)).toContain('Quote the tiers');
      expect(onPage(body)).not.toContain('Migrate the database');
    });

    it('heads a part inside it with where it sits, and the chosen part with its own name', async () => {
      nested(); withPricing([{ id: 'quote', key: '2.1', title: 'Quote the tiers', owner: 'Priya', status: 'open' }]);
      const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
      expect(section(body, 'product')).toContain('</span>Product<');
      expect(section(body, 'pricing')).toContain('</span>Product › Pricing<');
    });

    it('leaves out a part with nothing open, and says so when the chosen part has nothing', async () => {
      repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({ id: 'tech', name: 'Tech', records: [], tasks: [] }));
      const all = await visit('/project/acme/ledger', MANAGER);
      expect(section(all.body, 'tech')).toBeUndefined();
      const tech = await visit('/project/acme/ledger?ws=tech', MANAGER);
      expect(onPage(tech.body)).toContain('Nothing open here.');
    });

    it('gives each heading a context icon that opens that part\'s drawer', async () => {
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(section(body, 'product')).toMatch(/<button type="button" class="ctx-open" data-panel="dp-ws-product" aria-label="Context for Product"/);
      expect(section(body, 'tech')).toMatch(/data-panel="dp-ws-tech" aria-label="Context for Tech"/);
    });
  });

  describe('a task', () => {
    const row = (body, id) => new RegExp(`<button[^>]*id="t-${id}"[\\s\\S]*?</button>`).exec(body)?.[0];

    it('is a number, what it is, who has it and how many sources are behind it', async () => {
      repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
        id: 'product', name: 'Product', records: [],
        tasks: [{ id: 'pricing-page', key: '1.1', title: 'Draft the pricing page', owner: 'Priya', status: 'open', sourceContributionIds: ['c-prod', 'c-tech'] }],
      }));
      const r = row((await visit('/project/acme/ledger', MANAGER)).body, 'pricing-page');
      expect(r).toContain('<span class="num">1.1</span>');
      expect(r).toContain('<span class="ttl">Draft the pricing page</span>');
      expect(r).toContain('👤 Priya');
      expect(r).toContain('<span class="clip" title="2 linked sources">📎 2</span>');
    });

    it('shows an agent as an agent, and a person as a person', async () => {
      repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
        id: 'product', name: 'Product', records: [],
        tasks: [
          { id: 'by-agent', key: '1.1', title: 'Run the numbers', owner: 'Nightly report', status: 'open' },
          { id: 'by-person', key: '1.2', title: 'Read them', owner: 'Priya', status: 'open' },
          { id: 'by-nobody', key: '1.3', title: 'Nobody has it', owner: null, status: 'open' },
        ],
      }));
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(row(body, 'by-agent')).toContain('<span class="chip agent">🤖 Nightly report</span>');
      expect(row(body, 'by-person')).toContain('<span class="chip">👤 Priya</span>');
      expect(row(body, 'by-nobody')).toContain('Unassigned');
    });

    it('has no type column, no status chip and no heading row: the section says what it is', async () => {
      const page = onPage((await visit('/project/acme/ledger', MANAGER)).body);
      expect(page).not.toMatch(/class="row-head"|class="type-label"|class="status-chip"|class="row-notes"/);
    });

    it('names who wrote it, and carries what the drawer and the prompt need', async () => {
      const r = row((await visit('/project/acme/ledger?ws=product', MANAGER)).body, 'pricing-page');
      expect(r).toContain('data-who="Priya"');
      expect(r).toContain('data-ws="product"');
      expect(r).toContain('data-kind="Task 1.1"');
    });

    it('is numbered by its stored number, never a letter key', async () => {
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(body).toMatch(/class="num">1\.1</);
      expect(body).toMatch(/class="num">2\.1</);
      expect(onPage(body)).not.toMatch(/\b[TDRAXQ]-\d+\b/);
    });

    it('writes a prompt a fresh chat can act on', async () => {
      const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
      const prompt = rowPrompt(body);
      expect(prompt).toContain('connected to the repository acme/ledger');
      expect(prompt).toContain('get_connect_url');
      expect(prompt).toContain('stop and tell me');
      expect(prompt).toContain('the part of the work called &quot;Product&quot;');
      expect(prompt).toContain('Tell me more about task 1.1:');
      expect(prompt).toContain('&quot;Draft the pricing page&quot;');
      expect(prompt).not.toContain('(id: product)');
      expect(prompt).toMatch(/The page it came from: https?:[^ ]*project\/acme\/ledger/);
      expect(prompt).toContain('item=pricing-page');
    });

    it('says nothing was recorded rather than naming a source it does not have', async () => {
      const r = row((await visit('/project/acme/ledger?ws=tech', MANAGER)).body, 'migrate-db');
      expect(r).toContain('<span class="clip"></span>');
      expect(r).toContain('data-who=""');
    });
  });

  describe('what is done', () => {
    it('is out of the way: not listed, and counted in a link to show it', async () => {
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(onPage(body)).not.toContain('Something finished');
      expect(body).toMatch(/<p class="hist"><a href="\/project\/acme\/ledger\?history=1">Show history \(1 done\)<\/a><\/p>/);
    });

    it('is listed, struck through and faded, once history is shown, with a link to hide it', async () => {
      const { body } = await visit('/project/acme/ledger?history=1', MANAGER);
      expect(body).toMatch(/class="item trow done" id="t-old-thing"/);
      expect(body).toContain('Something finished');
      expect(body).toMatch(/\.trow\.done \.ttl\{text-decoration:line-through\}/);
      expect(body).toMatch(/<a href="\/project\/acme\/ledger">Hide history<\/a>/);
    });

    it('keeps the chosen part when history is turned on and off', async () => {
      const { body } = await visit('/project/acme/ledger?ws=tech', MANAGER);
      expect(body).toContain('href="/project/acme/ledger?ws=tech&amp;history=1"');
      const on = await visit('/project/acme/ledger?ws=tech&history=1', MANAGER);
      expect(on.body).toContain('href="/project/acme/ledger?ws=tech">Hide history');
    });

    it('is not offered when there is none to show', async () => {
      repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({ id: 'tech', name: 'Tech', records: [], tasks: [{ id: 'migrate-db', key: '2.1', title: 'Migrate', owner: 'Dev', status: 'open' }] }));
      const { body } = await visit('/project/acme/ledger?ws=tech', MANAGER);
      expect(body).not.toContain('Show history');
    });

    it('counts only what is inside the chosen part', async () => {
      const all = await visit('/project/acme/ledger', MANAGER);
      const product = await visit('/project/acme/ledger?ws=product', MANAGER);
      expect(all.body).toContain('Show history (1 done)');
      expect(product.body).not.toContain('Show history');
    });
  });

  describe('when there is nothing to show', () => {
    it('says so plainly when there is no work yet', async () => {
      repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, workstreams: [], members: [] }));
      repo.files.delete('.teamctx/workstreams/product.json');
      repo.files.delete('.teamctx/workstreams/tech.json');
      const { body } = await visit('/project/acme/ledger', MANAGER);
      expect(body).toMatch(/No work yet — ask your assistant to add a workstream/);
      expect(onPage(body)).not.toContain('Waiting on you');
    });
  });
});

/**
 * What is waiting on the manager, above the work. A card with one entry per
 * proposal: its number, what it is, who sent it and where, how many things to
 * check it against, and two icons: one to read it, one to go straight to the
 * decision. The decision itself is made in the assistant or on the command line.
 */
describe('waiting on you', () => {
  const card = (body) => /<section class="inbox"[\s\S]*?<\/section>/.exec(body)?.[0];
  const item = (body, id) => new RegExp(`<div class="q[^"]*" id="r-${id}"[\\s\\S]*?\\n</div>`).exec(body)?.[0];
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
  const dataOf = (html, name) => JSON.parse(unesc(new RegExp(`data-${name}="([^"]*)"`).exec(html)[1]));
  const queue = (id, over) => repo.files.set(`.teamctx/queue/${id}.json`, JSON.stringify({ id, status: 'pending', author: 'Priya', summary: `proposal ${id}`, workstream: 'product', createdAt: '2026-10-06T10:00:00Z', ...over }));

  it('is a card with a count, for the manager', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(card(body)).toContain('<h2 id="inbox-h">Waiting on you · 1</h2>');
    expect(card(body)).toContain('adds the pricing tiers');
  });

  it('is not shown to a member, and a link to a waiting item shows them nothing of it', async () => {
    await lend();
    for (const path of ['/project/acme/ledger', '/project/acme/ledger?review=1.2', '/project/acme/ledger?review=c-1']) {
      const { body } = await visit(path, MEMBER_GOOGLE);
      expect(body, path).not.toContain('Waiting on you');
      expect(body, path).not.toContain('adds the pricing tiers');
    }
  });

  it('is left out when nothing is waiting', async () => {
    repo.files.delete('.teamctx/queue/c-1.json');
    expect(onPage((await visit('/project/acme/ledger', MANAGER)).body)).not.toContain('Waiting on you');
  });

  it('gives an item its number, what it is, who sent it, where and when', async () => {
    const r = item((await visit('/project/acme/ledger', MANAGER)).body, 'c-1');
    expect(r).toContain('<span class="num">1.2</span>');
    expect(r).toContain('<button type="button" class="qmain">adds the pricing tiers</button>');
    expect(r).toContain('<span class="chip">👤 Priya</span>');
    expect(r).toContain('· Product');
  });

  it('shows an agent that sent it as an agent', async () => {
    queue('c-agent', { author: 'Nightly report', number: '1.3' });
    const r = item((await visit('/project/acme/ledger', MANAGER)).body, 'c-agent');
    expect(r).toContain('<span class="chip agent">🤖 Nightly report</span>');
  });

  it('has two icons, to read it and to go to the decision, each named for what it is', async () => {
    const r = item((await visit('/project/acme/ledger', MANAGER)).body, 'c-1');
    expect(r).toMatch(/<button type="button" class="qicon" data-open="view" aria-label="View 1\.2" title="View details">/);
    expect(r).toMatch(/<button type="button" class="qicon rv" data-open="review" aria-label="Review 1\.2: approve or reject" title="Review: approve or reject">/);
    expect(r).not.toMatch(/>\s*Review\s*</);
  });

  it('opens the drawer from the row, the title or either icon, once', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain("document.querySelectorAll('.item, .q')");
    expect(body).toContain("document.querySelectorAll('.qicon')");
    expect(body).toContain('e.stopPropagation();');
    expect(body).toContain("b.dataset.open === 'review'");
    expect(body).toContain("scrollIntoView({ behavior: 'smooth', block: 'center' })");
  });

  it('shows only what is at or inside the chosen part', async () => {
    queue('c-tech', { workstream: 'tech', summary: 'a tech proposal' });
    const product = card((await visit('/project/acme/ledger?ws=product', MANAGER)).body);
    expect(product).toContain('Waiting on you · 1');
    expect(product).toContain('adds the pricing tiers');
    expect(product).not.toContain('a tech proposal');
    const all = card((await visit('/project/acme/ledger', MANAGER)).body);
    expect(all).toContain('Waiting on you · 2');
  });

  it('shows an item for the project itself only on the whole project, without a number', async () => {
    queue('c-proj', { workstream: null, summary: 'a project-level proposal' });
    const all = item((await visit('/project/acme/ledger', MANAGER)).body, 'c-proj');
    expect(all).toContain('<span class="num">—</span>');
    expect(all).toContain('· Ledger');
    expect(onPage((await visit('/project/acme/ledger?ws=product', MANAGER)).body)).not.toContain('a project-level proposal');
  });

  it('counts what to check it against, and says so', async () => {
    queue('c-conflict', {
      summary: 'Change the entry offer',
      operations: [{ type: 'addRecord', record: { type: 'decision', text: 'An AI-readiness assessment' } }],
      contradictions: [{ operationIndex: 0, proposedText: 'An AI-readiness assessment', record: { id: 'old', type: 'decision', text: 'A pricing audit', workstream: 'product' } }],
    });
    const r = item((await visit('/project/acme/ledger', MANAGER)).body, 'c-conflict');
    expect(r).toContain('<span class="chip warn">⚠ 1 to check against the record</span>');
    expect(dataOf(r, 'checks').join(' ')).toMatch(/Contradicts.*A pricing audit.*An AI-readiness assessment/);
    expect(item((await visit('/project/acme/ledger', MANAGER)).body, 'c-1')).not.toContain('to check against the record');
  });

  it('says what it would change in words, for each kind of change', async () => {
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product',
      records: [{ id: 'w1', type: 'decision', text: 'Price by seat', status: 'active' }],
      tasks: [{ id: 'pricing-page', key: '1.1', title: 'Draft the pricing page', owner: 'Priya', status: 'open' }],
    }));
    queue('c-many', {
      summary: 'Several changes',
      operations: [
        { type: 'addTask', title: 'Quote the tiers' },
        { type: 'addRecord', record: { type: 'rule', text: 'No discounts over 15%' } },
        { type: 'editRecord', id: 'w1', changes: { text: 'Price by team' } },
        { type: 'setRecordStatus', id: 'w1', status: 'replaced' },
        { type: 'editTask', id: 'pricing-page', title: 'Draft the pricing page again' },
        { type: 'removeTask', id: 'pricing-page' },
        { type: 'mystery' },
      ],
    });
    const changes = dataOf(item((await visit('/project/acme/ledger', MANAGER)).body, 'c-many'), 'changes');
    expect(changes).toEqual([
      'Add a task: Quote the tiers',
      'Add: Rule: No discounts over 15%',
      'Reword "Price by seat" to: Price by team',
      'Mark "Price by seat" as replaced',
      'Retitle "Draft the pricing page" to: Draft the pricing page again',
      'Remove the task "Draft the pricing page"',
    ]);
  });

  it('says how to decide it, in the assistant or on the command line, and has no approve or reject button', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const lines = dataOf(item(body, 'c-1'), 'decide');
    expect(lines[0]).toContain('"Approve 1.2"');
    expect(lines[0]).toContain('"Reject 1.2"');
    expect(lines[1]).toContain('teamctx review approve c-1');
    expect(lines[1]).toContain('teamctx review reject c-1');
    expect(onPage(body)).not.toMatch(/>\s*(Approve|Reject)\b/);
    expect(body).toContain('id="d-decide-title">Decide<');
  });

  it('names an item with no number by what it says, so the instruction still means something', async () => {
    queue('c-unnumbered', { summary: 'An unnumbered proposal', workstream: null });
    const lines = dataOf(item((await visit('/project/acme/ledger', MANAGER)).body, 'c-unnumbered'), 'decide');
    expect(lines[0]).toContain('name it by what it says');
  });

  it('escapes what somebody else wrote: the summary, the author, the changes and the conflicting record', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    queue('c-evil', {
      summary: hostile, author: hostile,
      operations: [{ type: 'addTask', title: hostile }],
      contradictions: [{ operationIndex: 0, proposedText: hostile, record: { id: 'o', type: 'decision', text: hostile, workstream: 'product' } }],
    });
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(onPage(body)).not.toContain(hostile);
    expect(body).not.toContain('<img src=x onerror');
    expect(body).toContain('&lt;img');
  });

  it('stays readable when a proposal is malformed', async () => {
    queue('c-bad', { summary: 'Partial proposal', operations: [null, { type: 'addRecord' }, { type: 'addTask', title: 'Valid task proposal' }] });
    queue('c-worse', { summary: 'Bad operation list', operations: {}, contradictions: 'nope', impact: 7 });
    const { status, body } = await visit('/project/acme/ledger', MANAGER);
    expect(status).toBe(200);
    expect(card(body)).toContain('Partial proposal');
    expect(dataOf(item(body, 'c-bad'), 'changes')).toContain('Add a task: Valid task proposal');
    expect(card(body)).toContain('Bad operation list');
  });

  it('is marked, and opens the drawer on load, when a link points at it by id or by number', async () => {
    for (const path of ['/project/acme/ledger?review=c-1', '/project/acme/ledger?review=1.2', '/project/acme/ledger?item=c-1']) {
      const { body } = await visit(path, MANAGER);
      expect(body, path).toMatch(/<div class="q marked" id="r-c-1"/);
    }
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain("document.querySelector('.marked[data-prompt]')");
  });

  it('widens to the whole project when the linked item is outside the chosen part', async () => {
    const { body } = await visit('/project/acme/ledger?ws=tech&review=c-1', MANAGER);
    expect(body).toMatch(/<div class="q marked" id="r-c-1"/);
    expect(node(body, 'Overall Project')).toContain('class="node root on"');
  });
});

/**
 * A link names one thing and the page opens on it.
 */
describe('arriving from a link', () => {
  it('opens the part of the work the link named', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toMatch(/<a class="node on" href="\/project\/acme\/ledger\?ws=product" aria-current="page">/);
  });

  it('marks the task the link pointed at, by id, by number and by the task parameter', async () => {
    for (const path of ['?ws=product&item=pricing-page', '?ws=product&item=1.1', '?task=1.1', '?task=pricing-page']) {
      const { body } = await visit(`/project/acme/ledger${path}`, MANAGER);
      expect(body, path).toMatch(/class="item trow marked" id="t-pricing-page"/);
    }
  });

  it('gives the same page by number as by id', async () => {
    const byId = await visit('/project/acme/ledger?ws=product&item=pricing-page', MANAGER);
    const byNumber = await visit('/project/acme/ledger?ws=product&item=1.1', MANAGER);
    expect(byNumber.body).toBe(byId.body);
  });

  it('widens to the whole project when the linked task is in another part', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&task=migrate-db', MANAGER);
    expect(body).toMatch(/class="item trow marked" id="t-migrate-db"/);
    expect(body).toContain('id="t-pricing-page"');
  });

  it('shows a finished task the link points at even with history off', async () => {
    const { body } = await visit('/project/acme/ledger?task=old-thing', MANAGER);
    expect(body).toMatch(/class="item trow marked done" id="t-old-thing"/);
  });

  it('gives a marked row something to look at', async () => {
    const { body } = await visit('/project/acme/ledger?task=pricing-page', MANAGER);
    expect(body).toContain('.item.marked{');
    expect(body).toContain('data-text="Draft the pricing page"');
    expect(body).not.toContain('data-text="undefined"');
  });

  it('falls back quietly for a number that names nothing, and never writes it back', async () => {
    const { status, body } = await visit('/project/acme/ledger?ws=product&item=9.9', MANAGER);
    expect(status).toBe(200);
    expect(body).not.toMatch(/class="[^"]*marked/);
    expect(onPage(body)).not.toMatch(/9\.9/);
  });

  it('does not reach a record, which has no number and is not on the page', async () => {
    const { status, body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(status).toBe(200);
    expect(body).not.toMatch(/class="[^"]*marked/);
    expect(onPage(body)).not.toContain('price it');
  });

  it('falls back quietly when the part of the work is not theirs to see', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger?ws=tech', MEMBER_GOOGLE);
    expect(body).toMatch(/not here, or not yours to see/);
    expect(body).not.toContain('Migrate the database');
  });

  it('never writes what was asked for back into the page', async () => {
    const { body } = await visit('/project/acme/ledger?ws=<script>alert(1)</script>', MANAGER);
    expect(body).not.toContain('alert(1)');
  });
});
