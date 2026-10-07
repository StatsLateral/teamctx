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
// The remembered verdict on a repository, so a test can let it lapse.
const __resetKnown = () => kvSet(keys.repoState('acme', 'old-demo'), null);

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
    expect(body).toMatch(/1\s*\n?task already done/);
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

describe('the work the page draws', () => {
  it('opens on the whole project, with every part of the work and its tasks', async () => {
    const start = await visit('/project/acme/ledger', MANAGER);
    expect(start.body).toContain('Draft the pricing page');
    expect(start.body).toContain('Migrate the database');
    const product = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(product.body).toContain('Draft the pricing page');
    expect(onPage(product.body)).not.toContain('Migrate the database');
  });

  it('shows no decision, rule, assumption or exception: those are read through the assistant', async () => {
    for (const path of ['/project/acme/ledger', '/project/acme/ledger?ws=product', '/project/acme/ledger?tab=review']) {
      const { body } = await visit(path, MANAGER);
      const page = onPage(body);
      expect(page, path).not.toContain('ship it');
      expect(page, path).not.toContain('price it');
      expect(page, path).not.toContain('keep the servers up');
      expect(page, path).not.toMatch(/Project context — inherited|Governed by|class="list"/);
    }
  });

  it('has no Context tab, and an old link to it lands on the tasks', async () => {
    const { status, body } = await visit('/project/acme/ledger?tab=context&history=1&ipage=2', MANAGER);
    expect(status).toBe(200);
    expect(body).not.toMatch(/>Context<span/);
    expect(body).toMatch(/aria-current="page">Tasks</);
    expect(body).not.toMatch(/Show history|Hide history/);
  });

  it('never carries a tree the reader is not on, not even hidden', async () => {
    // Scope that only holds in the markup is not scope: a reader who opens the
    // network tab is still a reader.
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('keep the servers up');
    expect(body).not.toContain('Migrate the database');
  });

  it('numbers each part of the work flat, and indents the ones inside another', async () => {
    const files = repo.files;
    files.set('.teamctx/config.json', JSON.stringify({
      ...CONFIG,
      workstreams: [
        { id: 'product', number: 1, name: 'Product', parent: null, order: 1 },
        { id: 'pricing', number: 2, name: 'Pricing', parent: 'product', order: 1 },
        { id: 'tech', number: 3, name: 'Tech', parent: null, order: 2 },
      ],
    }));
    files.set('.teamctx/workstreams/pricing.json', JSON.stringify({ id: 'pricing', name: 'Pricing', records: [], tasks: [] }));
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/<span class="num">1<\/span><span class="name">Product/);
    expect(body).toMatch(/--depth:1[^>]*>[\s\S]*?<span class="num">2<\/span><span class="name">Pricing/);
    expect(body).toMatch(/<span class="num">3<\/span><span class="name">Tech/);
    expect(body).not.toMatch(/class="num">1\.1<\/span><span class="name"/);
  });

  it('counts open tasks on each part of the work, not records', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/<span class="name">Product<\/span><span class="count">1</);
    expect(body).toMatch(/<span class="name">Tech<\/span><span class="count">1</);
  });

  it('names who wrote a task, and what kind of source it came from', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toMatch(/data-who="Priya"/);
    // The source column says where it came through, in a word — teamctx
    // records the surface, not whether a person or a model wrote the words.
    expect(body).toMatch(/class="row-source src-mcp"[^>]*>Assistant</);
  });

  it('numbers the tasks on screen by their stored number, never a letter key', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/class="num">1\.1</);
    expect(body).toMatch(/class="num">2\.1</);
    expect(body).not.toMatch(/class="num">[TDRAXQ]-\d/);
  });

  it('writes a prompt a fresh chat can act on', async () => {
    // Beside the page, "tell me more about X in Y" reads fine. Pasted into a
    // new conversation it names nothing an assistant can act on — which of
    // several projects, and with what.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = rowPrompt(body);
    // It names the repository and tells the assistant how to check it is on
    // that one — the version before this said a connector "may be named
    // something else", which told an assistant on a different project to carry
    // on, and it did: it answered about the nearest thing it could find.
    expect(prompt).toContain('connected to the repository acme/ledger');
    expect(prompt).toContain('get_connect_url');
    expect(prompt).toContain('stop and tell me');
    expect(prompt).not.toContain('may be named something else');
    expect(prompt).toContain('the part of the work called &quot;Product&quot;');
    expect(prompt).toContain('Tell me more about task 1.1:');
    expect(prompt).toContain('Find this, quoted word for word');
    expect(prompt).toContain('&quot;Draft the pricing page&quot;');
    expect(prompt).toContain('say so plainly rather than answering about the closest thing');
  });

  it('names the part of the work without exposing its internal id', async () => {
    // Breadcrumb names locate the work; internal ids stay in link targets.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = rowPrompt(body);
    expect(prompt).toContain('&quot;Product&quot;');
    expect(prompt).not.toContain('(id: product)');
  });

  it('carries the address of the page it was copied from', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = rowPrompt(body);
    expect(prompt).toMatch(/The page it came from: https?:[^ ]*project\/acme\/ledger/);
    expect(prompt).toContain('item=pricing-page');
  });

  it('says so plainly when there is no work yet', async () => {
    repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, workstreams: [], members: [] }));
    repo.files.delete('.teamctx/workstreams/product.json');
    repo.files.delete('.teamctx/workstreams/tech.json');
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/No work yet — ask your assistant to add a workstream/);
  });

  it('says so plainly when a part of the work holds no open task', async () => {
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({ id: 'tech', name: 'Tech', records: [], tasks: [] }));
    const { body } = await visit('/project/acme/ledger?ws=tech', MANAGER);
    expect(body).toMatch(/No open tasks match these filters/);
  });
});

