// Part of the extension background — see bg-core.js for how these files load.
// Google OAuth + PKCE, shared by Search Console, Analytics, Ads and Drive.

// ─── Google OAuth: PKCE flow shared by Search Console + Analytics ────────────
// Both products use the same Google Cloud OAuth client (stored gscClientId /
// gscClientSecret) but hold independent grants under their own storage key.

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

function googleBase64UrlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Distinct from popup-shared.js's IS_CHROMIUM: this script runs standalone
// (as the service worker on Chrome, an event page on Firefox) and never loads
// the popup scripts, so the same URL-scheme check is recomputed here rather
// than shared.
const IS_CHROMIUM_BG = browser.runtime.getURL('').startsWith('chrome-extension://');

function getGoogleRedirectUri() {
  const redirectBase = browser.identity.getRedirectURL();
  // Chrome's own documented pattern for launchWebAuthFlow: register
  // https://<extension-id>.chromiumapp.org/ (exactly what getRedirectURL
  // already returns) as the client's Authorized redirect URI.
  if (IS_CHROMIUM_BG) return redirectBase;
  // Firefox: getRedirectURL returns https://<uuid>.extensions.allizom.org/,
  // but launchWebAuthFlow also intercepts this loopback form built from the
  // same uuid — and it's what's actually registered in Google Cloud Console
  // for the existing Desktop app client, so it has to stay exactly as-is.
  const subdomain = new URL(redirectBase).hostname.split('.')[0];
  return `http://127.0.0.1/mozoauth2/${subdomain}`;
}

// Pull the account email out of an OpenID Connect id_token (a JWT). The middle
// segment is a base64url-encoded JSON payload; we only read the "email" claim.
function googleEmailFromIdToken(idToken) {
  try {
    let payload = String(idToken || '').split('.')[1];
    if (!payload) return null;
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';   // atob needs padding
    const claims = JSON.parse(atob(payload));
    return claims.email || null;
  } catch { return null; }
}

// Backfill the account email for a grant that doesn't have one stored yet, by
// asking Google's OpenID userinfo endpoint. Only works if the grant actually
// includes the email scope (grants made before we requested it must reconnect).
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

async function googleEnsureEmail(authKey) {
  const stored = await browser.storage.local.get(authKey);
  const auth = stored[authKey];
  if (!auth) return null;
  if (auth.email) return auth.email;

  const tok = await googleGetAccessToken(authKey);
  if (tok.error || !tok.accessToken) return null;
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tok.accessToken}` } });
    if (!res.ok) return null;
    const info = await res.json();
    if (info && info.email) {
      await browser.storage.local.set({ [authKey]: { ...auth, email: info.email } });
      return info.email;
    }
  } catch { /* offline or scope missing — reconnect will capture it */ }
  return null;
}

async function googleOAuthConnect(scope, authKey) {
  const { gscClientId, gscClientSecret } = await browser.storage.local.get(['gscClientId', 'gscClientSecret']);
  if (!gscClientId) return { error: 'NO_CLIENT_ID' };

  const redirectUri = getGoogleRedirectUri();

  // Request the OpenID email claim alongside the API scope so we can show which
  // account each integration is connected to. Deduped in case a caller already
  // includes them.
  const fullScope = Array.from(new Set((scope + ' openid email').split(/\s+/).filter(Boolean))).join(' ');

  const codeVerifier = googleBase64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
  const codeChallenge = googleBase64UrlEncode(challengeBytes);
  const state = googleBase64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', gscClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', fullScope);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  let responseUrl;
  try {
    responseUrl = await browser.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  } catch {
    return { error: 'FLOW_CANCELLED' };
  }

  const responseParams = new URL(responseUrl).searchParams;
  if (responseParams.get('state') !== state) return { error: 'STATE_MISMATCH' };
  const code = responseParams.get('code');
  if (!code) return { error: responseParams.get('error') || 'NO_CODE' };

  const tokenBody = new URLSearchParams({
    client_id: gscClientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  if (gscClientSecret) tokenBody.set('client_secret', gscClientSecret);

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString()
  });
  if (!tokenRes.ok) return { error: 'TOKEN_EXCHANGE_FAILED' };
  const tokenData = await tokenRes.json();

  await browser.storage.local.set({
    [authKey]: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      scope: tokenData.scope,
      email: googleEmailFromIdToken(tokenData.id_token),
      connectedAt: Date.now()
    }
  });
  return { connected: true };
}

// Wraps googleOAuthConnect with a check that the requested API scope actually
// came back granted. Google's consent screen can silently drop a scope (e.g.
// a restricted/sensitive scope on an OAuth client still in "Testing" mode
// whose test-user list doesn't include the chosen account) while still
// granting the harmless ones (openid/email) — the connection then "succeeds"
// but every API call fails with "insufficient authentication scopes." Catch
// that immediately instead of leaving a broken Connected chip.
async function googleOAuthConnectRequireScope(scope, authKey, missingScopeError) {
  const res = await googleOAuthConnect(scope, authKey);
  if (res && res.connected) {
    const stored = await browser.storage.local.get(authKey);
    const auth = stored[authKey];
    // Every requested scope must actually be present (scope may be a
    // space-separated list, e.g. analytics.readonly + analytics.edit).
    const granted = (auth && auth.scope) || '';
    const allPresent = scope.split(/\s+/).filter(Boolean).every(s =>
      new RegExp(`(^|\\s)${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(granted));
    if (!auth || !allPresent) {
      await browser.storage.local.remove(authKey);
      return { error: missingScopeError };
    }
  }
  return res;
}

async function googleDisconnect(authKey, extraKeys) {
  const stored = await browser.storage.local.get(authKey);
  const auth = stored[authKey];
  if (auth?.refreshToken) {
    try {
      await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(auth.refreshToken)}`, { method: 'POST' });
    } catch { /* best-effort revoke */ }
  }
  await browser.storage.local.remove([authKey, ...extraKeys]);
  return { connected: false };
}

async function googleGetAccessToken(authKey) {
  const stored = await browser.storage.local.get([authKey, 'gscClientId', 'gscClientSecret']);
  const auth = stored[authKey];
  const { gscClientId, gscClientSecret } = stored;
  if (!auth) return { error: 'NOT_CONNECTED' };
  if (auth.expiresAt > Date.now() + 60000) return { accessToken: auth.accessToken };

  const body = new URLSearchParams({
    client_id: gscClientId,
    refresh_token: auth.refreshToken,
    grant_type: 'refresh_token'
  });
  if (gscClientSecret) body.set('client_secret', gscClientSecret);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) {
    if (res.status === 400) {
      await browser.storage.local.remove(authKey);
      return { error: 'REAUTH_REQUIRED' };
    }
    return { error: 'TOKEN_REFRESH_FAILED' };
  }
  const data = await res.json();
  const updated = { ...auth, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  await browser.storage.local.set({ [authKey]: updated });
  return { accessToken: updated.accessToken };
}
