/**
 * Which code is answering.
 *
 * A tool result came back without the `viewUrl` field at all, and settling
 * whether that was a bug in the code or a build older than the code took three
 * rounds of reading source that was not necessarily the source running. Nothing
 * this deployment served could answer it.
 *
 * So /oauth/status now says. The commit comes from the environment; the feature
 * list is read off the loaded modules, so it reports what is running rather than
 * what somebody meant to deploy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

let server, base;
beforeAll(async () => {
  process.env.TEAMCTX_BASE_URL = 'https://x.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-client';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-secret';
  process.env.VERCEL_GIT_COMMIT_SHA = 'deadbeefcafe';
  process.env.VERCEL_GIT_COMMIT_REF = 'feat/context-view-links';
  const { app } = await import('./oauth-server.js');
  server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => {
  server?.close();
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.VERCEL_GIT_COMMIT_REF;
});

const status = async () => (await fetch(`${base}/oauth/status`)).json();

describe('what a deployment says about itself', () => {
  it('names the commit and branch it was built from', async () => {
    const { build } = await status();
    expect(build.commit).toBe('deadbeefcafe');
    expect(build.branch).toBe('feat/context-view-links');
  });

  it('needs no credentials, so it can be checked from anywhere', async () => {
    const res = await fetch(`${base}/oauth/status`);
    expect(res.status).toBe(200);
  });

  it('lists the tools that hand back a link, read off the running code', async () => {
    // Read from the tool definitions themselves rather than kept by hand, so it
    // cannot say yes about code that is not there.
    const { build } = await status();
    expect(build.features.viewLinks.sort()).toEqual([
      'contribute', 'get_status', 'get_workstream', 'my_brief',
      'task_add', 'task_assign', 'task_done',
    ]);
  });

  it('says whether the floor under those links is in place', async () => {
    const { build } = await status();
    expect(build.features.viewLinkFloor).toBe(true);
  });

  it('still answers the questions it answered before', async () => {
    const s = await status();
    expect(s.oauthConfigured).toBe(true);
    expect(s).toHaveProperty('kvConfigured');
    expect(s).toHaveProperty('missing');
  });
});
