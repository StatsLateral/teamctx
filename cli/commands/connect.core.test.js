import { describe, it, expect } from 'vitest';
import {
  connectorUrl, parseGithubRemote, NoDeployUrlError, NoGithubRemoteError,
} from './connect.core.js';

const HTTPS = 'https://github.com/acme/ledger.git';
const SSH = 'git@github.com:acme/ledger.git';
const DEPLOY = 'https://team-context-xyz.vercel.app';

describe('the connector URL a member pastes', () => {
  it('joins the deployment origin to the repository', () => {
    expect(connectorUrl({ deployUrl: DEPLOY, remote: HTTPS }).url)
      .toBe(`${DEPLOY}/api/mcp/acme/ledger`);
  });

  it('tolerates a trailing slash on the deploy URL', () => {
    // Pasted out of a browser as often as typed. Left in, it produces a double
    // slash that some proxies collapse and others 404 on.
    expect(connectorUrl({ deployUrl: `${DEPLOY}/`, remote: HTTPS }).url)
      .toBe(`${DEPLOY}/api/mcp/acme/ledger`);
  });

  it('reads an ssh remote as well as an https one', () => {
    // `gh repo clone` leaves ssh behind; the browser gives https.
    expect(connectorUrl({ deployUrl: DEPLOY, remote: SSH }).url)
      .toBe(`${DEPLOY}/api/mcp/acme/ledger`);
  });

  it('drops the .git suffix rather than putting it in the URL', () => {
    expect(connectorUrl({ deployUrl: DEPLOY, remote: HTTPS }).repo).toBe('ledger');
  });

  it('keeps a repository name containing dots intact', () => {
    // Only a trailing `.git` is a suffix; `docs.site` is the name itself.
    expect(parseGithubRemote('https://github.com/acme/docs.site.git').repo).toBe('docs.site');
  });

  it('says what to run when no deploy URL is recorded', () => {
    // The common case for a project that has only ever run locally, and the
    // reason it is a typed error: the CLI adds the one command that fixes it.
    expect(() => connectorUrl({ deployUrl: '', remote: HTTPS })).toThrow(NoDeployUrlError);
  });

  it('refuses a remote that is not GitHub', () => {
    expect(() => connectorUrl({ deployUrl: DEPLOY, remote: 'https://gitlab.com/acme/ledger.git' }))
      .toThrow(NoGithubRemoteError);
  });

  it('refuses when there is no remote at all', () => {
    expect(() => connectorUrl({ deployUrl: DEPLOY, remote: null })).toThrow(NoGithubRemoteError);
  });
});