describe('arriving from a link', () => {
  it('opens the part of the work the link named', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toMatch(/class="lane on"[^>]*href="[^"]*ws=product/);
  });

  it('marks the task the link pointed at', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&item=pricing-page', MANAGER);
    expect(body).toMatch(/class="item tier-task marked" id="t-pricing-page"/);
  });

  it('reaches the same row by number as by id', async () => {
    // Links carry the internal id, which never changes; the number is what a
    // person has in front of them, so a link pasted from the page or out of a
    // prompt has to land in the same place.
    const byId = await visit('/project/acme/ledger?ws=product&item=pricing-page', MANAGER);
    const byNumber = await visit('/project/acme/ledger?ws=product&item=1.1', MANAGER);
    expect(byNumber.body).toMatch(/class="item tier-task marked" id="t-pricing-page"/);
    expect(byNumber.body).toContain('<span class="num">1.1</span>');
    expect(byNumber.body).toContain('Tell me more about task 1.1:');
    expect(byNumber.body).toBe(byId.body);
  });

  it('reaches a task by its number through the task parameter too', async () => {
    const { body } = await visit('/project/acme/ledger?task=2.1', MANAGER);
    expect(body).toMatch(/class="item tier-task marked" id="t-migrate-db"/);
  });

  it('reaches a waiting item by the number it waits under', async () => {
    const { body } = await visit('/project/acme/ledger?review=1.2', MANAGER);
    expect(body).toMatch(/aria-current="page">Waiting on you/);
    expect(body).toMatch(/class="item[^"]*marked"[^>]*id="r-c-1"/);
    expect(body).toContain('<span class="num">1.2</span>');
  });

  it('falls back quietly for a number that names nothing', async () => {
    // Same quiet landing an unknown id gets — the page, nothing marked, and the
    // value never written back into it.
    const { status, body } = await visit('/project/acme/ledger?ws=product&item=9.9', MANAGER);
    expect(status).toBe(200);
    // Not "marked" anywhere: that word is in the stylesheet. Nothing *carries*
    // the class.
    expect(body).not.toMatch(/class="item[^"]*marked/);
    expect(onPage(body)).not.toMatch(/9\.9/);
  });

  it('does not reach a record, which has no number and is not on the page', async () => {
    const { status, body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(status).toBe(200);
    expect(body).not.toMatch(/class="item[^"]*marked/);
    expect(onPage(body)).not.toContain('price it');
  });

  it('falls back quietly when the part of the work is not theirs to see', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger?ws=tech', MEMBER_GOOGLE);
    expect(body).toMatch(/not here, or not yours to see/);
    expect(body).not.toContain('Migrate the database');
  });

  it('never writes what was asked for back into the page', async () => {
    // A parameter is somebody else's text until proven otherwise.
    const { body } = await visit('/project/acme/ledger?ws=<script>alert(1)</script>', MANAGER);
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toContain('alert(1)');
  });
});

