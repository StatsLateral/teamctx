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
    ['.teamctx/project.json', JSON.stringify({ name: 'Ledger', records: [{ id: 'p1', type: 'decision', text: 'ship it', status: 'active' }], tasks: [] })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product',
      records: [{ id: 'w1', type: 'decision', text: 'price it', status: 'active', detail: 'how we price', sourceContributionIds: ['c-prod'] }],
      tasks: [{ id: 'pricing-page', title: 'Draft the pricing page', owner: 'Priya', status: 'open' }],
    })],
    ['.teamctx/workstreams/tech.json', JSON.stringify({
      id: 'tech', name: 'Tech',
      records: [{ id: 't1', type: 'decision', text: 'keep the servers up', status: 'active', sourceContributionIds: ['c-tech'] }],
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
    // It names the repository and tells the assistant how to check it is on
    // that one — the version before this said a connector "may be named
    // something else", which told an assistant on a different project to carry
    // on, and it did: it answered about the nearest thing it could find.
    expect(prompt).toContain('connected to the repository acme/ledger');
    expect(prompt).toContain('get_connect_url');
    expect(prompt).toContain('stop and tell me');
    expect(prompt).not.toContain('may be named something else');
    expect(prompt).toContain('the part of the work called &quot;Product&quot;');
    expect(prompt).toContain('quoted word for word');
    expect(prompt).toContain('Find this, quoted word for word');
    expect(prompt).toContain('&quot;price it&quot;');
    expect(prompt).toContain('say so plainly rather than answering about the closest thing');
  });

  it('says so plainly when the statement belongs to the project itself', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).toMatch(/the project.{0,8}s own context \(not one part of the work\)/);
    expect(prompt).toContain('acme/ledger');
  });

  it('names the part of the work by id as well as by name', async () => {
    // Two workstreams can read alike; the id is what a tool looks up.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).toContain('(id: product)');
  });

  it('carries the address of the page it was copied from', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).toMatch(/The page it came from: https?:[^ ]*project\/acme\/ledger/);
    expect(prompt).toContain('item=w1');
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
    repo.files.set('.teamctx/workstreams/tech.json', JSON.stringify({ id: 'tech', name: 'Tech', records: [], tasks: [] }));
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
    expect(body).toMatch(/class="item tier-decision marked"/);
  });

  it('reaches the same row by key as by id', async () => {
    // #126's third acceptance criterion. Links carry the internal id, which
    // never changes; the key is what a person has in front of them, so a link
    // pasted from the page or out of a prompt has to land in the same place.
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product',
      records: [{ id: 'w1', key: 'D-7', type: 'decision', text: 'price it', status: 'active', sourceContributionIds: ['c-prod'] }],
      tasks: [{ id: 'pricing-page', key: 'T-3', title: 'Draft the pricing page', owner: 'Priya', status: 'open' }],
    }));
    const byId = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    const byKey = await visit('/project/acme/ledger?ws=product&item=D-7', MANAGER);
    expect(byKey.body).toMatch(/class="item tier-decision marked"/);
    expect(byKey.body).toContain('<span class="num">D-7</span>');
    expect(byKey.body).toContain('Tell me more about D-7:');
    expect(byKey.body).toBe(byId.body);
  });

  it('reaches a task by its key too', async () => {
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', records: [],
      tasks: [{ id: 'pricing-page', key: 'T-3', title: 'Draft the pricing page', owner: 'Priya', status: 'open' }],
    }));
    const { body } = await visit('/project/acme/ledger?task=T-3', MANAGER);
    expect(body).toMatch(/<tr id="t-pricing-page" class="marked"/);
    expect(body).toContain('<span class="num">T-3</span>');
  });

  it('falls back quietly for a key that names nothing', async () => {
    // Same quiet landing an unknown id gets — the page, nothing marked, and the
    // value never written back into it.
    const { status, body } = await visit('/project/acme/ledger?ws=product&item=D-99', MANAGER);
    expect(status).toBe(200);
    // Not "marked" anywhere: that word is in the stylesheet. Nothing *carries*
    // the class.
    expect(body).not.toMatch(/class="item[^"]*marked/);
    expect(body).not.toContain('D-99');
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
  it('opens the drawer for a statement it pointed at', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(body).toMatch(/class="item tier-decision marked"/);
  });

  it('marks a task, and its drawer carries the task itself, never "undefined"', async () => {
    // A task is an item in its own right now, so the drawer it opens must hold
    // its title rather than a statement's missing fields.
    const { body } = await visit('/project/acme/ledger?ws=product&task=pricing-page', MANAGER);
    expect(body).toMatch(/<tr id="t-pricing-page" class="marked">/);
    const marked = /<button class="item[^"]*marked"[^>]*data-text="([^"]*)"/.exec(body);
    if (marked) expect(marked[1]).not.toBe('undefined');
    expect(body).not.toContain('data-text="undefined"');
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

describe('a tree longer than the window', () => {
  it('scrolls inside its column rather than stretching the page', async () => {
    // One long How list otherwise drags the page down past everything beside
    // it, leaving the other two columns as short marks at the top of a blank.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toMatch(/\.col\{[^}]*max-height/);
    expect(body).toMatch(/\.col-body\{[^}]*overflow-y:auto/);
  });

  it('bounds the list the same way, so the toggle does not change the scrolling', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product&view=list', MANAGER);
    expect(body).toMatch(/\.list\{[^}]*overflow-y:auto/);
  });

  it('lets the window do the scrolling on a phone', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const narrow = body.slice(body.indexOf('@media(max-width:760px)'));
    expect(narrow).toMatch(/\.col,\.list\{max-height:none\}/);
  });
});

describe('the space above the tree', () => {
  it('is a back link, the name and the repository — nothing else', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const header = body.slice(body.indexOf('class="crumb"'), body.indexOf('class="layout"'));
    expect(header).toContain('All projects');
    expect(header).toContain('acme/ledger');
    // Whether you manage the project is not news to you, and it cost a line
    // that pushed the tree below where the eye lands.
    expect(header).not.toMatch(/you manage this project|you are on this project/);
  });

  it('does not tell a member their standing either', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger', MEMBER_GOOGLE);
    expect(body).not.toContain('you are on this project');
  });
});

