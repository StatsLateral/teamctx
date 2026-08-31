/**
 * Google as an identity provider.
 *
 * teamctx does not verify email addresses. Doing it properly means running a
 * mail sender, handling deliverability, and building a code-entry flow — a lot
 * of machinery to establish something Google has already established. Google
 * returns `email` together with `email_verified`, so this borrows that answer
 * rather than reproducing it.
 *
 * Only the identity is taken. No Google scope beyond the profile is requested,
 * nothing is read from the account, and no Google token is kept past the
 * exchange — the address is the entire point of the round trip.
 */

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

/** `openid email` and nothing else — enough to learn who they are. */
export const GOOGLE_SCOPES = 'openid email profile';

export function googleAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES);
  url.searchParams.set('state', state);
  // Without this, someone signed in to several Google accounts is silently
  // authenticated as whichever one the browser happens to prefer — which for an
  // invite matched on address is the difference between joining and being told
  // they were not invited.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export class GoogleAuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'GOOGLE_AUTH_FAILED';
  }
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.access_token) {
    throw new GoogleAuthError(body.error_description || 'Google would not exchange the sign-in code.');
  }
  return body.access_token;
}

/**
 * Who signed in, if Google is willing to vouch for the address.
 *
 * An unverified address is refused rather than returned. A Google account can
 * be created against an address the holder does not control, so treating
 * `email_verified: false` as good enough would let anyone claim someone else's
 * invite — which is the one thing this whole flow exists to prevent.
 */
export async function googleUserFromCode({ code, clientId, clientSecret, redirectUri }) {
  const accessToken = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GoogleAuthError('Could not read your Google profile.');
  const profile = await res.json();

  if (!profile.email) throw new GoogleAuthError('That Google account has no email address.');
  if (profile.email_verified === false) {
    throw new GoogleAuthError(
      `Google has not verified ${profile.email}. Confirm the address with Google, then sign in again.`);
  }
  return {
    email: String(profile.email).toLowerCase(),
    name: profile.name || String(profile.email).split('@')[0],
    sub: profile.sub ? String(profile.sub) : null,
  };
}

export function googleConfigured(env = process.env) {
  return !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}
