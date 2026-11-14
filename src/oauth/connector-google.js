/**
 * Google as a *connected account*, not as sign-in.
 *
 * google.js borrows only the identity and keeps no token. This is the other
 * thing: an OAuth grant teamctx holds on to, so it can read a linked Drive
 * file's metadata server-side for a staleness check (#248) — the member's own
 * connection, or the project's primary manager's as a fallback (see
 * connectors.js).
 *
 * It reuses the **same Google OAuth client** as sign-in
 * (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`); only the scope, the redirect URI and what
 * happens to the token differ. Google allows one client several redirect URIs
 * and scopes, so the two flows do not collide. Unlike sign-in it asks for
 * offline access, so Google returns a refresh token we can renew with.
 */

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Read-only file *metadata* — enough to read `modifiedTime` for a staleness
 * check, and nothing more. (Reading a file's content, for hosted import later,
 * would need `drive.readonly`.) `email` rides along so we can label the stored
 * connection with the account that granted it.
 */
export const GDRIVE_CONNECT_SCOPES = 'https://www.googleapis.com/auth/drive.metadata.readonly openid email';

export class ConnectorAuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CONNECTOR_AUTH_FAILED';
  }
}

const expiryFrom = expiresIn =>
  (Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000).toISOString() : null);

/** Where to send the browser to grant Drive access. */
export function connectAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GDRIVE_CONNECT_SCOPES);
  url.searchParams.set('state', state);
  // Ask for a refresh token, and force the consent that returns one even on a
  // reconnect — Google omits the refresh token on a silent re-grant otherwise,
  // leaving a connection that cannot be renewed when its access token expires.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * Exchange the callback code for the tokens we store: an access token, a refresh
 * token to renew it with, when it expires, and the account that granted it.
 */
export async function exchangeConnectCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) {
    throw new ConnectorAuthError(body.error_description || 'Google would not exchange the connect code.');
  }
  let account = null;
  try {
    const u = await fetchImpl(USERINFO, { headers: { Authorization: `Bearer ${body.access_token}` } });
    if (u.ok) account = (await u.json()).email || null;   // best-effort label
  } catch { /* the account label is a nicety, not a reason to fail the connect */ }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: expiryFrom(body.expires_in),
    account,
  };
}

/**
 * Shape a stored connection into the credential the Drive connector
 * (`src/connectors/gdrive.js`) expects, so a server-side staleness check (#248)
 * can read a linked file's `modifiedTime` with it.
 *
 * The refresh token was granted to the hosted sign-in client, so its client id
 * and secret — not the CLI's `GDRIVE_*` — are what renews the access token.
 * When there is a refresh token we hand the connector an already-expired access
 * token, so it renews once up front rather than risk a read on a token that
 * lapsed in the hour since it was stored. Returns `{ ok: false }` when there is
 * nothing usable, which the check reads as "could not be read" rather than a
 * wrong answer.
 */
export function driveCredsFromConnection(conn, env = process.env) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '';
  const accessToken = conn?.accessToken || '';
  const refreshToken = conn?.refreshToken || '';
  if (!accessToken && !(clientId && clientSecret && refreshToken)) return { ok: false };
  return {
    ok: true,
    accessToken,
    clientId,
    clientSecret,
    refreshToken,
    // A refresh token means renew-on-use (0 = already due). A pasted access
    // token with no way to renew is treated as valid until Google says otherwise.
    expiresAt: refreshToken ? 0 : (accessToken ? Infinity : 0),
  };
}

/** Renew an access token from the stored refresh token. */
export async function refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl = fetch } = {}) {
  if (!refreshToken) throw new ConnectorAuthError('no refresh token to renew access with');
  const res = await fetchImpl(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) {
    throw new ConnectorAuthError(body.error_description || 'Google would not renew the access token.');
  }
  return { accessToken: body.access_token, expiresAt: expiryFrom(body.expires_in) };
}
