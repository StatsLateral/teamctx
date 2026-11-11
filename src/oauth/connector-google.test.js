import { describe, it, expect } from 'vitest';
import {
  connectAuthorizeUrl, exchangeConnectCode, refreshAccessToken,
  ConnectorAuthError, GDRIVE_CONNECT_SCOPES,
} from './connector-google.js';

/** A fetch stub that answers the token and userinfo endpoints from a script. */
function stub(handlers) {
  return async (url, opts) => {
    const u = String(url);
    const h = Object.entries(handlers).find(([k]) => u.includes(k));
    if (!h) throw new Error(`unexpected fetch: ${u}`);
    const r = await h[1](opts);
    return { ok: r.ok !== false, json: async () => r.body ?? {} };
  };
}

describe('connectAuthorizeUrl', () => {
  it('asks for the metadata scope, offline access and a forced consent', () => {
    const url = new URL(connectAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://t/cb', state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://t/cb');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toBe(GDRIVE_CONNECT_SCOPES);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('requests only read-only metadata, never write or full read', () => {
    expect(GDRIVE_CONNECT_SCOPES).toContain('drive.metadata.readonly');
    expect(GDRIVE_CONNECT_SCOPES).not.toContain('drive.file');
    expect(GDRIVE_CONNECT_SCOPES).not.toMatch(/auth\/drive(\s|$)/); // not full-drive
  });
});

describe('exchangeConnectCode', () => {
  it('returns the tokens, expiry and the granting account', async () => {
    const fetchImpl = stub({
      'oauth2.googleapis.com/token': () => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }),
      'userinfo': () => ({ body: { email: 'priya@acme.com' } }),
    });
    const r = await exchangeConnectCode({ code: 'c', clientId: 'id', clientSecret: 's', redirectUri: 'https://t/cb', fetchImpl });
    expect(r).toMatchObject({ accessToken: 'at', refreshToken: 'rt', account: 'priya@acme.com' });
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('still connects when the account label cannot be read', async () => {
    const fetchImpl = stub({
      'oauth2.googleapis.com/token': () => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }),
      'userinfo': () => ({ ok: false, body: {} }),
    });
    const r = await exchangeConnectCode({ code: 'c', clientId: 'id', clientSecret: 's', redirectUri: 'x', fetchImpl });
    expect(r).toMatchObject({ accessToken: 'at', account: null });
  });

  it('throws when Google refuses the code', async () => {
    const fetchImpl = stub({ 'oauth2.googleapis.com/token': () => ({ body: { error_description: 'bad code' } }) });
    await expect(exchangeConnectCode({ code: 'c', clientId: 'id', clientSecret: 's', redirectUri: 'x', fetchImpl }))
      .rejects.toThrow(ConnectorAuthError);
  });
});

describe('refreshAccessToken', () => {
  it('renews from the refresh token', async () => {
    const fetchImpl = stub({ 'oauth2.googleapis.com/token': () => ({ body: { access_token: 'at2', expires_in: 3600 } }) });
    const r = await refreshAccessToken({ refreshToken: 'rt', clientId: 'id', clientSecret: 's', fetchImpl });
    expect(r.accessToken).toBe('at2');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses without a refresh token', async () => {
    await expect(refreshAccessToken({ clientId: 'id', clientSecret: 's' })).rejects.toThrow(/refresh token/);
  });

  it('throws when Google refuses the refresh', async () => {
    const fetchImpl = stub({ 'oauth2.googleapis.com/token': () => ({ body: { error: 'invalid_grant' } }) });
    await expect(refreshAccessToken({ refreshToken: 'rt', clientId: 'id', clientSecret: 's', fetchImpl }))
      .rejects.toThrow(ConnectorAuthError);
  });
});