describe('a statement with nothing recorded behind it', () => {
  it('shows no dot rather than a colour that means nothing', async () => {
    // The project tree's Why has no sourceContributionIds in this fixture.
    const { body } = await visit('/project/acme/ledger', MANAGER);
    expect(body).toContain('class="dot none"');
    expect(body).toContain('.dot.none{background:none}');
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

  it('hands over the rule an allowed exception bends, so nothing has to go looking', async () => {
    // An assistant that has to find the rule reads the whole project, and then
    // answers with the whole project.
    repo.files.set('.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', tasks: [],
      records: [
        { id: 'w1', type: 'decision', text: 'price it', status: 'active' },
        { id: 'r1', type: 'rule', text: 'no discounts over 15%', status: 'active' },
        { id: 'e1', type: 'exception', text: 'Acme may get 20%', status: 'active', expiresAt: '2999-12-31', links: { bends: 'r1' } },
      ],
    }));
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompts = [...body.matchAll(/data-prompt="([^"]+)"/g)].map(m => m[1]);
    const exc = prompts.find(p => p.includes('Acme may get 20%'));
    expect(exc).toContain('an allowed exception to the rule &quot;no discounts over 15%&quot;');
    expect(exc).not.toMatch(/\bthe (What|Why) /);
  });

  it('asks about the one statement, not the project around it', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).toContain('tell me about that one thing');
    expect(prompt).toContain('what is still open for it');
    expect(prompt).toContain('Do not summarise the rest of the project');
  });

  it("asks for it in a colleague's words, not in the project's", async () => {
    // What came back read like a tour of the data model: headings, field names,
    // and a walk back up the tree, to somebody who asked about one line on a
    // page and does not care how it is stored.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).toContain('the way a colleague would');
    expect(prompt).toContain('Do not explain how the project stores any of this');
    expect(prompt).toContain('do not walk me back up the structure');
    // What to talk about, and nothing about how to lay it out. Banning headings
    // and lists was the wrong lever: the subject was wrong, not the shape, and a
    // model told how to format itself loses formatting it would have chosen well.
    expect(prompt).not.toMatch(/heading|bullet/i);
  });

  it('says nothing about parents for a goal, which has none', async () => {
    const { body } = await visit('/project/acme/ledger', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    expect(prompt).not.toContain('an allowed exception to the rule');
  });

  it('opens with the question and keeps the instructions below it', async () => {
    // A hundred words in a single line is correct and frightening: the person
    // who has just pasted it cannot see its shape, so they delete it. And what
    // they see first should be their own question, not teamctx clearing its
    // throat.
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    const prompt = /data-prompt="([^"]+)"/.exec(body)[1];
    const text = prompt.replace(/&#10;/g, NL);
    expect(text.split(NL).length).toBeGreaterThan(8);
    // The question first, in the words somebody would use out loud, and
    // everything the assistant has to do below it, addressed to the assistant.
    expect(text.startsWith('Tell me more about &quot;price it&quot;.')).toBe(true);
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

describe('stored record fields are never trusted as markup', () => {
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
describe('an item that names nothing', () => {
  it('is not carried into the view toggle, by id or by key', async () => {
    const byId = await visit('/project/acme/ledger?ws=product&item=rec-gone', MANAGER);
    const byKey = await visit('/project/acme/ledger?ws=product&item=D-99', MANAGER);
    expect(byId.body).not.toContain('rec-gone');
    expect(byKey.body).not.toContain('D-99');
  });

  it('is dropped even when it would pass the id rules', async () => {
    // The check is whether it reaches something, not whether it looks plausible.
    const { body } = await visit('/project/acme/ledger?ws=product&item=w1.but.not', MANAGER);
    expect(body).not.toContain('w1.but.not');
  });

  it('still carries one that does, so the toggle keeps the highlight', async () => {
    // What the carrying was for: losing the highlight on the first click defeats
    // having landed on it.
    const { body } = await visit('/project/acme/ledger?ws=product&item=w1', MANAGER);
    expect(body).toMatch(/href="[^"]*item=w1[^"]*view=list"/);
  });

  it('is out of scope for a member, so it is dropped for them', async () => {
    await lend();
    const { body } = await visit('/project/acme/ledger?item=t1', MEMBER_GOOGLE);
    expect(body).not.toContain('t1');
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

  it('shows it on the row, so the page can be scanned without opening each one', async () => {
    breakIt(); restOnIt();
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toContain('needs review');
    expect(body).toContain('rests on a broken assumption');
  });

  it('does not show it once the manager has re-confirmed the decision', async () => {
    breakIt(); restOnIt({ reviewedAt: '2026-10-05T10:00:00.000Z' });
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).toContain('price it');
    expect(body).not.toContain('rests on a broken assumption');
  });

  it('says nothing on an ordinary project where nothing has broken', async () => {
    const { body } = await visit('/project/acme/ledger?ws=product', MANAGER);
    expect(body).not.toContain('rests on a broken assumption');
  });
});