// The page renders one tree at a time, so an out-of-scope tree in the payload
// would never show — which is exactly why the rule is checked against the data
// and not by reading the HTML. "Not in the page data", not "not on screen".
const { readProjectView } = await import('../src/oauth/project-view.js');

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

describe('what a link may and may not open', () => {
  it('marks a task, and its drawer carries the task itself, never "undefined"', async () => {
    // A task is an item in its own right, so the drawer it opens must hold its
    // title rather than a statement's missing fields.
    const { body } = await visit('/project/acme/ledger?ws=product&task=pricing-page', MANAGER);
    expect(body).toMatch(/class="item tier-task marked" id="t-pricing-page"/);
    const marked = /<button class="item[^"]*marked"[^>]*data-text="([^"]*)"/.exec(body);
    if (marked) expect(marked[1]).not.toBe('undefined');
    expect(body).not.toContain('data-text="undefined"');
  });

  it('gives a marked row something to look at', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&task=pricing-page', MANAGER);
    expect(body).toContain('.item.marked{');
    expect(body).toContain('data-text="Draft the pricing page"');
  });

  it('opens the task of a part of the work the link did not name', async () => {
    const { body } = await visit('/project/acme/ledger?task=migrate-db', MANAGER);
    expect(body).toMatch(/class="item tier-task marked" id="t-migrate-db"/);
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

  it('keeps the lanes, the lane picker and the drawers working', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('class="lanes"');
    expect(body).toContain('id="lane-pick"');
    expect(body).toContain('id="drawer"');
  });
});

describe('a task with nothing recorded behind it', () => {
  it('says nothing was recorded rather than naming a source it does not have', async () => {
    // The tech tasks have no sourceContributionIds in this fixture.
    const { body } = await visit('/project/acme/ledger?ws=tech', MANAGER);
    expect(body).toMatch(/class="row-source src-none" title="No source recorded">—</);
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

describe('shared rows, task filters and governance (#127)', () => {
  const row = (html, id) => new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`).exec(html)?.[0];
  function records(items) {
    const tree = JSON.parse(repo.files.get('.teamctx/workstreams/product.json'));
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({ ...tree, records: items }));
  }

  it('shows both sides of a contradiction in the manager queue, with stored text escaped', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', summary: 'Change the entry offer', workstream: 'product',
      operations: [{ type: 'addRecord', record: { type: 'decision', text: 'An AI-readiness assessment' } }],
      contradictions: [{ operationIndex: 0, proposedText: 'An AI-readiness assessment', record: { id: 'old', type: 'decision', text: hostile, workstream: 'product' } }],
    }));
    const manager = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(row(manager.body, 'r-c-1')).toContain('Contradicts');
    expect(row(manager.body, 'proposal-c-1-0')).toContain('warning-chip');
    expect(row(manager.body, 'proposal-c-1-0')).toContain('We decided: &lt;img');
    expect(row(manager.body, 'proposal-c-1-0')).toContain('An AI-readiness assessment');
    expect(manager.body).not.toContain(hostile);
    await lend();
    const member = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(member.body).not.toContain('An AI-readiness assessment');
    expect(member.body).not.toContain('onerror');
  });

  it('keeps the page readable when a queued proposal includes malformed operations', async () => {
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', summary: 'Partial proposal', workstream: 'product',
      operations: [null, { type: 'addRecord' }, { type: 'addTask', title: 'Valid task proposal' }],
    }));
    const { status, body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(status).toBe(200);
    expect(body).toContain('Valid task proposal');
    expect(body).toContain('Partial proposal');
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({ id: 'c-1', status: 'pending', author: 'Priya', summary: 'Bad operation list', operations: {} }));
    expect((await visit('/project/acme/ledger?tab=review', MANAGER)).status).toBe(200);
  });

  it('shows which rule a proposed exception bends, including a proposed rule reference', async () => {
    records([{ id: 'rule', type: 'rule', text: 'Annual contracts only', status: 'active' }]);
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', workstream: 'product',
      operations: [
        { type: 'addRecord', record: { type: 'exception', text: 'Acme monthly pilot', links: { bends: 'rule' }, expiresAt: '2999-01-01' } },
        { type: 'addRecord', ref: 'pilot-rule', record: { type: 'rule', text: 'Pilot lasts two weeks' } },
        { type: 'addRecord', record: { type: 'exception', text: 'Acme gets three weeks', links: { bends: 'pilot-rule' }, expiresAt: '2999-01-01' } },
      ],
    }));
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(row(body, 'proposal-c-1-0')).toContain('↳ bends the rule &quot;Annual contracts only&quot;');
    expect(row(body, 'proposal-c-1-2')).toContain('↳ bends the proposed rule');
    expect(row(body, 'proposal-c-1-2')).toContain('Pilot lasts two weeks');
  });

  it('previews only editable fields and merges partial record links as approval does', async () => {
    records([
      { id: 'rule', type: 'rule', text: 'Annual contracts only', status: 'active' },
      { id: 'exception', type: 'exception', text: 'Acme monthly pilot', status: 'active', expiresAt: '2999-01-01', links: { bends: 'rule' } },
    ]);
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', workstream: 'product',
      operations: [{ type: 'editRecord', id: 'exception', changes: {
        text: 'Updated Acme monthly pilot', links: { restsOn: [] }, status: 'broken', id: 'spoofed', key: 'X-999',
      } }],
    }));
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    const proposal = row(body, 'proposal-c-1-0');
    expect(proposal).toContain('↳ bends the rule &quot;Annual contracts only&quot;');
    expect(proposal).toContain('Awaiting review · active');
    expect(proposal).toContain('Updated Acme monthly pilot');
    expect(proposal).not.toContain('spoofed');
    expect(proposal).not.toContain('X-999');
  });

  it('shows an overdue review and an expired exception on a proposal, as it did on a record', async () => {
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', workstream: 'product',
      operations: [
        { type: 'addRecord', record: { type: 'assumption', text: 'buyers need SSO', owner: { name: 'Priya' }, reviewBy: '2000-01-01' } },
      ],
    }));
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(row(body, 'proposal-c-1-0')).toContain('warning-chip">Review overdue 2000-01-01');
  });

  it('renders tasks and proposals with the shared anatomy', async () => {
    const tasks = await visit('/project/acme/ledger?ws=product&tab=tasks', MANAGER);
    expect(tasks.body.match(/id="t-pricing-page"/g)).toHaveLength(1);
    const task = row(tasks.body, 't-pricing-page');
    for (const text of ['class="num">1.1', 'class="type-label">Task', 'class="row-owner">Priya', 'class="row-state"', 'class="row-notes"', 'class="row-source src-mcp"', 'class="row-where">Product']) expect(task).toContain(text);
    const queue = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(row(queue.body, 'r-c-1')).toContain('Awaiting review');
    expect(row(queue.body, 'r-c-1')).toContain('class="num">1.2');
  });

  it('filters by workstream and owner, with a useful empty state', async () => {
    const product = await visit('/project/acme/ledger?taskWs=product&taskOwner=Priya', MANAGER);
    expect(product.body).toContain('id="t-pricing-page"');
    expect(product.body).not.toContain('id="t-migrate-db"');
    const mismatch = await visit('/project/acme/ledger?taskWs=product&taskOwner=Dev', MANAGER);
    expect(mismatch.body).not.toContain('id="t-pricing-page"');
    expect(mismatch.body).toContain('No open tasks match these filters');
    const all = await visit('/project/acme/ledger?ws=product&taskWs=@all', MANAGER);
    expect(all.body).toContain('id="t-migrate-db"');
  });

  it('filters unassigned tasks on their own, and offers no project-level choice: a task is in a workstream', async () => {
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech',
      records: [],
      tasks: [{ id: 'orphan-task', key: '2.3', title: 'Nobody has this', status: 'open', owner: null }],
    }));
    const { body } = await visit('/project/acme/ledger?taskOwner=@unassigned', MANAGER);
    expect(body).toContain('id="t-orphan-task"');
    expect(body).not.toContain('id="t-pricing-page"');
    expect(body).not.toContain('value="@project"');
  });

  it('keeps the part of the work in the filter form, so a filter lands where it was', async () => {
    const tasks = await visit('/project/acme/ledger?ws=product&taskWs=tech&taskOwner=Dev', MANAGER);
    const form = /<form class="task-filters"[\s\S]*?<\/form>/.exec(tasks.body)[0];
    expect(form).toContain('name="ws" value="product"');
    expect(form).not.toContain('name="view"');
    expect(form).not.toContain('name="tab"');
    expect(form).toContain('value="Dev" selected');
  });

  it('names nested locations in tasks and proposals, without raw ids as labels', async () => {
    repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, workstreams: [
      { id: 'product', name: 'Pricing', parent: 'tech' }, { id: 'tech', name: 'Launch' },
    ] }));
    const { body } = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    expect(row(body, 't-pricing-page')).toContain('class="row-where">Launch › Pricing');
    const queue = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(row(queue.body, 'r-c-1')).toContain('class="row-where">Launch › Pricing');
    expect(body).not.toContain('(id: product)');
    expect(body).not.toContain('class="row-where">product');
    expect(body).not.toContain('class="row-where">tech');
  });

  it('does not reveal a hidden ancestor through breadcrumbs or filters', async () => {
    repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, workstreams: [
      { id: 'product', name: 'Pricing', parent: 'tech' }, { id: 'tech', name: 'Secret launch' },
    ] }));
    await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(view.tasks.open[0].where).toBe('Pricing');
    const { body } = await visit('/project/acme/ledger?taskWs=tech&taskOwner=Unknown', MEMBER_GOOGLE);
    expect(body).not.toContain('Secret launch');
    expect(body).not.toContain('value="tech"');
    expect(body).not.toContain('Unknown');
    expect(body).toContain('id="t-pricing-page"');
  });

  it('keeps linked tasks visible through conflicting filters, including completed tasks', async () => {
    const { body } = await visit('/project/acme/ledger?task=pricing-page&taskWs=tech&taskOwner=Dev', MANAGER);
    expect(body).toContain('class="item tier-task marked" id="t-pricing-page"');
    expect(body).toContain('value="product" selected');
    const done = await visit('/project/acme/ledger?task=old-thing', MANAGER);
    expect(done.body).toContain('class="item tier-task marked" id="t-old-thing"');
    expect(row(done.body, 't-old-thing')).toContain('class="status-chip">done');
  });

  it('shows proposed additions without numbers, and edits of a record without one either', async () => {
    records([{ id: 'w1', type: 'decision', text: 'price it', status: 'active' }]);
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', source: 'mcp', summary: 'Pricing changes', workstream: 'product',
      operations: [
        { type: 'addRecord', record: { type: 'rule', text: 'New proposed rule', key: 'R-999' } },
        { type: 'addTask', title: 'New proposed task' },
        { type: 'editRecord', id: 'w1', changes: { text: 'Updated price' } },
        { type: 'setRecordStatus', id: 'w1', status: 'replaced' },
      ],
    }));
    const before = [...repo.files];
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(row(body, 'proposal-c-1-0')).toContain('class="num">—');
    expect(row(body, 'proposal-c-1-1')).toContain('class="type-label">Task');
    expect(row(body, 'proposal-c-1-1')).toContain('class="num">—');
    expect(row(body, 'proposal-c-1-2')).toContain('class="num">—');
    expect(row(body, 'proposal-c-1-3')).toContain('Awaiting review · replaced');
    expect(row(body, 'proposal-c-1-0')).toContain('data-who="Priya"');
    expect(row(body, 'proposal-c-1-0')).toContain('item=c-1');
    expect(body).not.toContain('R-999');
    expect(body).not.toContain('item=undefined');
    expect([...repo.files]).toEqual(before);
  });

  it('escapes hostile owner, location, text and source values', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    repo.files.set('.teamctx/config.json', JSON.stringify({ ...CONFIG, workstreams: [{ id: 'product', number: 1, name: hostile }] }));
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: hostile, records: [],
      tasks: [{ id: 'pricing-page', key: '1.1', title: hostile, owner: hostile, status: 'open' }],
    }));
    const { body } = await visit(`/project/acme/ledger?ws=product&taskOwner=${encodeURIComponent(hostile)}`, MANAGER);
    expect(body).not.toContain(hostile);
    expect(body).toContain('&lt;img');
    expect(body).not.toContain('onerror="alert(1)"');
  });

  it('preserves signed-out history and filter selections through sign-in', async () => {
    const path = '/project/acme/ledger?taskWs=%40all&taskOwner=Mary%20Jane&tab=review';
    const result = await visit(path);
    expect(result.status).toBe(303);
    expect(result.location).toContain('tab=review');
    expect(new URLSearchParams(result.location.split('?returnTo=')[1].split('?')[1]).get('taskOwner')).toBe('Mary Jane');
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

  it('opens from an icon beside the goal, one beside the project, and one beside each workstream', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/<button type="button" class="ctx-open" data-panel="dp-project" aria-label="Read the full goal and why it matters"/);
    expect(body).toMatch(/data-panel="dp-project" aria-label="Project summary and context"/);
    expect(body).toMatch(/data-panel="dp-ws-product" aria-label="Context for Product"/);
    expect(body).toMatch(/data-panel="dp-ws-tech" aria-label="Context for Tech"/);
  });

  it('opens from the tasks heading too once a workstream is picked', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const head = /<div class="tasks-head">[\s\S]*?<\/form>/.exec(body)[0];
    expect(head).toMatch(/data-panel="dp-ws-product" aria-label="Context for Product"/);
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

describe('the task filters', () => {
  it('sit beside the heading, as compact pickers', async () => {
    const { body } = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    const head = /<div class="tasks-head">[\s\S]*?<\/form>\s*<\/div>/.exec(body)[0];
    expect(head).toContain('class="section-title">Tasks<');
    expect(head).toMatch(/<label class="pick"><span>Where<\/span><select name="taskWs"/);
    expect(head).toMatch(/<label class="pick"><span>Owner<\/span><select name="taskOwner"/);
  });

  it('wait for their button rather than reloading on every change', async () => {
    const { body } = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    expect(body).toContain('<button type="submit" class="apply">Filter</button>');
    expect(body).not.toContain("document.querySelectorAll('.task-filters select')");
  });

  it('land back on the list after filtering, not the top of the page', async () => {
    const { body } = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    expect(body).toMatch(/<form class="task-filters" method="GET" action="\/project\/acme\/ledger#panel">/);
    expect(body).toContain('id="panel"');
  });

  it('are not full-width form fields', async () => {
    // The theme makes every select width:100%, which is what made these ugly.
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/\.task-filters select\{width:auto/);
  });

  it('offer a way back only when a filter is on', async () => {
    const plain = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    expect(plain.body).not.toMatch(/class="clear"/);
    const filtered = await visit('/project/acme/ledger?taskOwner=Dev', MANAGER);
    expect(filtered.body).toMatch(/<a class="clear" href="\/project\/acme\/ledger#panel">Clear<\/a>/);
  });
});

/**
 * Headings, tabs and pages on the project page.
 *
 * The row anatomy is fixed — number, type, text, owner, status, source — and
 * without headings nobody could tell what each part was. Tasks and what is
 * waiting share the page as two tabs, and each list pages on its own.
 */
describe('reading the project page', () => {
  const manyTasks = (n) => Array.from({ length: n }, (_, i) => ({
    id: `ptask${i + 1}`, key: `1.${i + 1}`, title: `product task ${i + 1}`, owner: 'Priya', status: 'open',
  }));
  const setProduct = (tasks) => repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
    id: 'product', name: 'Product', records: [], tasks,
  }));

  it('heads the tasks with what each column is', async () => {
    const tasks = await visit('/project/acme/ledger', MANAGER);
    expect(tasks.body).toMatch(/<div class="row-head"[^>]*><span>No\.<\/span><span>Type<\/span><span>Task<\/span><span>Owner<\/span><span>Status<\/span><span[^>]*>Notes<\/span><span[^>]*>Source<\/span><\/div>/);
    const queue = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(queue.body).toMatch(/<span>No\.<\/span><span>Type<\/span><span>Proposal<\/span>/);
    expect(tasks.body).not.toContain('<span>Key</span>');
  });

  it('shows Tasks or Waiting on you, never both, with the active tab marked', async () => {
    const tasks = await visit('/project/acme/ledger', MANAGER);
    expect(tasks.body).toMatch(/<a href="[^"]*#panel" aria-current="page">Tasks/);
    expect(tasks.body).toContain('Draft the pricing page');
    expect(onPage(tasks.body)).not.toContain('adds the pricing tiers');
    const review = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(review.body).toMatch(/aria-current="page">Waiting on you/);
    expect(review.body).toContain('adds the pricing tiers');
    expect(onPage(review.body)).not.toContain('Draft the pricing page');
  });

  it('opens the tab that holds what a link points at', async () => {
    const task = await visit('/project/acme/ledger?task=pricing-page', MANAGER);
    expect(task.body).toMatch(/aria-current="page">Tasks/);
    expect(task.body).toMatch(/class="item tier-task marked" id="t-pricing-page"/);
    const waiting = await visit('/project/acme/ledger?review=c-1', MANAGER);
    expect(waiting.body).toMatch(/aria-current="page">Waiting on you/);
  });

  it('pages a long list, twenty to a page, landing back on the panel', async () => {
    setProduct(manyTasks(45));
    const first = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(first.body).toContain('product task 20<');
    expect(first.body).not.toContain('product task 21<');
    expect(first.body).toContain('Page 1 of 3');
    expect(first.body).toMatch(/href="\/project\/acme\/ledger\?ws=product&amp;page=2#panel">Next/);
    const second = await visit('/project/acme/ledger?ws=product&page=2', MANAGER);
    expect(second.body).toContain('product task 21<');
    expect(second.body).toContain('Page 2 of 3');
  });

  it('opens the page holding the task a link points at', async () => {
    setProduct(manyTasks(45));
    const { body } = await visit('/project/acme/ledger?ws=product&item=ptask33', MANAGER);
    expect(body).toContain('Page 2 of 3');
    expect(body).toMatch(/class="item tier-task marked" id="t-ptask33"/);
  });

  it('offers no pager when everything fits on one page', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).not.toContain('class="pager"');
  });
});

/**
 * The row's last three columns say what they are.
 *
 * Status held both the state and every governance note, so the notes had no
 * heading of their own; and the source was a coloured dot, which in a project
 * where everything arrives through an assistant was a column of identical
 * green dots.
 */
describe('status, notes and source in their own columns', () => {
  it('keeps the status apart from the notes', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const r = /<button[^>]*id="t-pricing-page"[\s\S]*?<\/button>/.exec(body)[0];
    expect(r).toMatch(/<span class="row-state"><span class="status-chip">open<\/span><\/span>/);
    expect(r).toMatch(/<span class="row-notes"><\/span>/);
  });

  it('puts a warning in the notes, not in the status', async () => {
    repo.files.set('.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', workstream: 'product',
      operations: [{ type: 'addRecord', record: { type: 'assumption', text: 'they will pay', owner: { name: 'O' }, reviewBy: '2020-01-01' } }],
    }));
    const { body } = await visit('/project/acme/ledger?tab=review', MANAGER);
    const r = /<button[^>]*id="proposal-c-1-0"[\s\S]*?<\/button>/.exec(body)[0];
    expect(r).toMatch(/<span class="row-notes"><span class="governance-chip warning-chip">Review overdue 2020-01-01<\/span><\/span>/);
  });

  it('labels each part on a narrow screen, where the header is hidden', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const narrow = body.slice(body.indexOf('@media(max-width:1200px)'));
    for (const label of ["content:'Owner: '", "content:'Status: '", "content:'Notes: '"]) expect(narrow).toContain(label);
  });
});

describe('the filter button', () => {
  it('looks like a button', async () => {
    const { body } = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    expect(body).toMatch(/\.task-filters \.apply\{[^}]*background:var\(--accent\)/);
  });

  it('is greyed out until the choice differs from what is shown', async () => {
    const { body } = await visit('/project/acme/ledger?tab=tasks', MANAGER);
    expect(body).toMatch(/\.task-filters \.apply:disabled\{/);
    expect(body).toContain('apply.disabled = ');
    // Rendered live, so it still works with JavaScript off.
    expect(body).toContain('<button type="submit" class="apply">Filter</button>');
  });
});

/**
 * The review queue is its own tab.
 *
 * It sat below the context with nothing between them, so the manager could not
 * tell where the team's context ended and what was waiting on them began. It
 * pages by proposal, so one proposal's changes are never split across pages.
 */
describe('waiting on you, as a tab', () => {
  const queue = (n) => {
    for (let i = 1; i <= n; i++) {
      repo.files.set(`.teamctx/queue/q-${String(i).padStart(2, '0')}.json`, JSON.stringify({
        id: `q-${String(i).padStart(2, '0')}`, status: 'pending', author: 'Priya', summary: `proposal ${i}`, workstream: null,
        operations: [{ type: 'addTask', title: `task from proposal ${i}` }],
      }));
    }
  };

  it('is offered to the manager, with a count, and keeps the queue off the tasks', async () => {
    const context = await visit('/project/acme/ledger', MANAGER);
    expect(context.body).toMatch(/>Waiting on you<span class="n">1<\/span>/);
    expect(context.body).not.toContain('id="r-c-1"');
    const review = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(review.body).toMatch(/aria-current="page">Waiting on you/);
    expect(review.body).toContain('id="r-c-1"');
  });

  it('is not offered to a member, and asking for it shows them their tasks', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger?tab=review', MEMBER_GOOGLE);
    expect(body).not.toContain('Waiting on you');
    expect(body).toMatch(/aria-current="page">Tasks/);
  });

  it('opens on its own for a link to a queued contribution', async () => {
    const { body } = await visit('/project/acme/ledger?review=c-1', MANAGER);
    expect(body).toMatch(/aria-current="page">Waiting on you/);
  });

  it('pages ten proposals at a time, never splitting one', async () => {
    queue(14);
    const first = await visit('/project/acme/ledger?tab=review', MANAGER);
    expect(first.body).toContain('Page 1 of 2');
    expect(first.body).toMatch(/href="\/project\/acme\/ledger\?tab=review&amp;page=2#panel">Next/);
    const second = await visit('/project/acme/ledger?tab=review&page=2', MANAGER);
    expect(second.body).toContain('Page 2 of 2');
    // Both the proposal and its change are on the same page.
    expect(second.body).toContain('proposal 14');
    expect(second.body).toContain('task from proposal 14');
  });
});
