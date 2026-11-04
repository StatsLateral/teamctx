import { randomBytes, createHash } from 'crypto';
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { kvGet, kvSet, kvTake, kvDelete, keys, TTL } from './kv.js';
import { googleUserFromCode, googleAuthorizeUrl } from './google.js';
import { primaryEmail } from './github-identity.js';
import { linkGithubIdentity } from './ai-keys.js';

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
// `user:email` so a GitHub session can be recognised by the same email a clone
// and a Google sign-in use. Without it one person is two identities.
export const GITHUB_SCOPES = 'repo read:user user:email';

function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * The key under which a bearer or refresh token is stored: the SHA-256 of the
 * token, never the token itself. Tokens are 32 random bytes, so a fast hash is
 * enough — there is nothing to brute-force. A read of the store yields only
 * hashes, so it hands nobody a working credential.
 */
const sha256hex = token => createHash('sha256').update(String(token)).digest('hex');

/** The storage key for a token, exported so callers and tests can reach a record without the raw token. */
export const tokenHash = sha256hex;

/**
 * The browser-binding cookie. An authorization flow sets a random nonce here
 * when it starts and stores only its hash; the callback finishing the flow must
 * present the same nonce. It ties the browser that finishes a sign-in to the
 * one that began it, so a code cannot be issued to a browser handed a crafted
 * callback link. Scoped to `/oauth`, short-lived, and never readable by script.
 */
export const BIND_COOKIE = 'teamctx_bind';

// One bind cookie per browser, under a single name. A browser running two
// sign-in flows at once (say a connector authorize and a settings sign-in)
// overwrites the first flow's nonce with the second's, so the first then fails
// its bind check and the person restarts it — a safe failure, never a bypass.
// Concurrent in-browser flows are rare in practice; if they become common, the
// cookie name should be namespaced per flow (e.g. by `state`) so both coexist.
export function setBindCookie(res, nonce) {
  res.setHeader('Set-Cookie',
    `${BIND_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=600`);
}

export function readBindCookie(req) {
  const m = String(req?.headers?.cookie || '').match(/(?:^|;\s*)teamctx_bind=([^;]+)/);
  return m ? m[1] : null;
}

