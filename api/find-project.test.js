/**
 * Finding a project and opening it.
 *
 * The list of projects assumed somebody was already on every project they would
 * ever open. The one case that matters most is the opposite: a manager sends a
 * connector link, and the person it was sent to has nothing on their list at
 * all. So what is checked here is that the box takes whatever they pasted, that
 * it is opened only if they can actually read it, and that the reason comes back
 * on the page they typed it on rather than on an error page.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';

const repo = vi.hoisted(() => ({ files: new Map(), prefetchError: null, reposError: null }));

vi.mock('../src/adapters/github.js', async (orig) => ({
  ...(await orig()),
  listPushableRepos: async () => {
    if (repo.reposError) throw new Error(repo.reposError);
    return [
      { fullName: 'acme/ledger', private: true },
      { fullName: 'acme/atlas', private: false },
    ];
  },
  listUserOrgs: async () => [],
  GithubSession: class {
    constructor({ owner, repo: name, ghToken }) {
      Object.assign(this, { owner, repo: name, ghToken });
      repo.usedToken = ghToken;
    }

    async prefetch() {
      // Only the one repository exists; anything else is a 404 from GitHub, the
      // way a mistyped name arrives in real life.
      if (repo.prefetchError) throw new Error(repo.prefetchError);
      if (`${this.owner}/${this.repo}`.toLowerCase() !== 'acme/ledger') throw new Error('404 Not Found');
    }

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
const MEMBER = { id: null, login: null, name: 'Priya', email: 'priya@example.com', token: null, source: 'google' };
const STRANGER = { ...MEMBER, name: 'Sam', email: 'sam@example.com' };

const CONFIG = {
  project: 'Ledger',
  managerKey: 'git:maya@example.com',
  workstreams: [{ id: 'product', name: 'Product' }],
  roles: [],
  members: [{ key: 'git:priya@example.com', name: 'Priya', email: 'priya@example.com' }],
};

function project(config = CONFIG) {
  repo.files = new Map([
    ['.teamctx/config.json', JSON.stringify(config)],
    ['.teamctx/contributions.jsonl', ''],
    ['.teamctx/project.json', JSON.stringify({ name: 'Ledger', whys: [], tasks: [] })],
    ['.teamctx/workstreams/product.json', JSON.stringify({
      id: 'product', name: 'Product', whys: [{ id: 'w1', text: 'price it', whats: [] }], tasks: [],
    })],
  ]);
  repo.prefetchError = null;
  repo.reposError = null;
}

const lend = () => kvSet(keys.projectGhCred('acme', 'ledger'), { token: 'gh-lent', lentByEmail: 'maya@example.com' });

async function as(user, path, body) {
  await kvSet(keys.session('s'), user);
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: {
      cookie: 'teamctx_sid=s',
      ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(body === undefined ? {} : { body: new URLSearchParams(body).toString() }),
  });
  return { status: res.status, location: decodeURIComponent(res.headers.get('location') || ''), body: await res.text() };
}

const openRef = (user, ref) => as(user, '/projects', { ref });
const listed = email => kvGet(keys.connectedProjects(email)).then(r => r?.projects || []);

beforeEach(() => {
  __resetMemory();
  project();
});

describe('the box on the projects page', () => {
  it('is there even when nothing is on the list', async () => {
    const { body } = await as(MANAGER, '/projects');
    expect(body).toContain('name="ref"');
    expect(body).toMatch(/Nothing on your list yet/);
  });

  it('suggests the repositories this person can reach', async () => {
    const { body } = await as(MANAGER, '/projects');
    expect(body).toContain('<datalist id="ref-list"');
    expect(body).toContain('value="acme/ledger"');
    expect(body).toContain('value="acme/atlas"');
  });

  it('does not open with every repository this person can reach', async () => {
    // It listed them all under the box. There were hundreds, and a page that
    // opens with hundreds of lines of things you did not ask about is a page
    // people stop reading. They belong in the box, not on the page.
    const { body } = await as(MANAGER, '/projects');
    expect(body).not.toContain('Repositories you can reach');
    // No one-click chips either: those belong to a search somebody asked for.
    expect(body).not.toContain('name="ref" value="acme/atlas"');
  });

  it('is the same box as the settings page uses', async () => {
    // One way to name a project across the app, so what somebody learns in one
    // place is true in the other.
    const { body } = await as(MANAGER, '/projects');
    expect(body).toContain('placeholder="Type to search, or paste owner/repo"');
    expect(body).toContain('list="ref-list"');
  });

  it('still shows the box when the repository listing fails', async () => {
    // Suggestions are a convenience; the box is the feature.
    repo.reposError = 'GitHub says no';
    const { status, body } = await as(MANAGER, '/projects');
    expect(status).toBe(200);
    expect(body).toContain('name="ref"');
    expect(body).not.toContain('<datalist');
  });

  it('offers no repository list to a Google sign-in, and says what to paste', async () => {
    const { body } = await as(MEMBER, '/projects');
    expect(body).toContain('name="ref"');
    expect(body).not.toContain('<datalist');
    expect(body).toMatch(/link your manager sent you/);
  });
});

describe('searching for a project by name', () => {
  it('finds a repository by its own name, not only by its owner', async () => {
    // With `owner/repo` in a datalist, a browser that matches only the start of
    // the value finds every repository when you type the owner and none when you
    // type the repository — so the search happens here instead.
    const { status, body } = await openRef(MANAGER, 'atlas');
    expect(status).toBe(200);
    expect(body).toContain('Matching "atlas"');
    // The matches, not the whole datalist, which carries every repository.
    expect(body).toContain('name="ref" value="acme/atlas"');
    expect(body).not.toContain('name="ref" value="acme/ledger"');
  });

  it('matches the owner too, and ignores case', async () => {
    const { body } = await openRef(MANAGER, 'ACME');
    expect(body).toContain('name="ref" value="acme/atlas"');
    expect(body).toContain('name="ref" value="acme/ledger"');
  });

  it('matches part of a name, anywhere in it', async () => {
    const { body } = await openRef(MANAGER, 'edge');
    expect(body).toContain('name="ref" value="acme/ledger"');
  });

  it('opens a match in one click', async () => {
    // What the chip posts is what the box accepts, so clicking one is the same
    // request as typing the full name.
    expect((await openRef(MANAGER, 'ledger')).body).toContain('name="ref" value="acme/ledger"');
    const { status, location } = await openRef(MANAGER, 'acme/ledger');
    expect(status).toBe(303);
    expect(location).toBe('/project/acme/ledger');
  });

  it('offers a Google sign-in no search, because it has no repository list', async () => {
    const { body } = await openRef(MEMBER, 'ledger');
    expect(body).toContain('Nothing you can reach matches');
  });
});

describe('opening whatever was pasted', () => {
  it('takes the name typed in', async () => {
    const { status, location } = await openRef(MANAGER, 'acme/ledger');
    expect(status).toBe(303);
    expect(location).toBe('/project/acme/ledger');
  });

  it('takes the connector URL a manager hands out', async () => {
    const { location } = await openRef(MANAGER, 'https://team.example.app/api/mcp/acme/ledger');
    expect(location).toBe('/project/acme/ledger');
  });

  it('takes a link to something inside the project', async () => {
    const { location } = await openRef(MANAGER, 'https://team.example.app/project/acme/ledger?ws=product&item=w1');
    expect(location).toBe('/project/acme/ledger');
  });

  it('takes the repository on GitHub', async () => {
    const { location } = await openRef(MANAGER, 'https://github.com/acme/ledger/tree/main');
    expect(location).toBe('/project/acme/ledger');
  });

  it('puts it on their list, so the next visit starts from there', async () => {
    await openRef(MANAGER, 'acme/ledger');
    expect(await listed('maya@example.com')).toContain('acme/ledger');
  });

  it('sends a signed-out visitor to sign in first', async () => {
    const res = await fetch(`${base}/projects`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ref: 'acme/ledger' }).toString(),
    });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get('location'))).toBe('/signin?returnTo=/projects');
  });
});

describe('when it cannot be opened', () => {
  it('says nothing matched, on the page, with the text still in the box', async () => {
    const { status, body } = await openRef(MANAGER, 'what even is this');
    expect(status).toBe(200);
    expect(body).toContain('Nothing you can reach matches');
    expect(body).toContain('value="what even is this"');
  });

  it('asks for something when the box was empty', async () => {
    const { body } = await openRef(MANAGER, '   ');
    expect(body).toContain('Type the name of a project');
  });

  it('will not take the last two segments of an unrelated link on faith', async () => {
    // It must not decide that this means acme/ledger. Searching for it finds
    // nothing, which is the right amount of guessing.
    const { status, location, body } = await openRef(MANAGER, 'https://example.com/acme/ledger');
    expect(status).toBe(200);
    expect(location).toBe('');
    expect(body).toContain('Nothing you can reach matches');
    expect(await listed('maya@example.com')).toEqual([]);
  });

  it('reports what GitHub said about a repository that is not there', async () => {
    const { status, body } = await openRef(MANAGER, 'acme/nope');
    expect(status).toBe(200);
    expect(body).toContain('acme/nope could not be read');
    expect(body).toContain('404');
    expect(body).toContain('value="acme/nope"');
  });

  it('keeps it off the list when it could not be opened', async () => {
    await openRef(MANAGER, 'acme/nope');
    expect(await listed('maya@example.com')).toEqual([]);
  });

  it('tells a Google sign-in that the project has lent no GitHub access', async () => {
    // This is the check that matters to somebody who was sent a link: whether
    // read access is shared at all, said in the words of what is missing rather
    // than as "not found".
    const { body } = await openRef(MEMBER, 'https://team.example.app/api/mcp/acme/ledger');
    expect(body).toContain('has not lent GitHub access');
    expect(await listed('priya@example.com')).toEqual([]);
  });

  it('opens it for a Google sign-in once access is lent and the address is on the roster', async () => {
    await lend();
    const { status, location } = await openRef(MEMBER, 'https://team.example.app/api/mcp/acme/ledger');
    expect(status).toBe(303);
    expect(location).toBe('/project/acme/ledger');
    expect(repo.usedToken).toBe('gh-lent');
    expect(await listed('priya@example.com')).toContain('acme/ledger');
  });

  it('turns away an address the project does not have', async () => {
    await lend();
    const { body } = await openRef(STRANGER, 'acme/ledger');
    expect(body).toContain('not on the acme/ledger roster');
    expect(await listed('sam@example.com')).toEqual([]);
  });
});

describe('the person who made the project, coming back through Google', () => {
  it('is let in on the GitHub account their address has proved', async () => {
    // A project made on the web records its manager by GitHub id, so the
    // creator's own address is nowhere on the roster. Signing in with Google
    // turned them away from their own project.
    project({ ...CONFIG, managerKey: 'github:7', members: [] });
    await lend();
    await kvSet(keys.githubIdentities('maya@example.com'), { ids: ['7'] });
    const { status, location } = await openRef({ ...MEMBER, name: 'Maya', email: 'maya@example.com' }, 'acme/ledger');
    expect(status).toBe(303);
    expect(location).toBe('/project/acme/ledger');
  });

  it('does not let anyone else inherit that proof', async () => {
    project({ ...CONFIG, managerKey: 'github:7', members: [] });
    await lend();
    await kvSet(keys.githubIdentities('maya@example.com'), { ids: ['7'] });
    const { body } = await openRef(STRANGER, 'acme/ledger');
    expect(body).toContain('not on the acme/ledger roster');
  });
});
