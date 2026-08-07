import { randomBytes } from 'crypto';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { kvGet, kvSet, kvTake, kvDelete, keys, TTL } from './kv.js';

/**
 * teamctx's OAuth 2.1 authorization server.
 *
 * We are the authorization server; GitHub is the upstream *identity
 * provider*. That split matters: GitHub cannot be the AS because it does not
 * implement RFC 8414 metadata, RFC 7591 registration, or RFC 9728 protected
 * resource metadata — all of which MCP clients require. But GitHub OAuth does
 * hand us a repo-scoped access token, which is exactly what the MCP tools
 * need in order to read and write the user's teamctx repo.
 *
 * So the flow is: Claude authenticates against us, we authenticate the user
 * against GitHub, and we keep GitHub's token in KV alongside the token we
 * mint for Claude.
 *
 * Implements the `OAuthServerProvider` interface from
 * @modelcontextprotocol/sdk/server/auth/provider.js
 */

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

/** Scopes we request from GitHub. `repo` covers private teamctx repos. */
export const GITHUB_SCOPES = 'repo read:user';

function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export class TeamctxOAuthProvider {
  /**
   * @param {object} opts
   * @param {string} opts.githubClientId
   * @param {string} opts.githubClientSecret
   * @param {string} opts.baseUrl  Public origin, e.g. https://teamctx.vercel.app
   */
  constructor({ githubClientId, githubClientSecret, baseUrl }) {
    this.githubClientId = githubClientId;
    this.githubClientSecret = githubClientSecret;
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
  }

  get githubCallbackUrl() {
    return `${this.baseUrl}/oauth/github/callback`;
  }

  // ---- Registered clients (RFC 7591 dynamic client registration) ----

  get clientsStore() {
    return {
      getClient: async (clientId) => (await kvGet(keys.client(clientId))) || undefined,
      registerClient: async (client) => {
        await kvSet(keys.client(client.client_id), client);
        return client;
      },
    };
  }

  // ---- Step 1: Claude sends the user to /authorize ----

  /**
   * We don't show our own consent screen. We stash everything Claude sent
   * (PKCE challenge, redirect target, state) under a one-shot key and bounce
   * the user to GitHub. The GitHub callback picks the state back up.
   */
  async authorize(client, params, res) {
    const state = newToken(24);

    await kvSet(keys.pending(state), {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state ?? null,
      scopes: params.scopes ?? [],
      resource: params.resource ? String(params.resource) : null,
    }, { ttlSeconds: TTL.pending });

    const url = new URL(GITHUB_AUTHORIZE);
    url.searchParams.set('client_id', this.githubClientId);
    url.searchParams.set('redirect_uri', this.githubCallbackUrl);
    url.searchParams.set('scope', GITHUB_SCOPES);
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  }

  // ---- Step 2: GitHub bounces the user back to us ----

  /**
   * Not part of the SDK interface — this is our upstream callback. Exchanges
   * GitHub's code for a GitHub access token, mints *our* authorization code,
   * and redirects back to whatever redirect_uri Claude asked for.
   *
   * @returns {Promise<string>} the URL to redirect the browser to
   */
  async handleGithubCallback({ code, state, error, errorDescription }) {
    const pending = await kvTake(keys.pending(state));
    if (!pending) {
      throw new OAuthCallbackError('invalid_state',
        'Authorization request expired or was already used. Start the connection again.');
    }

    const back = new URL(pending.redirectUri);
    if (pending.clientState) back.searchParams.set('state', pending.clientState);

    // The user declined at GitHub, or GitHub errored — propagate per OAuth 2.1.
    if (error) {
      back.searchParams.set('error', error);
      if (errorDescription) back.searchParams.set('error_description', errorDescription);
      return back.toString();
    }

    const githubToken = await this.#exchangeGithubCode(code);
    const githubUser = await this.#fetchGithubUser(githubToken);

    const ourCode = newToken(24);
    await kvSet(keys.code(ourCode), {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      resource: pending.resource,
      githubToken,
      githubUser,
    }, { ttlSeconds: TTL.code });

    back.searchParams.set('code', ourCode);
    return back.toString();
  }

  async #exchangeGithubCode(code) {
    const res = await fetch(GITHUB_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.githubClientId,
        client_secret: this.githubClientSecret,
        code,
        redirect_uri: this.githubCallbackUrl,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error || !body.access_token) {
      throw new OAuthCallbackError('github_exchange_failed',
        body.error_description || body.error || `GitHub returned ${res.status}`);
    }
    return body.access_token;
  }

  async #fetchGithubUser(githubToken) {
    const res = await fetch(GITHUB_USER, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new OAuthCallbackError('github_user_failed',
        `Could not read GitHub profile (${res.status})`);
    }
    const user = await res.json();
    return { id: String(user.id), login: user.login, name: user.name ?? null };
  }

  // ---- Step 3: Claude exchanges the code at /token ----

  /**
   * The SDK validates PKCE itself; it just needs the challenge we recorded
   * when the flow began.
   */
  async challengeForAuthorizationCode(_client, authorizationCode) {
    const record = await kvGet(keys.code(authorizationCode));
    if (!record) throw new InvalidGrantError('Authorization code not found or expired');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, _resource) {
    // One-shot: consuming the code here prevents replay.
    const record = await kvTake(keys.code(authorizationCode));
    if (!record) throw new InvalidGrantError('Authorization code not found or expired');
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    // RFC 6749 §4.1.3 / OAuth 2.1 §4.1.3: redirect_uri must match the one sent
    // to /authorize. PKCE already covers the practical attack; this is
    // defense-in-depth. Only enforced when the client sends the parameter,
    // which is what the spec requires of it.
    if (redirectUri !== undefined && redirectUri !== null && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    return this.#issueTokens({
      clientId: client.client_id,
      githubToken: record.githubToken,
      githubUser: record.githubUser,
      scopes: record.scopes,
    });
  }

  async exchangeRefreshToken(client, refreshToken, scopes, _resource) {
    // Rotate: the MCP spec requires refresh-token rotation for public clients,
    // and DCR registers Claude as a public client.
    const record = await kvTake(keys.refresh(refreshToken));
    if (!record) throw new InvalidGrantError('Refresh token not found or expired');
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }
    return this.#issueTokens({
      clientId: client.client_id,
      githubToken: record.githubToken,
      githubUser: record.githubUser,
      scopes: scopes?.length ? scopes : record.scopes,
    });
  }

  async #issueTokens({ clientId, githubToken, githubUser, scopes = [] }) {
    const accessToken = newToken();
    const refreshToken = newToken();
    const payload = { clientId, githubToken, githubUser, scopes };

    await kvSet(keys.token(accessToken), payload, { ttlSeconds: TTL.accessToken });
    await kvSet(keys.refresh(refreshToken), payload, { ttlSeconds: TTL.refreshToken });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TTL.accessToken,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  // ---- Step 4: every MCP request carries the access token ----

  /**
   * Returns the SDK's `AuthInfo`. We hang the GitHub token and profile off
   * `extra`, which is how the MCP route later reaches the user's repo.
   */
  async verifyAccessToken(token) {
    const record = await kvGet(keys.token(token));
    if (!record) throw new InvalidTokenError('Access token is invalid or has expired');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes ?? [],
      extra: {
        githubToken: record.githubToken,
        githubUser: record.githubUser,
      },
    };
  }

  async revokeToken(_client, request) {
    const t = request?.token;
    if (!t) return;
    await Promise.all([kvDelete(keys.token(t)), kvDelete(keys.refresh(t))]);
  }
}

export class OAuthCallbackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Build the provider from env, or return null when OAuth isn't configured. */
export function providerFromEnv(env = process.env) {
  const githubClientId = env.GITHUB_OAUTH_CLIENT_ID;
  const githubClientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  const baseUrl = env.TEAMCTX_BASE_URL
    || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
    || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null);

  if (!githubClientId || !githubClientSecret || !baseUrl) return null;
  return new TeamctxOAuthProvider({ githubClientId, githubClientSecret, baseUrl });
}

export function oauthConfigStatus(env = process.env) {
  return {
    githubClientId: !!env.GITHUB_OAUTH_CLIENT_ID,
    githubClientSecret: !!env.GITHUB_OAUTH_CLIENT_SECRET,
    baseUrl: !!(env.TEAMCTX_BASE_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL),
  };
}
