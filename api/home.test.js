import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { kvSet, keys, __resetMemory } from '../src/oauth/kv.js';

/**
 * There was no `/` route at all — every path started at `/settings`, which
 * assumes you already know what teamctx is and have a repository. A manager
 * sent the deployment URL had nowhere to arrive.
 */
let server, base;

beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const get = async (path) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.text() };
};

describe('the front door', () => {
  it('answers at all', async () => {
    expect((await get('/')).status).toBe(200);
  });

  it('says what teamctx is before asking for anything', async () => {
    // Somebody arriving cold has not agreed to sign into anything yet.
    const { body } = await get('/');
    expect(body).toMatch(/git repository/i);
  });

  it('describes all three levels, not just the top one', async () => {
    // The tree is why → what → how. Saying only "why" describes the root and
    // drops what the team actually acts on.
    const { body } = await get('/');
    for (const level of ['why', 'what', 'how']) {
      expect(body.toLowerCase(), `missing: ${level}`).toContain(`<strong>${level}</strong>`);
    }
  });

  it('mentions that each person gets their own slice', async () => {
    // The per-role compiled view is the thing teamctx does that a shared doc
    // does not, and it was missing from the description entirely.
    expect((await get('/')).body).toMatch(/role/i);
  });

  it('lays out the whole path, not just the next click', async () => {
    // The issue this closes was never one broken screen — it was that no page
    // showed where the steps led.
    const { body } = await get('/');
    for (const step of ['Sign in with GitHub', 'Point it at a project', 'Add your AI key',
                        'Connect your assistant', 'Invite your team']) {
      expect(body, `missing step: ${step}`).toContain(step);
    }
  });

  it('sends a signed-out visitor to sign in', async () => {
    const { body } = await get('/');
    expect(body).toContain('/settings/signin');
    expect(body).toContain('Start here');
  });

  it('says signing in commits them to nothing', async () => {
    // The step people hesitate on, and the hesitation is reasonable.
    expect((await get('/')).body).toMatch(/creates nothing on its own/i);
  });

  it('offers a way to settings for somebody already signed in', async () => {
    // Signed out, the page is an explainer. Signed in, it is a hallway — and a
    // hallway with no door to settings sends people back to a URL they have to
    // remember.
    const { body } = await get('/');
    expect(body).toContain('/settings/signin');
  });

  it('styles its call to action as a link, not a button inside one', async () => {
    // A <button> nested in an <a> is invalid, and renders as a stretched pill
    // with whatever follows jammed against it.
    const { body } = await get('/');
    expect(body).not.toMatch(/<a[^>]*>\s*<button/);
    expect(body).toContain('class="btn"');
  });

  it('does not offer signed-out visitors a page they cannot open', async () => {
    // Settings and New project both bounce to sign-in. Showing them is a dead
    // end dressed as a choice.
    const { body } = await get('/');
    expect(body).not.toContain('href="/settings"');
    expect(body).not.toContain('href="/settings/new-project"');
    expect(body).toContain('Sign in');
  });

  it('marks exactly one nav item as the current page', async () => {
    const { body } = await get('/');
    expect((body.match(/aria-current="page"/g) || []).length).toBe(1);
  });

  it('makes clear the work does not stop at setup', async () => {
    // "This isn't a one-time setup wizard" — the loop is the product.
    expect((await get('/')).body).toMatch(/loop, not a setup wizard/i);
  });
});

describe('the front door, once you have set something up', () => {
  const signedIn = async (path = '/') => {
    __resetMemory();
    await kvSet(keys.session('sid1'), { id: '1', login: 'ada', name: 'Ada', token: 't' });
    await kvSet(keys.sharedProjects('1'), { projects: ['acme/ledger'] });
    await kvSet(keys.lentProjects('1'), { projects: ['acme/docs', 'acme/ledger'] });
    const r = await fetch(base + path, { headers: { cookie: 'teamctx_sid=sid1' } });
    return await r.text();
  };

  it('offers settings plainly, not behind a vague continue', async () => {
    // Without a link here, somebody who set a project up months ago has to
    // remember a URL to change anything.
    expect(await signedIn()).toContain('href="/settings"');
  });

  it('lists the projects they have configured', async () => {
    const body = await signedIn();
    expect(body).toContain('acme/ledger');
    expect(body).toContain('acme/docs');
  });

  it('lists a project once even when it appears on both lists', async () => {
    // A project you shared a key with *and* lent access to is one project.
    const body = await signedIn();
    expect((body.match(/acme\/ledger/g) || []).length).toBe(1);
  });

  it('says who they are signed in as', async () => {
    expect(await signedIn()).toContain('ada');
  });

  it('leads with creating a project rather than the explainer', async () => {
    // They have read it. The next thing they want is another project.
    expect(await signedIn()).toContain('Create a new project');
  });
});

describe('a signed-out visitor is never cornered', () => {
  it('can get back out of the sign-in page', async () => {
    // /settings signed out renders sign-in. Without navigation that is a dead
    // end: no way back to the page explaining what you are signing into.
    const r = await fetch(base + '/settings');
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).toContain('class="bar"');
    expect(body).toContain('href="/"');
  });

  it('is sent to sign in, and back where they were going', async () => {
    // Landing on /settings after signing in, when you asked for new-project,
    // means doing the navigation again.
    const r = await fetch(base + '/settings/new-project', { redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toContain('returnTo=/settings/new-project');
  });

  it('can get back out of an error page', async () => {
    const r = await fetch(base + '/oauth/google/callback');
    const body = await r.text();
    expect(body).toContain('class="bar"');
    expect(body).toMatch(/Nothing was changed/);
  });
});
