/**
 * Where a project stands, for somebody who would rather look than ask.
 *
 * Everything shown here is already in the repository; what is checked is that
 * the page reads it with the right credential, shows only what the person is
 * allowed to see, and keeps the manager's queue to the manager.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map(), prefetchError: null }));

vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  listPushableRepos: async () => [],
  listUserOrgs: async () => [],
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

const { kvSet, keys, __resetMemory } = await import('../src/oauth/kv.js');

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
  workstreams: [{ id: 'product', name: 'Product' }, { id: 'tech', name: 'Tech' }],
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
    ['.teamctx/project.json', JSON.stringify({ name: 'Ledger', whys: [{ id: 'p1', text: 'ship it' }], tasks: [] })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product',
      whys: [{ id: 'w1', text: 'price it', summary: 'how we price', sourceContributionIds: ['c-prod'], whats: [] }],
      tasks: [{ id: 'pricing-page', title: 'Draft the pricing page', owner: 'Priya', status: 'open' }],
    })],
    ['.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech',
      whys: [{ id: 't1', text: 'keep the servers up', sourceContributionIds: ['c-tech'], whats: [] }],
      tasks: [
        { id: 'migrate-db', title: 'Migrate the database', owner: 'Dev', status: 'open' },
        { id: 'old-thing', title: 'Something finished', owner: 'Dev', status: 'done' },
      ],
    })],
    ['.teamctx/queue/c-1.json', JSON.stringify({
      id: 'c-1', status: 'pending', author: 'Priya', summary: 'adds the pricing tiers', workstream: 'product',
    })],
  ]);
  repo.prefetchError = null;
}

async function visit(path, user) {
  if (user) await kvSet(keys.session('s'), user);
  const res = await fetch(`${base}${path}`, {
    method: 'GET', redirect: 'manual', headers: user ? { cookie: 'teamctx_sid=s' } : {},
  });
  return { status: res.status, location: decodeURIComponent(res.headers.get('location') || ''), body: await res.text() };
}

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

beforeEach(() => {
  __resetMemory();
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
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('Draft the pricing page');
    expect(body).toContain('Migrate the database');
    expect(body).not.toContain('Something finished');
    expect(body).toMatch(/1\s*\n?task already done/);
  });

  it('sees what is waiting on them', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
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
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
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
    expect(body).toContain('you manage this project');
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
    expect((await visit('/projects', MANAGER)).body).toMatch(/Nothing here yet/);
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
});

describe('the tree the page draws', () => {
  it('opens on the project itself, and draws the part you pick', async () => {
    const start = await visit('/project/acme/ledger', MANAGER);
    expect(start.body).toContain('ship it');           // the project's own Why
    const product = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(product.body).toContain('price it');        // product's
  });

  it('never carries a tree the reader is not on, not even hidden', async () => {
    // Scope that only holds in the markup is not scope: a reader who opens the
    // network tab is still a reader.
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('keep the servers up');
    expect(body).not.toContain('Migrate the database');
  });

  it('names who wrote a statement, and what kind of source it came from', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toMatch(/data-who="Priya"/);
    // The dot says where it came through — teamctx records the surface, not
    // whether a person or a model wrote the words.
    expect(body).toMatch(/class="dot mcp"/);
    expect(body).toMatch(/data-summary="how we price"/);
  });

  it('numbers the statements on screen', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toMatch(/class="num">1</);
  });

  it('writes a prompt a fresh chat can act on', async () => {
    // Beside the page, "tell me more about X in Y" reads fine. Pasted into a
    // new conversation it names nothing an assistant can act on — which of
    // several projects, and with what.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).toContain('teamctx project acme/ledger');
    expect(prompt).toContain('your connector may be named something else');
    expect(prompt).toContain('the part of the work called &quot;Product&quot;');
    expect(prompt).toContain('this why: &quot;price it&quot;');
    expect(prompt).toMatch(/get_workstream|my_brief/);
  });

  it('says so plainly when the statement belongs to the project itself', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).toContain('the project context itself');
    expect(prompt).toContain('acme/ledger');
  });

  it('shows the project context above a workstream, as inherited', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toMatch(/Project context — inherited/);
    expect(body).toContain('ship it');
  });

  it('offers both views, and switches on a plain link', async () => {
    const columns = await visit('/project/acme/ledger', MANAGER);
    expect(columns.body).toContain('class="columns"');
    const asList = await visit('/project/acme/ledger?view=list', MANAGER);
    expect(asList.body).toContain('class="list"');
  });

  it('says so plainly when a part of the work holds nothing yet', async () => {
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({ id: 'tech', name: 'Tech', whys: [], tasks: [] }));
    const { body } = await visit('/project/acme/ledger?ws=tech', MANAGER);
    expect(body).toMatch(/Nothing written here yet/);
  });
});

describe('arriving from a link', () => {
  it('opens the part of the work the link named', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toMatch(/class="lane on"[^>]*href="[^"]*ws=product/);
  });

  it('marks the item the link pointed at', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(body).toMatch(/class="item tier-why marked"/);
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

  it('gives the manager all of them', async () => {
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MANAGER });
    expect(Object.keys(view.trees).sort()).toEqual(['product', 'tech']);
  });

  it('always carries the project tree, which everybody inherits', async () => {
    await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(view.projectTree.whys[0].text).toBe('ship it');
  });

  it('carries the contributions behind the trees it sent, and no more', async () => {
    await lend();
    const view = await readProjectView({ owner: 'acme', repo: 'ledger', user: MEMBER_GOOGLE });
    expect(Object.keys(view.contributions)).toEqual(['c-prod']);
  });
});

describe('what a link may and may not open', () => {
  it('opens the drawer for a statement it pointed at', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(body).toMatch(/class="item tier-why marked"/);
  });

  it('marks a task without pretending it is a statement', async () => {
    // A row carries none of a statement's data; opening the drawer on it put
    // the word "undefined" on screen and then on somebody's clipboard.
    const { body } = await visit('/project/acme/ledger?ws=product&task=pricing-page', MANAGER);
    expect(body).toMatch(/<tr id="t-pricing-page" class="marked">/);
    expect(body).not.toMatch(/class="item[^"]*marked"/);
  });

  it('gives a marked row something to look at', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&task=pricing-page', MANAGER);
    expect(body).toContain('tr.marked td');
  });

  it('keeps what was pointed at when the view is switched', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(body).toMatch(/href="[^"]*ws=product[^"]*item=w1[^"]*view=list"/);
  });

  it('does not make inherited project context look clickable', async () => {
    // Those rows belong to the project's own lane and carry no statement data.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const band = body.slice(body.indexOf('inherited'), body.indexOf('tree-head'));
    expect(band).not.toContain('class="item');
  });
});