/** True when the nonce from the cookie matches the hash stored on the pending record. */
export function bindMatches(pending, bind) {
  if (!pending?.bindHash) return true;   // nothing to check (older record)
  return !!bind && sha256hex(bind) === pending.bindHash;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// http is allowed only to a loopback address, for desktop and CLI clients.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Schemes that could run or read in the browser if a redirect ever reached one.
const DANGEROUS_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;

/** The hosts a redirect may point at, from env, or null when unrestricted (the default). */
function allowedRedirectHosts(env = process.env) {
  const raw = env.TEAMCTX_ALLOWED_REDIRECT_HOSTS;
  if (!raw) return null;
  const set = new Set(raw.split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
}

/**
 * A redirect URI must belong to a real client: https; http only to loopback; or
 * a private-use (custom) URI scheme, which is how native editors receive the
 * redirect (VS Code `vscode://`, Cursor `cursor://`) — RFC 8252 section 7.1. A
 * custom scheme routes to a locally registered app, and PKCE plus the consent
 * page guard it, so the host allow-list does not apply to it. No fragment or
 * userinfo, and never a scheme that could execute or read in a browser.
 */
function assertRedirectUri(uri, allowHosts) {
  let url;
  try { url = new URL(uri); }
  catch { throw new InvalidClientMetadataError(`redirect_uri is not a valid URL: ${uri}`); }
  if (url.hash) throw new InvalidClientMetadataError('redirect_uri must not contain a fragment');
  if (url.username || url.password) throw new InvalidClientMetadataError('redirect_uri must not contain userinfo');
  if (DANGEROUS_SCHEMES.has(url.protocol)) {
    throw new InvalidClientMetadataError(`redirect_uri scheme is not allowed: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol === 'http:' && !loopback) {
    throw new InvalidClientMetadataError(`redirect_uri over http must point to a loopback address: ${uri}`);
  }
  // A custom scheme (neither http nor https) is a native client's private-use
  // redirect: accept it without a host check.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (allowHosts && !loopback && !allowHosts.has(host)) {
    throw new InvalidClientMetadataError(`redirect_uri host is not allowed: ${host}`);
  }
}

/**
 * Check a dynamic client registration and return a cleaned copy. Keeps the
 * loopback and desktop clients that MCP relies on working, while refusing a
 * redirect URI that cannot belong to a real client, capping how many a client
 * may claim, and bounding and stripping the name that is later shown on the
 * consent page.
 */
export function validateClientRegistration(client, env = process.env) {
  const uris = client?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new InvalidClientMetadataError('redirect_uris is required');
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    throw new InvalidClientMetadataError(`too many redirect_uris (max ${MAX_REDIRECT_URIS})`);
  }
  const allowHosts = allowedRedirectHosts(env);
  for (const uri of uris) assertRedirectUri(String(uri), allowHosts);

  const out = { ...client };
  if (client.client_name != null) {
    out.client_name = String(client.client_name).replace(CONTROL_CHARS, '').slice(0, MAX_CLIENT_NAME);
  }
  return out;
}

export class TeamctxOAuthProvider {
  /**
   * @param {object} opts
   * @param {string} opts.githubClientId
   * @param {string} opts.githubClientSecret
   * @param {string} opts.baseUrl  Public origin, e.g. https://teamctx.vercel.app
   */
  constructor({ githubClientId, githubClientSecret, googleClientId, googleClientSecret, baseUrl }) {
    this.githubClientId = githubClientId;
    this.githubClientSecret = githubClientSecret;
    // Optional. Without it teamctx works exactly as before, for GitHub accounts
    // only — which is what every existing deployment already expects.
    this.googleClientId = googleClientId || null;
    this.googleClientSecret = googleClientSecret || null;
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
  }

  get githubCallbackUrl() {
    return `${this.baseUrl}/oauth/github/callback`;
  }

  get googleCallbackUrl() {
    return `${this.baseUrl}/oauth/google/callback`;
  }

  // ---- Registered clients (RFC 7591 dynamic client registration) ----

  get clientsStore() {
    return {
      getClient: async (clientId) => {
        const client = await kvGet(keys.client(clientId));
        if (!client) return undefined;
        // 30 days from last use: seeing the client again refreshes its TTL, so an
        // active client never expires but an abandoned registration lapses.
        await kvSet(keys.client(clientId), client, { ttlSeconds: TTL.client });
        return client;
      },
      registerClient: async (client) => {
        const checked = validateClientRegistration(client);
        await kvSet(keys.client(checked.client_id), checked, { ttlSeconds: TTL.client });
        return checked;
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
    // Browser binding: a random nonce goes to the browser as a cookie and only
    // its hash is stored. The callback must present the nonce back.
    const bind = newToken(24);

    await kvSet(keys.pending(state), {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state ?? null,
      scopes: params.scopes ?? [],
      resource: params.resource ? String(params.resource) : null,
      bindHash: sha256hex(bind),
    }, { ttlSeconds: TTL.pending });
    setBindCookie(res, bind);

    // Straight to GitHub when Google is not configured, so a deployment that
    // never set it up behaves exactly as it did before.
    if (!this.googleClientId) return res.redirect(this.githubAuthorizeUrl(state));
    res.redirect(`${this.baseUrl}/oauth/choose?state=${encodeURIComponent(state)}`);
  }

  githubAuthorizeUrl(state) {
    const url = new URL(GITHUB_AUTHORIZE);
    url.searchParams.set('client_id', this.githubClientId);
    url.searchParams.set('redirect_uri', this.githubCallbackUrl);
    url.searchParams.set('scope', GITHUB_SCOPES);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /**
   * The same handshake as GitHub's, with the identity coming from Google.
   *
   * No GitHub token exists at the end of this, which is deliberate: the member
   * has no GitHub account. Repository access comes from the credential the
   * project lends, and only after the roster confirms the address.
   */
  async handleGoogleCallback({ code, state, error, errorDescription, bind }) {
    const pending = await kvTake(keys.pending(state));
    if (!pending) {
      throw new OAuthCallbackError('invalid_state',
        'Authorization request expired or was already used. Start the connection again.');
    }
    const back = new URL(pending.redirectUri);
    if (pending.clientState) back.searchParams.set('state', pending.clientState);

    if (error) {
      back.searchParams.set('error', error);
      if (errorDescription) back.searchParams.set('error_description', errorDescription);
      return back.toString();
    }

    // Only the browser that started the flow may finish it.
    if (!bindMatches(pending, bind)) {
      throw new OAuthCallbackError('browser_mismatch',
        'This sign-in was started in another browser. Start the connection again from your assistant.');
    }

    const googleUser = await googleUserFromCode({
      code,
      clientId: this.googleClientId,
      clientSecret: this.googleClientSecret,
      redirectUri: this.googleCallbackUrl,
    });

    const codeRecord = {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      resource: pending.resource,
      googleUser,
    };
    return this.#finishIdentity({
      pending, codeRecord,
      subject: `google:${String(googleUser.email).toLowerCase()}`,
      label: googleUser.email,
    });
  }

  /**
   * The step every sign-in ends on, once the person is known: mint the code
   * straight away if they have approved this client and redirect origin before,
   * otherwise stash everything and send the browser to the consent page. The
   * identity is unknown at /authorize, which is why consent comes here and not
   * there.
   */
  async #finishIdentity({ pending, codeRecord, subject, label }) {
    const redirectOrigin = new URL(pending.redirectUri).origin;
    const back = new URL(pending.redirectUri);
    if (pending.clientState) back.searchParams.set('state', pending.clientState);

    const approved = await kvGet(keys.consentApproval(sha256hex(subject), pending.clientId, redirectOrigin));
    if (approved) {
      const ourCode = newToken(24);
      await kvSet(keys.code(ourCode), codeRecord, { ttlSeconds: TTL.code });
      back.searchParams.set('code', ourCode);
      return back.toString();
    }

    const cToken = newToken(24);
    await kvSet(keys.consentPending(cToken), {
      codeRecord,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      clientState: pending.clientState ?? null,
      redirectOrigin,
      subject,
      identity: label || subject,
      // Carried so Approve can be required to come from the same browser.
      bindHash: pending.bindHash ?? null,
    }, { ttlSeconds: TTL.pending });
    return `${this.baseUrl}/oauth/consent?c=${encodeURIComponent(cToken)}`;
  }

  /** The stashed consent request, for rendering the page. */
  async getConsent(cToken) {
    return kvGet(keys.consentPending(cToken));
  }

  /** Approve: remember it, mint the code, and return the client redirect. Requires the same browser. */
  async approveConsent(cToken, bind) {
    const rec = await kvTake(keys.consentPending(cToken));
    if (!rec) throw new OAuthCallbackError('invalid_state', 'This approval expired. Start the connection again.');
    if (rec.bindHash && (!bind || sha256hex(bind) !== rec.bindHash)) {
      throw new OAuthCallbackError('browser_mismatch', 'Approve in the browser you started the connection in.');
    }
    await kvSet(keys.consentApproval(sha256hex(rec.subject), rec.clientId, rec.redirectOrigin),
      { at: new Date().toISOString() }, { ttlSeconds: TTL.consentApproval });
    const ourCode = newToken(24);
    await kvSet(keys.code(ourCode), rec.codeRecord, { ttlSeconds: TTL.code });
    const back = new URL(rec.redirectUri);
    if (rec.clientState) back.searchParams.set('state', rec.clientState);
    back.searchParams.set('code', ourCode);
    return back.toString();
  }

  /** Cancel: return the client redirect with `access_denied`, per OAuth 2.1. No code is minted. */
  async denyConsent(cToken) {
    const rec = await kvTake(keys.consentPending(cToken));
    if (!rec) throw new OAuthCallbackError('invalid_state', 'This approval expired. Start the connection again.');
    const back = new URL(rec.redirectUri);
    if (rec.clientState) back.searchParams.set('state', rec.clientState);
    back.searchParams.set('error', 'access_denied');
    return back.toString();
  }

  // ---- Step 2: GitHub bounces the user back to us ----

  /**
   * Not part of the SDK interface — this is our upstream callback. Exchanges
   * GitHub's code for a GitHub access token, mints *our* authorization code,
   * and redirects back to whatever redirect_uri Claude asked for.
   *
   * @returns {Promise<string>} the URL to redirect the browser to
   */
  async handleGithubCallback({ code, state, error, errorDescription, bind }) {
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

    // Only the browser that started the flow may finish it.
    if (!bindMatches(pending, bind)) {
      throw new OAuthCallbackError('browser_mismatch',
        'This sign-in was started in another browser. Start the connection again from your assistant.');
    }

    const githubToken = await this.#exchangeGithubCode(code);
    const githubUser = await this.#fetchGithubUser(githubToken);
    // A manager may set a project up entirely through their assistant and never
    // open the web app, so the connector has to record this too — otherwise the
    // only account that can be matched to their address is one they never used.
    try {
      await linkGithubIdentity({ email: githubUser.email, githubId: githubUser.id });
    } catch { /* best effort — never block a sign-in on it */ }

    const codeRecord = {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      resource: pending.resource,
      githubToken,
      githubUser,
      // When GitHub signed this person in, so that if GitHub later stops accepting
      // the token there is an age to look at rather than a guess.
      githubSignedInAt: new Date().toISOString(),
    };
    return this.#finishIdentity({
      pending, codeRecord,
      subject: `github:${githubUser.id}`,
      label: githubUser.login || githubUser.email || `github:${githubUser.id}`,
    });
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
    return {
      id: String(user.id), login: user.login, name: user.name ?? null,
      // Both of these are addresses GitHub has confirmed belong to this account,
      // which is what the rest of the system is entitled to assume: this address
      // is written into `teamctx:ghids:*`, and a later Google sign-in on it then
      // matches a `github:<id>` gate. `/user` returns the public profile address,
      // and GitHub only offers a verified one for that; `primaryEmail` filters on
      // `verified` itself. An unconfirmed address must never arrive here — it
      // would let somebody claim a gate pinned to an email they do not own.
      email: user.email ? String(user.email).toLowerCase() : await primaryEmail(githubToken),
    };
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
      googleUser: record.googleUser,
      githubSignedInAt: record.githubSignedInAt,
      scopes: record.scopes,
      // The project the code was issued for, so the token works only there.
      resource: record.resource || null,
    });
  }

  async exchangeRefreshToken(client, refreshToken, scopes, _resource) {
    // Rotate: the MCP spec requires refresh-token rotation for public clients,
    // and DCR registers Claude as a public client.
    const presentedHash = sha256hex(refreshToken);
    const record = await kvTake(keys.refreshV2(presentedHash));
    if (!record) {
      // Not a current refresh token. If it is one we already rotated away, this
      // is a replay of a used token — treat the sign-in as compromised and
      // revoke the whole family (RFC 9700 refresh-token rotation). Otherwise the
      // token is simply unknown or expired.
      const used = await kvGet(keys.usedRefresh(presentedHash));
      if (used?.family) await this.#revokeFamily(used.family);
      throw new InvalidGrantError('Refresh token not found or expired');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }
    // A refresh may not move a token to another project: the resource, when the
    // client sends one, must match what the token was issued for.
    const asked = _resource ? String(_resource) : null;
    if (asked && record.resource && asked !== record.resource) {
      throw new InvalidGrantError('Refresh token is bound to a different project');
    }
    // The GitHub token is carried through every refresh, so a dead one used to be
    // carried for the whole lifetime, and the connector stayed broken with
    // nothing to tell the client to start over. Refusing here is what does that:
    // the client's refresh fails and it signs in again. Only a clear "no" counts;
    // GitHub being slow or down must not sign everyone out.
    if (record.githubToken && await this.#githubRejects(record.githubToken)) {
      throw new InvalidGrantError('GitHub no longer accepts the sign-in behind this connection. Sign in again.');
    }
    // Tombstone the token we just consumed, so a later replay of it is caught
    // above and revokes the family. TTL matches the refresh token it replaces.
    await kvSet(keys.usedRefresh(presentedHash), { family: record.family },
      { ttlSeconds: TTL.refreshToken });
    return this.#issueTokens({
      clientId: client.client_id,
      githubToken: record.githubToken,
      githubUser: record.githubUser,
      googleUser: record.googleUser,
      githubSignedInAt: record.githubSignedInAt,
      scopes: scopes?.length ? scopes : record.scopes,
      resource: record.resource || null,
      // Stay in the same family, so a later replay reaches this new pair.
      family: record.family,
    });
  }

  /** True only when GitHub answers 401 for the token; an error or a network failure is not an answer. */
  async #githubRejects(githubToken) {
    try {
      const res = await fetch(GITHUB_USER, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      return res.status === 401;
    } catch {
      return false;
    }
  }

  async #issueTokens({ clientId, githubToken, githubUser, googleUser, githubSignedInAt, scopes = [], resource = null, family = null }) {
    const accessToken = newToken();
    const refreshToken = newToken();
    const accessHash = sha256hex(accessToken);
    const refreshHash = sha256hex(refreshToken);
    // One id per sign-in, kept across every rotation, so a replay of any token
    // in it can revoke the whole family.
    const familyId = family || newToken(16);
    // A family revoked while this rotation was in flight must stay revoked: do
    // not issue a fresh pair into it, and never write `revoked: false` over it.
    if (family) {
      const existing = await kvGet(keys.tokenFamily(familyId));
      if (existing?.revoked) throw new InvalidGrantError('This sign-in has been revoked. Sign in again.');
    }
    // Exactly one of githubUser / googleUser is set. A Google session carries no
    // GitHub token at all — that is the point of it, and what makes the
    // project's own credential necessary downstream.
    const payload = {
      clientId, githubToken, githubUser, googleUser, scopes,
      resource: resource || null,
      family: familyId,
      ...(githubToken ? { githubSignedInAt: githubSignedInAt || new Date().toISOString() } : {}),
    };

    await kvSet(keys.tokenV2(accessHash), payload, { ttlSeconds: TTL.accessToken });
    await kvSet(keys.refreshV2(refreshHash), payload, { ttlSeconds: TTL.refreshToken });
    // The family points at the current pair, so a revoke or a detected replay
    // can reach both. TTL tracks the refresh token, the longer-lived of the two.
    await kvSet(keys.tokenFamily(familyId), { access: accessHash, refresh: refreshHash, revoked: false },
      { ttlSeconds: TTL.refreshToken });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TTL.accessToken,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  /** Revoke a whole sign-in: delete its current access and refresh records and mark it revoked. */
  async #revokeFamily(familyId) {
    const fam = await kvGet(keys.tokenFamily(familyId));
    if (!fam) return;
    await Promise.all([
      fam.access ? kvDelete(keys.tokenV2(fam.access)) : Promise.resolve(),
      fam.refresh ? kvDelete(keys.refreshV2(fam.refresh)) : Promise.resolve(),
      kvSet(keys.tokenFamily(familyId), { ...fam, revoked: true }, { ttlSeconds: TTL.refreshToken }),
    ]);
  }

  // ---- Step 4: every MCP request carries the access token ----

  /**
   * Returns the SDK's `AuthInfo`. We hang the GitHub token and profile off
   * `extra`, which is how the MCP route later reaches the user's repo.
   */
  async verifyAccessToken(token) {
    const record = await kvGet(keys.tokenV2(sha256hex(token)));
    if (!record) throw new InvalidTokenError('Access token is invalid or has expired');
    // A replay of any token in this sign-in revokes the whole family, but an
    // access token minted before that rotation keeps its own record until its
    // hour is up. Reject it here too, so a detected replay kills every access
    // token in the family, not only the current pair.
    if (record.family) {
      const fam = await kvGet(keys.tokenFamily(record.family));
      if (fam?.revoked) throw new InvalidTokenError('Access token is invalid or has expired');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes ?? [],
      // The project this token was issued for, or null for a client that sent no
      // `resource`. The MCP route enforces it against the owner/repo in the URL.
      resource: record.resource ?? null,
      extra: {
        githubToken: record.githubToken,
        githubUser: record.githubUser,
        googleUser: record.googleUser,
        githubSignedInAt: record.githubSignedInAt ?? null,
        resource: record.resource ?? null,
        family: record.family ?? null,
      },
    };
  }

  /**
   * A token works only on the project it was issued for. The MCP route calls
   * this with the canonical URL of the requested project.
   *
   * Returns `{ ok: true }` when the token is bound to this project (binding a
   * no-`resource` token to the first project it is used on, per the spec), or
   * `{ ok: false, boundTo }` when it was issued for another one.
   */
  async enforceResource(token, canonical) {
    const hash = sha256hex(token);
    const record = await kvGet(keys.tokenV2(hash));
    if (!record) return { ok: false, boundTo: null };
    const norm = u => String(u || '').toLowerCase().replace(/\/+$/, '');
    if (record.resource) {
      return norm(record.resource) === norm(canonical)
        ? { ok: true }
        : { ok: false, boundTo: record.resource };
    }
    // No resource on the token (the client sent none): bind it on first use,
    // and persist the binding on the whole sign-in — the family record and its
    // refresh token — so it survives rotation instead of re-binding on the next
    // refresh (the refresh record used to stay null and rebind every time). The
    // family record is the authority: if a concurrent first use already bound
    // it, that binding wins and this request is enforced against it.
    const familyKey = record.family ? keys.tokenFamily(record.family) : null;
    const fam = familyKey ? await kvGet(familyKey) : null;
    if (fam?.resource) {
      if (norm(fam.resource) !== norm(canonical)) return { ok: false, boundTo: fam.resource };
      record.resource = fam.resource;
      await kvSet(keys.tokenV2(hash), record, { ttlSeconds: TTL.accessToken });
      return { ok: true };
    }
    record.resource = canonical;
    if (familyKey && fam) {
      await kvSet(familyKey, { ...fam, resource: canonical }, { ttlSeconds: TTL.refreshToken });
      if (fam.refresh) {
        const refRec = await kvGet(keys.refreshV2(fam.refresh));
        if (refRec) {
          refRec.resource = canonical;
          await kvSet(keys.refreshV2(fam.refresh), refRec, { ttlSeconds: TTL.refreshToken });
        }
      }
    }
    await kvSet(keys.tokenV2(hash), record, { ttlSeconds: TTL.accessToken });
    return { ok: true };
  }

  async revokeToken(_client, request) {
    const t = request?.token;
    if (!t) return;
    const hash = sha256hex(t);
    // The token may be an access or a refresh token. Find its family from
    // whichever record exists and revoke the whole sign-in, then drop the token
    // presented in case it is not the family's current one.
    const rec = (await kvGet(keys.tokenV2(hash))) || (await kvGet(keys.refreshV2(hash)));
    if (rec?.family) await this.#revokeFamily(rec.family);
    await Promise.all([kvDelete(keys.tokenV2(hash)), kvDelete(keys.refreshV2(hash))]);
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
  return new TeamctxOAuthProvider({
    githubClientId, githubClientSecret, baseUrl,
    // Optional: without it the sign-in chooser never appears and the flow is
    // GitHub-only, exactly as before.
    googleClientId: env.GOOGLE_OAUTH_CLIENT_ID || null,
    googleClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || null,
  });
}

export function oauthConfigStatus(env = process.env) {
  return {
    githubClientId: !!env.GITHUB_OAUTH_CLIENT_ID,
    githubClientSecret: !!env.GITHUB_OAUTH_CLIENT_SECRET,
    baseUrl: !!(env.TEAMCTX_BASE_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL),
    // Reported because its absence is silent: without it `/authorize` skips the
    // sign-in chooser and goes straight to GitHub, which looks like the chooser
    // is broken rather than switched off.
    googleClientId: !!env.GOOGLE_OAUTH_CLIENT_ID,
    googleClientSecret: !!env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
}
