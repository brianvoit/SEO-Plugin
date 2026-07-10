browser.runtime.onInstalled.addListener(() => {
  browser.menus.removeAll(() => {
    browser.menus.create({
      id: 'seo-generate-alt',
      title: 'Generate Alt Text',
      contexts: ['image']
    });
  });
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'seo-generate-alt') {
    browser.tabs.sendMessage(tab.id, {
      action: 'generateAltText',
      srcUrl: info.srcUrl
    });
  }
});

// ─── Display mode: popup / sidebar / pop-out window ──────────────────────────
// In sidebar and window modes the toolbar button has no popup, so a click
// falls through to onClicked, which either toggles Firefox's native sidebar or
// opens (or focuses) the dedicated pop-out window.

async function applyDisplayMode() {
  const { displayMode } = await browser.storage.local.get('displayMode');
  const mode = displayMode || 'sidebar';   // default to sidebar when unset
  await browser.action.setPopup({ popup: mode === 'popup' ? 'popup.html' : '' });
}

applyDisplayMode();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.displayMode) applyDisplayMode();
});

// Firefox keeps the user-input context across WebExtension promise chains, so
// sidebarAction.toggle() still works after the storage read.
browser.action.onClicked.addListener(async () => {
  const { displayMode } = await browser.storage.local.get('displayMode');
  if ((displayMode || 'sidebar') === 'window') openPopoutWindow();
  else browser.sidebarAction.toggle();
});

// ─── Pop-out window ───────────────────────────────────────────────────────────

const POPOUT_KEY = 'popoutWindowId';

async function openPopoutWindow() {
  try {
    const stored = await browser.storage.session.get(POPOUT_KEY);
    const existingId = stored[POPOUT_KEY];
    if (existingId != null) {
      const win = await browser.windows.get(existingId).catch(() => null);
      if (win) { await browser.windows.update(existingId, { focused: true }); return; }
    }
  } catch { /* fall through to create */ }

  const win = await browser.windows.create({
    url: browser.runtime.getURL('popup.html?view=window'),
    type: 'popup',
    width: 460,
    height: 720
  });
  browser.storage.session.set({ [POPOUT_KEY]: win.id }).catch(() => {});
}

browser.windows.onRemoved.addListener(async windowId => {
  try {
    const stored = await browser.storage.session.get(POPOUT_KEY);
    if (stored[POPOUT_KEY] === windowId) await browser.storage.session.remove(POPOUT_KEY);
  } catch { /* ignore */ }
});

// ─── Target tab for the pop-out window ───────────────────────────────────────
// Inside a pop-out, tabs.query({currentWindow:true}) returns the pop-out's own
// extension page, so the background tracks the active tab of the last focused
// *normal* window and hands it to the popup via getTargetTab.

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const win = await browser.windows.get(windowId).catch(() => null);
  if (win && win.type === 'normal') {
    browser.storage.session.set({ lastNormalTab: tabId }).catch(() => {});
  }
});

browser.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  const win = await browser.windows.get(windowId, { populate: true }).catch(() => null);
  if (win && win.type === 'normal') {
    const active = (win.tabs || []).find(t => t.active);
    if (active) browser.storage.session.set({ lastNormalTab: active.id }).catch(() => {});
  }
});

// Inject content.js into a tab on demand. Runs from the background, where
// browser.scripting is reliably available (unlike the sidebar/popup context,
// where the same call can silently fail). Used by getPageDataFromTab when the
// content script isn't answering — a tab that was already open before the
// extension loaded never got the manifest's auto-injection. content.js guards
// itself against double-load, so injecting when it's already present is a
// harmless no-op rather than a redeclaration error.
async function injectContentScript({ tabId }) {
  if (tabId == null) return { ok: false, error: 'NO_TAB' };
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function getTargetTab() {
  try {
    const { lastNormalTab } = await browser.storage.session.get('lastNormalTab');
    if (lastNormalTab != null) {
      const tab = await browser.tabs.get(lastNormalTab).catch(() => null);
      if (tab) return tab;
    }
  } catch { /* storage.session unavailable */ }
  // Fallback: the focused (or first) normal window's active tab
  const wins = await browser.windows.getAll({ populate: true });
  const normals = wins.filter(w => w.type === 'normal');
  const target = normals.find(w => w.focused) || normals[0];
  return target ? (target.tabs || []).find(t => t.active) || null : null;
}

// ─── Redirect trace: status code + redirect chain per tab ───────────────────
// Observe-only webRequest on top-level navigations, so the popup can show how
// you arrived at the current page (direct vs. via redirects) and the full chain.
//
// The background is an MV3 event page, so the in-memory Map is only a
// write-through cache: every update is mirrored to storage.session (which
// survives event-page suspension and clears on browser exit), and reads fall
// back to it after a restart of the event page.

const redirectByTab = new Map();   // tabId -> { requestId, chain:[{url,status,kind?}], finalUrl, finalStatus, error, done, prevChain }

const REDIRECT_FILTER = { urls: ['*://*/*'], types: ['main_frame'] };
const REDIRECT_MAX_HOPS = 12;      // cap stitched chains (JS redirect loops)

function redirectKey(tabId) { return `redirect:${tabId}`; }

function saveRedirect(tabId, entry) {
  redirectByTab.set(tabId, entry);
  browser.storage.session.set({ [redirectKey(tabId)]: entry }).catch(() => {});
}

async function loadRedirect(tabId) {
  if (redirectByTab.has(tabId)) return redirectByTab.get(tabId);
  try {
    const stored = await browser.storage.session.get(redirectKey(tabId));
    const entry = stored[redirectKey(tabId)] || null;
    if (entry) redirectByTab.set(tabId, entry);
    return entry;
  } catch {
    return null;
  }
}

// Toolbar/sidebar icon badge: the page's final status code, colour-coded the
// same way the popup's status badge is (a 2xx reached via redirects reads amber).
const BADGE_COLORS = { ok: '#16a34a', redirect: '#d97706', error: '#dc2626', server: '#6b7280' };

function badgeLevelFor(status, redirectCount) {
  let base;
  if (status >= 200 && status < 300) base = 'ok';
  else if (status >= 300 && status < 400) base = 'redirect';
  else if (status >= 400 && status < 500) base = 'error';
  else base = 'server';
  return (base === 'ok' && redirectCount > 0) ? 'redirect' : base;
}

function setActionBadge(tabId, text, level) {
  browser.action.setBadgeText({ text, tabId });
  if (!level) return;
  browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS[level], tabId });
  if (browser.action.setBadgeTextColor) {
    browser.action.setBadgeTextColor({ color: '#ffffff', tabId });
  }
}

browser.webRequest.onBeforeRequest.addListener(details => {
  if (details.frameId !== 0) return;
  // Keep the finished previous chain around until onCommitted tells us whether
  // this navigation is a client (JS/meta) redirect — if so it gets stitched on.
  const prev = redirectByTab.get(details.tabId);
  saveRedirect(details.tabId, {
    requestId: details.requestId,
    chain: [],
    finalUrl: null,
    finalStatus: null,
    error: null,
    done: false,
    startedAt: details.timeStamp,
    _lastTs: details.timeStamp,
    _pending: null,
    prevChain: (prev && prev.done && prev.chain && prev.chain.length) ? prev.chain : null
  });
  setActionBadge(details.tabId, '');   // clear while the new navigation loads
}, REDIRECT_FILTER);

// Pull per-hop metadata off a hop's response: how long it took, whether it
// came from cache, the cookies it set, and any X-Robots-Tag directive.
function takePendingHopMeta(entry, details) {
  const ms = entry._lastTs != null ? Math.max(0, Math.round(details.timeStamp - entry._lastTs)) : null;
  entry._lastTs = details.timeStamp;
  const pending = entry._pending || {};
  entry._pending = null;
  return { ms, fromCache: !!details.fromCache, cookies: pending.cookies || [], xRobots: pending.xRobots || null };
}

browser.webRequest.onBeforeRedirect.addListener(details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || entry.requestId !== details.requestId) return;
  entry.chain.push({ url: details.url, status: details.statusCode, ...takePendingHopMeta(entry, details) });
  saveRedirect(details.tabId, entry);
}, REDIRECT_FILTER);

browser.webRequest.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || entry.requestId !== details.requestId) return;
  entry.chain.push({ url: details.url, status: details.statusCode, ...takePendingHopMeta(entry, details) });
  entry.finalUrl = details.url;
  entry.finalStatus = details.statusCode;
  entry.done = true;
  entry.totalMs = entry.startedAt != null ? Math.max(0, Math.round(details.timeStamp - entry.startedAt)) : null;
  saveRedirect(details.tabId, entry);
  const redirectCount = entry.chain.filter(h => h.status >= 300 && h.status < 400).length;
  setActionBadge(details.tabId, String(details.statusCode), badgeLevelFor(details.statusCode, redirectCount));
  browser.runtime.sendMessage({ action: 'redirectUpdated', tabId: details.tabId }).catch(() => {});
}, REDIRECT_FILTER);

browser.webRequest.onErrorOccurred.addListener(details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || entry.requestId !== details.requestId) return;
  entry.error = details.error;
  entry.done = true;
  saveRedirect(details.tabId, entry);
  // Skip user-initiated cancellations (clicking away mid-load)
  if (!/aborted/i.test(details.error || '')) {
    setActionBadge(details.tabId, 'ERR', 'server');
  }
}, REDIRECT_FILTER);

// Security headers + TLS details for the document response. Captured here
// (not via an external API) — getSecurityInfo only works inside a blocking
// onHeadersReceived listener for the live request.
const SECURITY_HEADER_NAMES = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy'
];

browser.webRequest.onHeadersReceived.addListener(async details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || entry.requestId !== details.requestId) return;

  // Final hop's headers win (each redirect hop overwrites the previous)
  const headers = {};
  const cookies = [];
  let xRobots = null;
  for (const h of details.responseHeaders || []) {
    const name = h.name.toLowerCase();
    if (SECURITY_HEADER_NAMES.includes(name)) headers[name] = h.value || '';
    if (name === 'set-cookie') {
      // A Set-Cookie value can carry multiple cookies on separate lines
      (h.value || '').split('\n').forEach(line => {
        const cookieName = line.split('=')[0].trim();
        if (cookieName) cookies.push(cookieName);
      });
    }
    if (name === 'x-robots-tag') xRobots = h.value || '';
  }
  entry.securityHeaders = headers;
  // Stashed for the hop that onBeforeRedirect/onCompleted is about to push
  entry._pending = { cookies, xRobots };

  if (details.url.startsWith('https:')) {
    try {
      const sec = await browser.webRequest.getSecurityInfo(details.requestId, {});
      const cert = sec.certificates && sec.certificates[0];
      entry.tls = {
        state: sec.state,                       // secure | weak | broken | insecure
        protocol: sec.protocolVersion || null,
        cipher: sec.cipherSuite || null,
        issuer: cert?.issuer || null,
        subject: cert?.subject || null,
        validityStart: cert?.validity?.start ?? null,
        validityEnd: cert?.validity?.end ?? null
      };
    } catch { /* security info unavailable for this request */ }
  }
  saveRedirect(details.tabId, entry);
}, REDIRECT_FILTER, ['blocking', 'responseHeaders']);

// JS/meta redirects start a brand-new request, which webRequest sees as an
// unrelated navigation. onCommitted's transitionQualifiers identifies them, so
// the previous page's chain gets stitched onto this one instead of dropped.
browser.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || !entry.prevChain) return;
  if ((details.transitionQualifiers || []).includes('client_redirect')) {
    const prev = entry.prevChain.map(h => ({ ...h }));
    prev[prev.length - 1].kind = 'client';   // junction hop: page issued a JS/meta redirect
    entry.chain = prev.concat(entry.chain).slice(-REDIRECT_MAX_HOPS);
    browser.runtime.sendMessage({ action: 'redirectUpdated', tabId: details.tabId }).catch(() => {});
  }
  entry.prevChain = null;
  saveRedirect(details.tabId, entry);
});

browser.tabs.onRemoved.addListener(tabId => {
  redirectByTab.delete(tabId);
  browser.storage.session.remove(redirectKey(tabId)).catch(() => {});
});

function getRedirectInfo({ tabId }) {
  return loadRedirect(tabId);
}

// ─── Active redirect trace ──────────────────────────────────────────────────
// The passive trace above only shows what the browser actually did to arrive at
// the page. This actively re-requests a URL and follows the whole chain, so the
// canonical path (http→https, non-www→www, trailing slash, …) always shows even
// when you're already sitting on the final URL. We fire our own background fetch
// and read each hop off webRequest (a plain fetch with redirect:'manual' returns
// an opaque response with no status/Location; our host permissions let
// webRequest see every cross-origin hop instead).

const TRACE_TIMEOUT_MS = 12000;

// Trace the page's actual URL so the chain reflects how this specific URL
// behaves — no synthesized bare-domain variant.
async function traceUrl({ pageUrl }) {
  let url;
  try { url = new URL(pageUrl).href; }
  catch { return { error: 'BAD_URL', hops: [] }; }
  if (!/^https?:/i.test(url)) return { error: 'BAD_URL', hops: [] };
  return traceOnce(url);
}

function traceOnce(startUrl) {
  return new Promise(resolve => {
    const filter = { urls: ['*://*/*'], types: ['xmlhttprequest'] };
    const abort = new AbortController();
    const trace = { startUrl, requestId: null, lastTs: null, hops: [], error: null };
    let settled = false;

    const cleanup = () => {
      browser.webRequest.onBeforeRequest.removeListener(onReq);
      browser.webRequest.onBeforeRedirect.removeListener(onRedir);
      browser.webRequest.onCompleted.removeListener(onDone);
      browser.webRequest.onErrorOccurred.removeListener(onErr);
      clearTimeout(timer);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        startUrl,
        hops: trace.hops,
        finalUrl: trace.hops.length ? trace.hops[trace.hops.length - 1].url : null,
        finalStatus: trace.hops.length ? trace.hops[trace.hops.length - 1].status : null,
        error: trace.hops.length ? null : trace.error
      });
    };
    const hopMs = ts => {
      const ms = trace.lastTs != null ? Math.max(0, Math.round(ts - trace.lastTs)) : 0;
      trace.lastTs = ts;
      return ms;
    };

    // Only our own background fetch (extension origin, no tab) starts the chain
    const onReq = d => {
      if (trace.requestId != null) return;
      if (d.url === startUrl && d.tabId === -1 && (d.originUrl || '').startsWith('moz-extension://')) {
        trace.requestId = d.requestId;
        trace.lastTs = d.timeStamp;
      }
    };
    const onRedir = d => {
      if (d.requestId !== trace.requestId) return;
      const internal = /internal redirect/i.test(d.statusLine || '');
      trace.hops.push({ url: d.url, status: d.statusCode, ms: hopMs(d.timeStamp), fromCache: !!d.fromCache, kind: internal ? 'internal' : null });
      if (trace.hops.length >= REDIRECT_MAX_HOPS) { abort.abort(); finish(); }
    };
    const onDone = d => {
      if (d.requestId !== trace.requestId) return;
      trace.hops.push({ url: d.url, status: d.statusCode, ms: hopMs(d.timeStamp), fromCache: !!d.fromCache, final: true });
      finish();
    };
    const onErr = d => {
      if (d.requestId !== trace.requestId) return;
      trace.error = d.error;
      finish();
    };

    browser.webRequest.onBeforeRequest.addListener(onReq, filter);
    browser.webRequest.onBeforeRedirect.addListener(onRedir, filter);
    browser.webRequest.onCompleted.addListener(onDone, filter);
    browser.webRequest.onErrorOccurred.addListener(onErr, filter);

    const timer = setTimeout(() => { trace.error = trace.error || 'TIMEOUT'; abort.abort(); finish(); }, TRACE_TIMEOUT_MS);

    fetch(startUrl, { method: 'GET', redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: abort.signal })
      .then(() => setTimeout(finish, 60))   // onCompleted normally finishes first; backstop
      .catch(err => { if (!trace.hops.length) trace.error = trace.error || String(err && err.message || err); setTimeout(finish, 60); });
  });
}

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

function getGoogleRedirectUri() {
  const redirectBase = browser.identity.getRedirectURL();
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

// ─── Google Search Console: OAuth + API ─────────────────────────────────────

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GSC_API_BASE = 'https://www.googleapis.com/webmasters/v3';
const GSC_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

const GSC_SITES_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const GSC_STALE_MS = 6 * 60 * 60 * 1000;
const GSC_DEBOUNCE_MS = 60 * 1000;
const GSC_CACHE_LIMIT = 20;

async function gscGetStatus() {
  const { gscAuth } = await browser.storage.local.get('gscAuth');
  return {
    connected: !!gscAuth,
    redirectUri: getGoogleRedirectUri(),
    connectedAt: gscAuth?.connectedAt ?? null,
    email: gscAuth ? await googleEnsureEmail('gscAuth') : null
  };
}

function gscConnect() {
  return googleOAuthConnectRequireScope(GSC_SCOPE, 'gscAuth', 'GSC_SCOPE_MISSING');
}

function gscDisconnect() {
  return googleDisconnect('gscAuth', ['gscSites', 'gscCache', 'gscInspectionCache', 'gscQueryCache']);
}

function gscGetAccessToken() {
  return googleGetAccessToken('gscAuth');
}

// ─── Google Search Console: data fetching ───────────────────────────────────

function gscFormatDate(d) {
  return d.toISOString().slice(0, 10);
}

function gscDateRanges(range) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (range - 1));

  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (range - 1));

  return {
    startDate: gscFormatDate(start),
    endDate: gscFormatDate(end),
    prevStartDate: gscFormatDate(prevStart),
    prevEndDate: gscFormatDate(prevEnd)
  };
}

async function gscFetchSites(accessToken) {
  const { gscSites } = await browser.storage.local.get('gscSites');
  if (gscSites && (Date.now() - gscSites.fetchedAt < GSC_SITES_STALE_MS)) return gscSites.sites;
  try {
    const res = await fetch(`${GSC_API_BASE}/sites`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      if (gscSites?.sites) return gscSites.sites;
      const body = await res.json().catch(() => null);
      const msg = body?.error?.message;
      throw { code: 'API_ERROR', detail: msg ? `sites.list: ${msg}` : `sites.list: HTTP ${res.status}` };
    }
    const data = await res.json();
    const sites = (data.siteEntry || []).map(s => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
    await browser.storage.local.set({ gscSites: { fetchedAt: Date.now(), sites } });
    return sites;
  } catch (err) {
    if (gscSites?.sites) return gscSites.sites;
    throw (err && err.code) ? err : { code: 'API_ERROR', detail: 'sites.list: network error' };
  }
}

function gscPageHost(pageUrl) {
  try { return new URL(pageUrl).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}

// All verified properties that cover this page's domain — every URL-prefix
// variant (http/https, with/without www) plus the sc-domain: property.
function gscMatchingProperties(sites, pageUrl) {
  const host = gscPageHost(pageUrl);
  if (!host) return [];
  return sites.filter(s => {
    if (s.siteUrl.startsWith('sc-domain:')) {
      return s.siteUrl.slice('sc-domain:'.length).replace(/^www\./, '').toLowerCase() === host;
    }
    try { return new URL(s.siteUrl).hostname.replace(/^www\./, '').toLowerCase() === host; }
    catch { return false; }
  }).map(s => s.siteUrl);
}

async function gscLoadOverride(pageUrl) {
  const host = gscPageHost(pageUrl);
  if (!host) return null;
  const { gscPropertyOverrides } = await browser.storage.local.get('gscPropertyOverrides');
  return (gscPropertyOverrides && gscPropertyOverrides[host]) || null;
}

function gscResolveSiteUrl(sites, pageUrl, override) {
  // A user-chosen property wins, as long as it's still a verified property
  if (override && sites.some(s => s.siteUrl === override)) return override;

  const u = new URL(pageUrl);
  const host = u.hostname.replace(/^www\./, '');

  const prefixMatches = [];
  for (const s of sites) {
    if (s.siteUrl.startsWith('sc-domain:')) continue;
    try {
      const su = new URL(s.siteUrl);
      if (su.hostname.replace(/^www\./, '') === host) prefixMatches.push(s);
    } catch { /* malformed property URL */ }
  }
  const sameScheme = prefixMatches.filter(s => new URL(s.siteUrl).protocol === u.protocol);
  const pool = sameScheme.length ? sameScheme : prefixMatches;
  if (pool.length) {
    pool.sort((a, b) => b.siteUrl.length - a.siteUrl.length);
    return pool[0].siteUrl;
  }

  const domainMatch = sites.find(s => s.siteUrl === `sc-domain:${host}` || s.siteUrl === `sc-domain:www.${host}`);
  return domainMatch ? domainMatch.siteUrl : null;
}

// Persist a per-domain property choice and drop cached data so the new
// property takes effect immediately.
async function gscSetProperty({ host, siteUrl }) {
  if (!host) return { ok: false };
  const { gscPropertyOverrides } = await browser.storage.local.get('gscPropertyOverrides');
  const overrides = gscPropertyOverrides || {};
  if (siteUrl) overrides[host] = siteUrl; else delete overrides[host];
  await browser.storage.local.set({ gscPropertyOverrides: overrides });
  await gscClearCacheForHost(host);
  return { ok: true };
}

async function gscClearCacheForHost(host) {
  const keys = ['gscCache', 'gscQueryCache', 'gscInspectionCache'];
  const stored = await browser.storage.local.get(keys);
  const changed = {};
  for (const k of keys) {
    const cache = stored[k];
    if (!cache) continue;
    let mutated = false;
    for (const key of Object.keys(cache)) {
      if (gscPageHost(key.split('::')[0]) === host) { delete cache[key]; mutated = true; }
    }
    if (mutated) changed[k] = cache;
  }
  if (Object.keys(changed).length) await browser.storage.local.set(changed);
}

async function gscQuery(accessToken, siteUrl, body) {
  const res = await fetch(`${GSC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 429) throw { code: 'RATE_LIMITED' };
  if (!res.ok) throw { code: 'API_ERROR', detail: String(res.status) };
  return res.json();
}

function gscAggregateTotals(rows) {
  if (!rows || !rows.length) return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  let clicks = 0, impressions = 0, posWeighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    posWeighted += r.position * r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position: impressions ? posWeighted / impressions : 0
  };
}

async function gscPruneCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= GSC_CACHE_LIMIT) return;
  keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
  for (const k of keys.slice(0, keys.length - GSC_CACHE_LIMIT)) delete cache[k];
}

async function gscInspectUrl(accessToken, siteUrl, pageUrl, forceRefresh) {
  const { gscInspectionCache } = await browser.storage.local.get('gscInspectionCache');
  const cache = gscInspectionCache || {};
  const cached = cache[pageUrl];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < GSC_STALE_MS)) {
    return { result: cached.result };
  }
  try {
    const res = await fetch(GSC_INSPECTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: pageUrl, siteUrl, languageCode: 'en-US' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const idx = data.inspectionResult?.indexStatusResult || {};
    const result = {
      verdict: idx.verdict || 'VERDICT_UNSPECIFIED',
      coverageState: idx.coverageState || '',
      indexingState: idx.indexingState || '',
      pageFetchState: idx.pageFetchState || '',
      lastCrawlTime: idx.lastCrawlTime || null,
      googleCanonical: idx.googleCanonical || null,
      userCanonical: idx.userCanonical || null,
      sitemaps: idx.sitemap || [],
      referringUrls: idx.referringUrls || []
    };
    cache[pageUrl] = { fetchedAt: Date.now(), siteUrl, result };
    await gscPruneCache(cache);
    await browser.storage.local.set({ gscInspectionCache: cache });
    return { result };
  } catch (err) {
    return { result: cached ? cached.result : null, error: err.message };
  }
}

async function gscAttachInspection(entry, accessToken, pageUrl, fromCache, forceRefresh) {
  const insp = await gscInspectUrl(accessToken, entry.siteUrl, pageUrl, forceRefresh);
  return {
    connected: true,
    siteUrl: entry.siteUrl,
    overview: { timeseries: entry.timeseries, totals: entry.totals, previousTotals: entry.previousTotals },
    queries: entry.queries,
    inspection: insp.result,
    inspectionError: insp.error || null,
    fetchedAt: entry.fetchedAt,
    fromCache
  };
}

async function gscGetPageData({ pageUrl, range, forceRefresh }) {
  const tokenResult = await gscGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const cacheKey = `${pageUrl}::${range}`;
  const { gscCache } = await browser.storage.local.get('gscCache');
  const cache = gscCache || {};
  const cached = cache[cacheKey];

  const isStale = !cached || (Date.now() - cached.fetchedAt > GSC_STALE_MS);
  const withinDebounce = cached && (Date.now() - cached.fetchedAt < GSC_DEBOUNCE_MS);
  const useCache = cached && ((!forceRefresh && !isStale) || (forceRefresh && withinDebounce));

  if (useCache) {
    return await gscAttachInspection(cached, accessToken, pageUrl, true, forceRefresh && !withinDebounce);
  }

  let sites;
  try {
    sites = await gscFetchSites(accessToken);
  } catch (err) {
    return { connected: true, error: err.code || 'API_ERROR', detail: err.detail };
  }

  const siteUrl = gscResolveSiteUrl(sites, pageUrl, await gscLoadOverride(pageUrl));
  if (!siteUrl) {
    const detail = sites.length
      ? `Connected account has access to: ${sites.map(s => s.siteUrl).join(', ')}`
      : 'Connected account has no Search Console properties.';
    return { connected: true, error: 'NO_PROPERTY', detail };
  }

  const { startDate, endDate, prevStartDate, prevEndDate } = gscDateRanges(range);
  const pageFilter = { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }] }] };

  let timeseriesData, queriesData, prevData;
  try {
    [timeseriesData, queriesData, prevData] = await Promise.all([
      gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ['date'], dataState: 'all', ...pageFilter }),
      gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ['query'], rowLimit: 25, dataState: 'all', ...pageFilter }),
      gscQuery(accessToken, siteUrl, { startDate: prevStartDate, endDate: prevEndDate, dataState: 'all', ...pageFilter })
    ]);
  } catch (err) {
    if (err.code === 'RATE_LIMITED') return { connected: true, error: 'RATE_LIMITED' };
    return { connected: true, error: 'API_ERROR', detail: err.detail };
  }

  const timeseries = (timeseriesData.rows || []).map(r => ({
    date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position
  }));
  const queries = (queriesData.rows || []).map(r => ({
    query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position
  }));

  const entry = {
    fetchedAt: Date.now(),
    siteUrl,
    range,
    timeseries,
    queries,
    totals: gscAggregateTotals(timeseriesData.rows),
    previousTotals: gscAggregateTotals(prevData.rows)
  };
  cache[cacheKey] = entry;
  await gscPruneCache(cache);
  await browser.storage.local.set({ gscCache: cache });

  return await gscAttachInspection(entry, accessToken, pageUrl, false, forceRefresh);
}

async function gscGetQueryData({ pageUrl, range, query, forceRefresh }) {
  const tokenResult = await gscGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const cacheKey = `${pageUrl}::${range}::q:${query}`;
  const { gscQueryCache } = await browser.storage.local.get('gscQueryCache');
  const cache = gscQueryCache || {};
  const cached = cache[cacheKey];

  const isStale = !cached || (Date.now() - cached.fetchedAt > GSC_STALE_MS);
  const withinDebounce = cached && (Date.now() - cached.fetchedAt < GSC_DEBOUNCE_MS);
  const useCache = cached && ((!forceRefresh && !isStale) || (forceRefresh && withinDebounce));

  if (useCache) {
    return { connected: true, timeseries: cached.timeseries, totals: cached.totals, previousTotals: cached.previousTotals, fetchedAt: cached.fetchedAt };
  }

  let sites;
  try {
    sites = await gscFetchSites(accessToken);
  } catch (err) {
    return { connected: true, error: err.code || 'API_ERROR', detail: err.detail };
  }

  const siteUrl = gscResolveSiteUrl(sites, pageUrl, await gscLoadOverride(pageUrl));
  if (!siteUrl) return { connected: true, error: 'NO_PROPERTY' };

  const { startDate, endDate, prevStartDate, prevEndDate } = gscDateRanges(range);
  const filter = {
    dimensionFilterGroups: [{ filters: [
      { dimension: 'page', operator: 'equals', expression: pageUrl },
      { dimension: 'query', operator: 'equals', expression: query }
    ] }]
  };

  let timeseriesData, prevData;
  try {
    [timeseriesData, prevData] = await Promise.all([
      gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ['date'], dataState: 'all', ...filter }),
      gscQuery(accessToken, siteUrl, { startDate: prevStartDate, endDate: prevEndDate, dataState: 'all', ...filter })
    ]);
  } catch (err) {
    if (err.code === 'RATE_LIMITED') return { connected: true, error: 'RATE_LIMITED' };
    return { connected: true, error: 'API_ERROR', detail: err.detail };
  }

  const timeseries = (timeseriesData.rows || []).map(r => ({
    date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position
  }));

  const entry = {
    fetchedAt: Date.now(),
    timeseries,
    totals: gscAggregateTotals(timeseriesData.rows),
    previousTotals: gscAggregateTotals(prevData.rows)
  };
  cache[cacheKey] = entry;
  await gscPruneCache(cache);
  await browser.storage.local.set({ gscQueryCache: cache });

  return { connected: true, ...entry };
}

// Aggregated timeseries/totals for a SET of queries (intent-filter chart on the
// Search tab). GSC joins multiple dimensionFilterGroups with AND, so an OR-of-
// queries can't be expressed server-side. Instead fetch date×query rows for the
// page (one page filter) and aggregate client-side over the requested set.
async function gscGetQueriesData({ pageUrl, range, queries }) {
  const tokenResult = await gscGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const list = (Array.isArray(queries) ? queries : []).map(q => String(q || '')).filter(Boolean);
  if (!list.length) {
    return { connected: true, timeseries: [], totals: gscAggregateTotals([]), previousTotals: gscAggregateTotals([]) };
  }
  const set = new Set(list.map(q => q.toLowerCase()));

  let sites;
  try { sites = await gscFetchSites(accessToken); }
  catch (err) { return { connected: true, error: err.code || 'API_ERROR', detail: err.detail }; }

  const siteUrl = gscResolveSiteUrl(sites, pageUrl, await gscLoadOverride(pageUrl));
  if (!siteUrl) return { connected: true, error: 'NO_PROPERTY' };

  const { startDate, endDate, prevStartDate, prevEndDate } = gscDateRanges(range);
  const pageFilter = { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }] }] };

  // Fetch per-(date,query) rows for a range, keep only the set, re-aggregate by
  // date (impression-weighted position) into the same shape as the page chart.
  const fetchAgg = async (sd, ed) => {
    const data = await gscQuery(accessToken, siteUrl, {
      startDate: sd, endDate: ed, dimensions: ['date', 'query'], rowLimit: 25000, dataState: 'all', ...pageFilter
    });
    const byDate = {};
    (data.rows || []).forEach(r => {
      if (!set.has((r.keys[1] || '').toLowerCase())) return;
      const date = r.keys[0];
      if (!byDate[date]) byDate[date] = { date, clicks: 0, impressions: 0, _pw: 0 };
      byDate[date].clicks += r.clicks;
      byDate[date].impressions += r.impressions;
      byDate[date]._pw += r.position * r.impressions;
    });
    return Object.keys(byDate).sort().map(d => {
      const o = byDate[d];
      return { date: d, clicks: o.clicks, impressions: o.impressions, ctr: o.impressions ? o.clicks / o.impressions : 0, position: o.impressions ? o._pw / o.impressions : 0 };
    });
  };

  let timeseries, prevSeries;
  try {
    [timeseries, prevSeries] = await Promise.all([fetchAgg(startDate, endDate), fetchAgg(prevStartDate, prevEndDate)]);
  } catch (err) {
    if (err.code === 'RATE_LIMITED') return { connected: true, error: 'RATE_LIMITED' };
    return { connected: true, error: 'API_ERROR', detail: err.detail };
  }

  return {
    connected: true,
    timeseries,
    totals: gscAggregateTotals(timeseries),
    previousTotals: gscAggregateTotals(prevSeries)
  };
}

// Next page of queries for the table ("Request More" / branded top-up). Not
// cached — it's an explicit, paged fetch on top of the first 25.
async function gscGetMoreQueries({ pageUrl, range, startRow }) {
  const tokenResult = await gscGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  let sites;
  try { sites = await gscFetchSites(accessToken); }
  catch (err) { return { connected: true, error: err.code || 'API_ERROR', detail: err.detail }; }

  const siteUrl = gscResolveSiteUrl(sites, pageUrl, await gscLoadOverride(pageUrl));
  if (!siteUrl) return { connected: true, error: 'NO_PROPERTY' };

  const { startDate, endDate } = gscDateRanges(range);
  const pageFilter = { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }] }] };

  let data;
  try {
    data = await gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ['query'], rowLimit: 50, startRow: startRow || 0, dataState: 'all', ...pageFilter });
  } catch (err) {
    if (err.code === 'RATE_LIMITED') return { connected: true, error: 'RATE_LIMITED' };
    return { connected: true, error: 'API_ERROR', detail: err.detail };
  }

  const queries = (data.rows || []).map(r => ({
    query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position
  }));
  return { connected: true, queries };
}

// Page timeseries + totals, optionally excluding branded queries (RE2 regex)
// so the chart can drop branded traffic when "Hide branded" is on.
async function gscGetChartData({ pageUrl, range, excludeRegex }) {
  const tokenResult = await gscGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  let sites;
  try { sites = await gscFetchSites(accessToken); }
  catch (err) { return { connected: true, error: err.code || 'API_ERROR', detail: err.detail }; }

  const siteUrl = gscResolveSiteUrl(sites, pageUrl, await gscLoadOverride(pageUrl));
  if (!siteUrl) return { connected: true, error: 'NO_PROPERTY' };

  const { startDate, endDate, prevStartDate, prevEndDate } = gscDateRanges(range);
  const filters = [{ dimension: 'page', operator: 'equals', expression: pageUrl }];
  if (excludeRegex) filters.push({ dimension: 'query', operator: 'excludingRegex', expression: excludeRegex });
  const grp = { dimensionFilterGroups: [{ filters }] };

  let timeseriesData, prevData;
  try {
    [timeseriesData, prevData] = await Promise.all([
      gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ['date'], dataState: 'all', ...grp }),
      gscQuery(accessToken, siteUrl, { startDate: prevStartDate, endDate: prevEndDate, dataState: 'all', ...grp })
    ]);
  } catch (err) {
    if (err.code === 'RATE_LIMITED') return { connected: true, error: 'RATE_LIMITED' };
    return { connected: true, error: 'API_ERROR', detail: err.detail };
  }

  return {
    connected: true,
    timeseries: (timeseriesData.rows || []).map(r => ({
      date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position
    })),
    totals: gscAggregateTotals(timeseriesData.rows),
    previousTotals: gscAggregateTotals(prevData.rows)
  };
}

// Resolve which verified property a URL maps to, plus the full property list —
// lightweight (no analytics fetch), used by the Settings screen.
async function gscResolveProperty({ pageUrl }) {
  const tokenResult = await gscGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };

  let sites;
  try {
    sites = await gscFetchSites(tokenResult.accessToken);
  } catch (err) {
    return { connected: true, error: err.code || 'API_ERROR', detail: err.detail };
  }

  const override = await gscLoadOverride(pageUrl);
  let siteUrl = null;
  try { siteUrl = gscResolveSiteUrl(sites, pageUrl, override); } catch { /* malformed URL */ }
  return {
    connected: true,
    siteUrl,
    override,
    host: gscPageHost(pageUrl),
    matching: gscMatchingProperties(sites, pageUrl)
  };
}

// ─── Google Analytics (GA4): OAuth + API ─────────────────────────────────────

const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GA_ADMIN_SUMMARIES_URL = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries';
const GA_DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';

const GA_PROPS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const GA_STALE_MS = 6 * 60 * 60 * 1000;
const GA_DEBOUNCE_MS = 60 * 1000;

async function gaGetStatus() {
  const { gaAuth } = await browser.storage.local.get('gaAuth');
  return {
    connected: !!gaAuth,
    redirectUri: getGoogleRedirectUri(),
    connectedAt: gaAuth?.connectedAt ?? null,
    email: gaAuth ? await googleEnsureEmail('gaAuth') : null
  };
}

function gaConnect() {
  return googleOAuthConnectRequireScope(GA_SCOPE, 'gaAuth', 'GA_SCOPE_MISSING');
}

// Writing GA4 annotations needs the analytics.edit scope (config write), which
// the read-only default connection doesn't include. This upgrades the existing
// gaAuth token to readonly+edit via re-consent — only requested when the user
// actually adds an annotation, so read-only users are never forced to grant it.
const GA_EDIT_SCOPE = `${GA_SCOPE} https://www.googleapis.com/auth/analytics.edit`;
async function gaConnectEdit() {
  // Back up the current (read-only) connection first: if the upgrade consents
  // but Google drops the edit scope, require-scope removes gaAuth — restore it
  // so a failed annotation-permission upgrade never disconnects working GA.
  const { gaAuth: backup } = await browser.storage.local.get('gaAuth');
  const res = await googleOAuthConnectRequireScope(GA_EDIT_SCOPE, 'gaAuth', 'GA_EDIT_SCOPE_MISSING');
  if (res && res.error === 'GA_EDIT_SCOPE_MISSING' && backup) {
    await browser.storage.local.set({ gaAuth: backup });
  }
  return res;
}
async function gaHasEditScope() {
  const { gaAuth } = await browser.storage.local.get('gaAuth');
  return /(^|\s)https:\/\/www\.googleapis\.com\/auth\/analytics\.edit(\s|$)/.test((gaAuth && gaAuth.scope) || '');
}

// Create a GA4 reporting-data annotation on the domain's property for a single
// date. Returns { error:'GA_EDIT_SCOPE_MISSING' } when the connection is still
// read-only, so the popup can offer a one-click upgrade (gaConnectEdit).
async function ga4AddAnnotation({ pageUrl, date, title, description }) {
  const tokenResult = await gaGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };

  if (!(await gaHasEditScope())) return { connected: true, error: 'GA_EDIT_SCOPE_MISSING' };

  const resolved = await gaResolveProperty({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error) return { connected: true, error: resolved.error, detail: resolved.detail };
  if (!resolved.property) return { connected: true, error: 'NO_PROPERTY' };

  const [y, m, d] = String(date || '').split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return { connected: true, error: 'BAD_DATE' };

  const body = {
    title: String(title || '').slice(0, 128) || 'Annotation',
    // Required enum — omitting it makes the API default to COLOR_UNSPECIFIED,
    // which it then rejects ("invalid enum value COLOR_UNSPECIFIED"). Valid
    // values: PURPLE, BROWN, BLUE, GREEN, RED, CYAN, ORANGE.
    color: 'BLUE',
    annotationDate: { year: y, month: m, day: d }
  };
  if (description) body.description = String(description).slice(0, 1024);

  let res;
  try {
    res = await fetch(`https://analyticsadmin.googleapis.com/v1alpha/${resolved.property}/reportingDataAnnotations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResult.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch { return { connected: true, error: 'NETWORK' }; }
  if (res.status === 401 || res.status === 403) return { connected: true, error: 'GA_EDIT_SCOPE_MISSING' };
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    return { connected: true, error: 'API_ERROR', detail: (err && err.error && err.error.message) || `HTTP ${res.status}` };
  }
  const data = await res.json().catch(() => ({}));
  return { connected: true, ok: true, property: resolved.property, id: data.name || null };
}

// List GA4 annotations for the domain's property (read-only scope is enough).
// Returns [{ date:'YYYY-MM-DD', text }]. Used to place stars on the charts.
async function ga4ListAnnotations({ pageUrl }) {
  const tokenResult = await gaGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const resolved = await gaResolveProperty({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error || !resolved.property) return { connected: true, error: resolved.error || 'NO_PROPERTY' };

  let res;
  try {
    res = await fetch(`https://analyticsadmin.googleapis.com/v1alpha/${resolved.property}/reportingDataAnnotations?pageSize=200`, {
      headers: { Authorization: `Bearer ${tokenResult.accessToken}` }
    });
  } catch { return { connected: true, error: 'NETWORK' }; }
  if (!res.ok) return { connected: true, error: 'API_ERROR', detail: `HTTP ${res.status}` };
  const data = await res.json().catch(() => ({}));
  const fmt = d => (d && d.year) ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null;
  const annotations = (data.reportingDataAnnotations || []).map(a => ({
    date: fmt(a.annotationDate) || fmt(a.annotationDateRange && a.annotationDateRange.startDate),
    text: a.title || a.description || ''
  })).filter(a => a.date);
  return { connected: true, annotations };
}

function gaDisconnect() {
  return googleDisconnect('gaAuth', ['gaProperties', 'gaCache']);
}

function gaGetAccessToken() {
  return googleGetAccessToken('gaAuth');
}

// GA4 properties via the Admin API account summaries, cached like gscSites
async function gaFetchProperties(accessToken) {
  const { gaProperties } = await browser.storage.local.get('gaProperties');
  if (gaProperties && (Date.now() - gaProperties.fetchedAt < GA_PROPS_STALE_MS)) return gaProperties.properties;
  try {
    const properties = [];
    let pageToken = '';
    do {
      const url = new URL(GA_ADMIN_SUMMARIES_URL);
      url.searchParams.set('pageSize', '200');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        if (gaProperties?.properties) return gaProperties.properties;
        const body = await res.json().catch(() => null);
        throw { code: 'API_ERROR', detail: body?.error?.message || `accountSummaries: HTTP ${res.status}` };
      }
      const data = await res.json();
      (data.accountSummaries || []).forEach(acc => {
        (acc.propertySummaries || []).forEach(p => {
          properties.push({ property: p.property, displayName: p.displayName, account: acc.displayName || acc.account });
        });
      });
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    await browser.storage.local.set({ gaProperties: { fetchedAt: Date.now(), properties } });
    return properties;
  } catch (err) {
    if (gaProperties?.properties) return gaProperties.properties;
    throw (err && err.code) ? err : { code: 'API_ERROR', detail: 'accountSummaries: network error' };
  }
}

// GA4 properties aren't keyed by domain, so the user picks one per host
async function gaGetProperty(host) {
  if (!host) return null;
  const { gaPropertyOverrides } = await browser.storage.local.get('gaPropertyOverrides');
  return (gaPropertyOverrides && gaPropertyOverrides[host]) || null;
}

// Map a GA4 measurement ID (G-XXXX, found on the page) to its property by
// scanning each property's data streams. Cached, and every stream seen along
// the way is cached too, so later lookups are instant.
async function gaMatchMeasurementId(measurementId, properties, accessToken) {
  if (!measurementId) return null;
  const mid = measurementId.toUpperCase();
  const { gaStreamMap } = await browser.storage.local.get('gaStreamMap');
  const map = gaStreamMap || {};
  if (map[mid] && properties.some(p => p.property === map[mid])) return map[mid];

  let found = null;
  for (const p of properties.slice(0, 30)) {
    try {
      const res = await fetch(`https://analyticsadmin.googleapis.com/v1beta/${p.property}/dataStreams`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const s of data.dataStreams || []) {
        const sid = s.webStreamData && s.webStreamData.measurementId;
        if (sid) map[sid.toUpperCase()] = p.property;
        if (sid && sid.toUpperCase() === mid) found = p.property;
      }
      if (found) break;
    } catch { /* skip this property */ }
  }
  await browser.storage.local.set({ gaStreamMap: map });
  return found;
}

async function gaResolveProperty({ pageUrl, measurementId }) {
  const tokenResult = await gaGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };

  let properties;
  try {
    properties = await gaFetchProperties(tokenResult.accessToken);
  } catch (err) {
    return { connected: true, error: err.code || 'API_ERROR', detail: err.detail };
  }

  const host = gscPageHost(pageUrl);
  const chosen = await gaGetProperty(host);
  const property = (chosen && properties.some(p => p.property === chosen)) ? chosen : null;

  let detectedProperty = null;
  if (measurementId) {
    try { detectedProperty = await gaMatchMeasurementId(measurementId, properties, tokenResult.accessToken); }
    catch { /* ignore detection failures */ }
  }

  return { connected: true, host, property, detectedProperty, detectedId: measurementId || null, properties };
}

async function gaSetProperty({ host, property }) {
  if (!host) return { ok: false };
  const { gaPropertyOverrides } = await browser.storage.local.get('gaPropertyOverrides');
  const overrides = gaPropertyOverrides || {};
  if (property) overrides[host] = property; else delete overrides[host];
  await browser.storage.local.set({ gaPropertyOverrides: overrides });

  // Drop cached GA data for this host so the new property takes effect
  const { gaCache } = await browser.storage.local.get('gaCache');
  if (gaCache) {
    let mutated = false;
    for (const key of Object.keys(gaCache)) {
      if (key.startsWith(`${host}::`)) { delete gaCache[key]; mutated = true; }
    }
    if (mutated) await browser.storage.local.set({ gaCache });
  }
  return { ok: true };
}

async function gaRunReport(accessToken, property, body) {
  const res = await fetch(`${GA_DATA_BASE}/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 429) throw { code: 'RATE_LIMITED' };
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw { code: 'API_ERROR', detail: errBody?.error?.message || `runReport: HTTP ${res.status}` };
  }
  return res.json();
}

// Distinct source / medium / campaign values GA4 has already recorded for the
// current page (last 90d) — used by the UTM Generator to offer autofill
// chips of values that already exist for this URL. Never throws: any failure
// (not connected, no property, API error) resolves to a graceful shape the
// panel treats as "no GA chips", so UTM building always works.
const GA_UTM_VALUES_TTL_MS = 10 * 60 * 1000;
const _gaUtmValuesCache = new Map();   // `${property}::${path}` → { at, sources, mediums, campaigns }
async function gaGetPageUtmValues({ pageUrl, measurementId }) {
  const tokenResult = await gaGetAccessToken();
  if (tokenResult.error) return { connected: false };
  const accessToken = tokenResult.accessToken;

  const host = gscPageHost(pageUrl);
  let property = await gaGetProperty(host);
  if (!property && measurementId) {
    try {
      const properties = await gaFetchProperties(accessToken);
      property = await gaMatchMeasurementId(measurementId, properties, accessToken);
    } catch { /* fall through */ }
  }
  if (!property) return { connected: true, property: null };

  let path = '/';
  try { path = new URL(pageUrl).pathname; } catch { /* keep root */ }

  const cacheKey = `${property}::${path}`;
  const hit = _gaUtmValuesCache.get(cacheKey);
  if (hit && (Date.now() - hit.at < GA_UTM_VALUES_TTL_MS)) {
    return { connected: true, property, sources: hit.sources, mediums: hit.mediums, campaigns: hit.campaigns };
  }

  const NOISE = new Set(['', '(not set)', '(none)', '(direct)', '(data not available)']);
  let data;
  try {
    data = await gaRunReport(accessToken, property, {
      dateRanges: [{ startDate: '90daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }, { name: 'sessionCampaignName' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: path } } },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 50
    });
  } catch (err) {
    return { connected: true, property, error: err.code || 'API_ERROR', detail: err.detail };
  }

  // Preserve GA's sessions-desc order while de-duping each dimension.
  const pick = (idx) => {
    const seen = new Set();
    const out = [];
    (data.rows || []).forEach(r => {
      const v = (r.dimensionValues && r.dimensionValues[idx] && r.dimensionValues[idx].value || '').trim();
      const lc = v.toLowerCase();
      if (NOISE.has(lc) || seen.has(lc)) return;
      seen.add(lc);
      out.push(v);
    });
    return out.slice(0, 15);
  };
  const result = { sources: pick(0), mediums: pick(1), campaigns: pick(2) };
  _gaUtmValuesCache.set(cacheKey, { at: Date.now(), ...result });
  return { connected: true, property, ...result };
}

// GA data lags ~1 day (vs. GSC's ~3), so ranges end yesterday
function gaDateRanges(range) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (range - 1));

  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (range - 1));

  return {
    startDate: gscFormatDate(start),
    endDate: gscFormatDate(end),
    prevStartDate: gscFormatDate(prevStart),
    prevEndDate: gscFormatDate(prevEnd)
  };
}

// Note: GA4 has no "entrances" metric (unlike UA). It's computed separately
// from a landing-page session count — see gaFetchEntrances.
const GA_METRIC_NAMES = ['sessions', 'activeUsers', 'screenPageViews', 'bounceRate', 'userEngagementDuration'];

function gaEmptyMetrics() {
  return { sessions: 0, users: 0, pageviews: 0, entrances: 0, bounceRate: 0, avgEngagement: 0 };
}

function gaParseMetricRow(row) {
  const v = row?.metricValues || [];
  const sessions = Number(v[0]?.value || 0);
  const engagementDuration = Number(v[4]?.value || 0);   // total user-engagement seconds
  return {
    sessions,
    users:      Number(v[1]?.value || 0),
    pageviews:  Number(v[2]?.value || 0),
    bounceRate: Number(v[3]?.value || 0),                       // 0..1 proportion
    avgEngagement: sessions > 0 ? engagementDuration / sessions : 0   // avg seconds/session
  };
}

// Entrances = sessions that started (landed) on this page. GA4 has no
// "entrances" metric, so count sessions filtered to this landing page. The
// anchored regex avoids prefix/homepage over-matching. Best-effort: returns
// zeros rather than failing the whole Analytics load.
async function gaFetchEntrances(accessToken, property, path, ranges, channel) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lpRegex = `^${esc(path)}(\\?.*)?$`;
  const expressions = [
    { filter: { fieldName: 'landingPagePlusQueryString', stringFilter: { matchType: 'FULL_REGEXP', value: lpRegex } } }
  ];
  if (channel) {
    expressions.push({ filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: channel } } });
  }
  const filter = expressions.length > 1
    ? { dimensionFilter: { andGroup: { expressions } } }
    : { dimensionFilter: expressions[0] };

  let data;
  try {
    data = await gaRunReport(accessToken, property, {
      dateRanges: [{ startDate: ranges.startDate, endDate: ranges.endDate }, { startDate: ranges.prevStartDate, endDate: ranges.prevEndDate }],
      metrics: [{ name: 'sessions' }],
      ...filter
    });
  } catch { return { current: 0, previous: 0 }; }

  let current = 0, previous = 0;
  (data.rows || []).forEach(row => {
    const which = row.dimensionValues?.[0]?.value;
    const val = Number(row.metricValues?.[0]?.value || 0);
    if (which === 'date_range_1') previous = val; else current = val;
  });
  return { current, previous };
}

async function gaGetPageData({ pageUrl, range, forceRefresh, measurementId }) {
  const tokenResult = await gaGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const host = gscPageHost(pageUrl);
  // Manual per-domain choice wins; otherwise fall back to the property matching
  // the page's own GA4 measurement ID (auto-suggested).
  let property = await gaGetProperty(host);
  if (!property && measurementId) {
    try {
      const properties = await gaFetchProperties(accessToken);
      property = await gaMatchMeasurementId(measurementId, properties, accessToken);
    } catch { /* fall through to NO_PROPERTY */ }
  }
  if (!property) return { connected: true, error: 'NO_PROPERTY', host };

  let path = '/';
  try { path = new URL(pageUrl).pathname; } catch { /* keep root */ }

  const cacheKey = `${host}::${path}::${range}`;
  const { gaCache } = await browser.storage.local.get('gaCache');
  const cache = gaCache || {};
  const cached = cache[cacheKey];

  const isStale = !cached || cached.property !== property || (Date.now() - cached.fetchedAt > GA_STALE_MS);
  const withinDebounce = cached && (Date.now() - cached.fetchedAt < GA_DEBOUNCE_MS);
  const useCache = cached && cached.property === property && ((!forceRefresh && !isStale) || (forceRefresh && withinDebounce));

  if (useCache) return { connected: true, ...cached, fromCache: true };

  const { startDate, endDate, prevStartDate, prevEndDate } = gaDateRanges(range);
  const metrics = GA_METRIC_NAMES.map(name => ({ name }));
  const pageFilter = {
    dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: path } } }
  };

  // "Next pages": destinations whose referrer is this page (document.referrer).
  // GA4 has no path-exploration in the Data API, so this is the closest proxy.
  // An anchored regex avoids the homepage ("/") and prefix over-matching that a
  // plain CONTAINS would cause.
  let refRegex = null;
  try {
    const u = new URL(pageUrl);
    const refHost = u.hostname.replace(/^www\./, '');
    const refPath = u.pathname.replace(/\/+$/, '');         // ignore a trailing slash
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    refRegex = `^https?://(www\\.)?${esc(refHost)}${esc(refPath)}/?([?#].*)?$`;
  } catch { /* non-URL page — next-pages stays empty */ }

  let tsData, totalsData, channelsData, nextData, entData;
  try {
    [tsData, totalsData, channelsData, nextData, entData] = await Promise.all([
      gaRunReport(accessToken, property, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'date' }],
        metrics,
        ...pageFilter,
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 500
      }),
      gaRunReport(accessToken, property, {
        dateRanges: [{ startDate, endDate }, { startDate: prevStartDate, endDate: prevEndDate }],
        metrics,
        ...pageFilter
      }),
      gaRunReport(accessToken, property, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics,
        ...pageFilter,
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10
      }),
      (refRegex ? gaRunReport(accessToken, property, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensionFilter: { filter: { fieldName: 'pageReferrer', stringFilter: { matchType: 'FULL_REGEXP', value: refRegex, caseSensitive: false } } },
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10
      }) : Promise.resolve({ rows: [] })).catch(() => ({ rows: [] })),   // best-effort; never fail the whole load
      gaFetchEntrances(accessToken, property, path, { startDate, endDate, prevStartDate, prevEndDate })
    ]);
  } catch (err) {
    if (err.code === 'RATE_LIMITED') return { connected: true, error: 'RATE_LIMITED' };
    return { connected: true, error: err.code || 'API_ERROR', detail: err.detail };
  }

  // date dimension arrives as YYYYMMDD
  const timeseries = (tsData.rows || []).map(row => ({
    date: row.dimensionValues[0].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    ...gaParseMetricRow(row)
  }));

  // With two dateRanges the API adds a dateRange dimension to each row
  let totals = gaEmptyMetrics();
  let previousTotals = gaEmptyMetrics();
  (totalsData.rows || []).forEach(row => {
    const which = row.dimensionValues?.[0]?.value;
    if (which === 'date_range_1') previousTotals = gaParseMetricRow(row);
    else totals = gaParseMetricRow(row);
  });
  totals.entrances = entData.current;
  previousTotals.entrances = entData.previous;

  const channels = (channelsData.rows || []).map(row => ({
    channel: row.dimensionValues[0].value,
    ...gaParseMetricRow(row)
  }));

  // Top destinations that came from this page (exclude self), top 5
  const nextPages = (nextData.rows || [])
    .map(row => ({
      path: row.dimensionValues[0].value,
      title: row.dimensionValues[1].value,
      pageviews: Number(row.metricValues[0].value || 0)
    }))
    .filter(p => p.path !== path)
    .slice(0, 5);

  const { gaProperties } = await browser.storage.local.get('gaProperties');
  const propertyName = gaProperties?.properties?.find(p => p.property === property)?.displayName || property;

  const entry = { fetchedAt: Date.now(), property, propertyName, range, path, timeseries, totals, previousTotals, channels, nextPages };
  cache[cacheKey] = entry;
  await gscPruneCache(cache);
  await browser.storage.local.set({ gaCache: cache });

  return { connected: true, ...entry, fromCache: false };
}

// Re-run the page's traffic for a single channel (chart + scorecards filter).
// Not cached — it's on-demand when the user clicks a channel row.
async function gaGetChannelData({ pageUrl, range, channel }) {
  const tokenResult = await gaGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const host = gscPageHost(pageUrl);
  const property = await gaGetProperty(host);
  if (!property) return { connected: true, error: 'NO_PROPERTY', host };

  let path = '/';
  try { path = new URL(pageUrl).pathname; } catch { /* keep root */ }

  const { startDate, endDate, prevStartDate, prevEndDate } = gaDateRanges(range);
  const metrics = GA_METRIC_NAMES.map(name => ({ name }));
  const filter = {
    dimensionFilter: { andGroup: { expressions: [
      { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: path } } },
      { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: channel } } }
    ] } }
  };

  let tsData, totalsData, entData;
  try {
    [tsData, totalsData, entData] = await Promise.all([
      gaRunReport(accessToken, property, {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'date' }],
        metrics, ...filter,
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 500
      }),
      gaRunReport(accessToken, property, {
        dateRanges: [{ startDate, endDate }, { startDate: prevStartDate, endDate: prevEndDate }],
        metrics, ...filter
      }),
      gaFetchEntrances(accessToken, property, path, { startDate, endDate, prevStartDate, prevEndDate }, channel)
    ]);
  } catch (err) {
    if (err.code === 'RATE_LIMITED') return { connected: true, error: 'RATE_LIMITED' };
    return { connected: true, error: err.code || 'API_ERROR', detail: err.detail };
  }

  const timeseries = (tsData.rows || []).map(row => ({
    date: row.dimensionValues[0].value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    ...gaParseMetricRow(row)
  }));

  let totals = gaEmptyMetrics();
  let previousTotals = gaEmptyMetrics();
  (totalsData.rows || []).forEach(row => {
    const which = row.dimensionValues?.[0]?.value;
    if (which === 'date_range_1') previousTotals = gaParseMetricRow(row);
    else totals = gaParseMetricRow(row);
  });
  totals.entrances = entData.current;
  previousTotals.entrances = entData.previous;

  return { connected: true, timeseries, totals, previousTotals };
}

// ─── Domain age (RDAP) ────────────────────────────────────────────────────────
// rdap.org bootstraps to the registry's RDAP server — free, structured JSON,
// no key. Cached 30 days; registration dates don't move.

const DOMAIN_AGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function getDomainAge({ host }) {
  if (!host) return { error: 'NO_HOST' };
  const clean = host.replace(/^www\./, '').toLowerCase();

  const { domainAgeCache } = await browser.storage.local.get('domainAgeCache');
  const cache = domainAgeCache || {};
  const cached = cache[clean];
  if (cached && (Date.now() - cached.fetchedAt < DOMAIN_AGE_TTL_MS)) return cached;

  // Try the full host, then strip subdomain labels until RDAP recognizes it
  // (api.shop.example.com → shop.example.com → example.com)
  const labels = clean.split('.');
  let result = null;
  for (let i = 0; i <= labels.length - 2 && i < 3; i++) {
    const candidate = labels.slice(i).join('.');
    try {
      const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(candidate)}`, {
        headers: { Accept: 'application/rdap+json, application/json' }
      });
      if (res.status === 404) continue;
      if (!res.ok) break;
      const data = await res.json();
      const reg = (data.events || []).find(e => e.eventAction === 'registration');
      const exp = (data.events || []).find(e => e.eventAction === 'expiration');
      const registrar = (data.entities || []).find(e => (e.roles || []).includes('registrar'));
      result = {
        domain: candidate,
        registered: reg ? reg.eventDate : null,
        expires: exp ? exp.eventDate : null,
        registrar: registrar?.vcardArray?.[1]?.find(f => f[0] === 'fn')?.[3] || null
      };
      break;
    } catch { break; }
  }

  if (!result || !result.registered) return { error: 'NOT_FOUND', domain: clean };

  const entry = { ...result, fetchedAt: Date.now() };
  cache[clean] = entry;
  const keys = Object.keys(cache);
  if (keys.length > 30) {
    keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
    keys.slice(0, keys.length - 30).forEach(k => delete cache[k]);
  }
  await browser.storage.local.set({ domainAgeCache: cache });
  return entry;
}

// ─── DNS records (Google Public DNS over HTTPS) ───────────────────────────────

const DNS_TYPE_CODES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, NS: 2, TXT: 16 };
const DNS_TTL_MS = 60 * 60 * 1000;

async function dnsResolve({ host }) {
  if (!host) return { error: 'NO_HOST' };
  const clean = host.toLowerCase();

  const { dnsCache } = await browser.storage.local.get('dnsCache');
  const cache = dnsCache || {};
  const cached = cache[clean];
  if (cached && (Date.now() - cached.fetchedAt < DNS_TTL_MS)) return cached;

  const records = {};
  try {
    await Promise.all(Object.keys(DNS_TYPE_CODES).map(async type => {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(clean)}&type=${type}`, {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) { records[type] = []; return; }
      const data = await res.json();
      records[type] = (data.Answer || [])
        .filter(a => a.type === DNS_TYPE_CODES[type])
        .map(a => ({ data: a.data, ttl: a.TTL }));
    }));
  } catch {
    return { error: 'NETWORK' };
  }

  const entry = { host: clean, records, fetchedAt: Date.now() };
  cache[clean] = entry;
  const keys = Object.keys(cache);
  if (keys.length > 20) {
    keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
    keys.slice(0, keys.length - 20).forEach(k => delete cache[k]);
  }
  await browser.storage.local.set({ dnsCache: cache });
  return entry;
}

// ─── Favicon: live reachability check + site-scoped cache "torch" ─────────────

const FAVICON_FETCH_TIMEOUT_MS = 8000;

// Read the intrinsic width/height out of raw SVG markup (width/height attrs, or
// the viewBox as a fallback). Returns null when the SVG is purely scalable.
function faviconSvgDimensions(text) {
  const tag = (text || '').match(/<svg[^>]*>/i);
  if (!tag) return null;
  const s = tag[0];
  const w = s.match(/\bwidth\s*=\s*["']?\s*([\d.]+)/i);
  const h = s.match(/\bheight\s*=\s*["']?\s*([\d.]+)/i);
  if (w && h) return { width: Math.round(+w[1]), height: Math.round(+h[1]) };
  const vb = s.match(/viewBox\s*=\s*["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/i);
  if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]) };
  return null;
}

// Parse a raw .ico file's ICONDIR to list every embedded image's pixel size.
// ICO is a simple binary container (no library needed): a 6-byte header
// (reserved, type, count) followed by `count` 16-byte directory entries whose
// first two bytes are width/height (0 means 256, per the spec).
function faviconIcoSizes(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 6 || view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return [];
    const count = view.getUint16(4, true);
    const sizes = [];
    for (let i = 0; i < count && 6 + i * 16 + 2 <= view.byteLength; i++) {
      const off = 6 + i * 16;
      const w = view.getUint8(off) || 256;
      const h = view.getUint8(off + 1) || 256;
      sizes.push({ width: w, height: h });
    }
    return sizes;
  } catch { return []; }
}

// Fetch one URL and report status, whether it's a real image, its actual pixel
// dimensions, and (for .ico files) every size embedded in the container. Never
// throws.
async function faviconProbe(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FAVICON_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: abort.signal });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isSvg = /svg/.test(contentType) || /\.svg(\?|$)/i.test(url);
    const isIco = !isSvg && (/\.ico(\?|$)/i.test(url) || /(^|[/.\s-])icon\b|vnd\.microsoft\.icon/.test(contentType));
    const isImage = /^\s*image\//.test(contentType) || isIco;
    const out = { url, ok: res.ok, status: res.status, contentType, isImage, width: null, height: null, scalable: false, icoSizes: null };

    if (res.ok) {
      try {
        if (isSvg) {
          out.scalable = true;
          const dims = faviconSvgDimensions(await res.text());
          if (dims) { out.width = dims.width; out.height = dims.height; }
        } else {
          const buf = await res.arrayBuffer();
          if (isIco) {
            const sizes = faviconIcoSizes(buf);
            if (sizes.length) {
              out.icoSizes = sizes;
              const largest = sizes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
              out.width = largest.width; out.height = largest.height;
            }
          }
          if (!out.width) {
            const bmp = await createImageBitmap(new Blob([buf], { type: contentType || 'image/x-icon' }));
            out.width = bmp.width; out.height = bmp.height;
            bmp.close();
          }
        }
      } catch { /* measurement failed — status/type still reported */ }
    }
    return out;
  } catch (err) {
    return { url, ok: false, status: 0, contentType: '', isImage: false, width: null, height: null, scalable: false, icoSizes: null, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Link health overlay: check many links' destination status ───────────────
// The content-script overlay sends every unique on-page http(s) link here; we
// fetch each from the background (page CORS can't read cross-origin status, but
// the *://*/* host permission lets us) and report whether it redirects or is
// broken. Lightweight: HEAD with redirect:follow gives the FINAL status +
// Response.redirected + Response.url without downloading a body; deeper hop
// tracing already lives in the Redirect tab (traceUrl).
const LINK_CHECK_TIMEOUT_MS = 8000;
const LINK_CHECK_CONCURRENCY = 6;    // small pool — a page can have 100+ links
const LINK_CHECK_MAX = 300;          // cap per request
const LINK_CACHE_TTL_MS = 5 * 60 * 1000;
const linkStatusCache = new Map();   // url -> { status, redirected, finalUrl, error, fetchedAt }

// Bounded-concurrency map: run `worker` over `items`, at most `limit` at a time.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// Probe one URL's final status. Never throws. HEAD first (no body); fall back
// to GET when HEAD is rejected (405/501) or errors, cancelling the body stream
// as soon as the status is read.
async function probeLinkStatus(url) {
  const cached = linkStatusCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < LINK_CACHE_TTL_MS) {
    return { status: cached.status, redirected: cached.redirected, finalUrl: cached.finalUrl, error: cached.error };
  }

  const attempt = async (method) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LINK_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: abort.signal });
      if (method === 'GET') { try { await res.body?.cancel(); } catch { /* ignore */ } }
      return { status: res.status, redirected: res.redirected, finalUrl: res.url || url, error: null };
    } catch (err) {
      return { status: 0, redirected: false, finalUrl: url, error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  };

  let out = await attempt('HEAD');
  // Many servers reject HEAD (405/501) or mishandle it — retry with GET.
  if (out.status === 405 || out.status === 501 || out.status === 0) {
    const viaGet = await attempt('GET');
    if (viaGet.status !== 0) out = viaGet;      // keep GET only if it actually got a status
    else if (out.status === 0) out = viaGet;    // both failed — report the GET error
  }

  linkStatusCache.set(url, { ...out, fetchedAt: Date.now() });
  if (linkStatusCache.size > 1000) {
    const oldest = [...linkStatusCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt).slice(0, linkStatusCache.size - 1000);
    oldest.forEach(([k]) => linkStatusCache.delete(k));
  }
  return out;
}

async function checkLinkStatuses({ urls }) {
  const list = [...new Set((urls || []).filter(u => /^https?:\/\//i.test(u)))].slice(0, LINK_CHECK_MAX);
  const probed = await runPool(list, LINK_CHECK_CONCURRENCY, probeLinkStatus);
  const results = {};
  list.forEach((u, i) => { results[u] = probed[i]; });
  return { results };
}

// Live-check every declared icon URL (+ the legacy /favicon.ico) and parse the
// web app manifest for its icon set. All best-effort; a failed fetch just
// reports status 0.
async function validateFavicon({ icons, manifestHref, defaultIcoUrl }) {
  const urls = [];
  (icons || []).forEach(i => { if (i && i.href && !urls.includes(i.href)) urls.push(i.href); });
  if (defaultIcoUrl && !urls.includes(defaultIcoUrl)) urls.push(defaultIcoUrl);

  const probes = await Promise.all(urls.map(u => faviconProbe(u)));
  const results = {};
  probes.forEach(p => { results[p.url] = p; });

  let manifest = null;
  if (manifestHref) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FAVICON_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(manifestHref, { cache: 'no-store', credentials: 'omit', signal: abort.signal });
      if (res.ok) {
        const m = await res.json();
        const micons = (Array.isArray(m.icons) ? m.icons : []).map(ic => {
          let href = '';
          try { href = new URL(ic.src, manifestHref).href; } catch { href = ic.src || ''; }
          const sizes = String(ic.sizes || '').trim().toLowerCase();
          return { href, sizes, type: String(ic.type || '').trim().toLowerCase() };
        });
        const hasSize = (dim) => micons.some(ic => ic.sizes.split(/\s+/).includes(dim));
        manifest = {
          ok: true, icons: micons, has192: hasSize('192x192'), has512: hasSize('512x512'),
          name: (m.name || '').trim() || null,
          shortName: (m.short_name || '').trim() || null,
          backgroundColor: (m.background_color || '').trim() || null,
          themeColor: (m.theme_color || '').trim() || null
        };
      } else {
        manifest = { ok: false, icons: [], has192: false, has512: false, status: res.status };
      }
    } catch (err) {
      manifest = { ok: false, icons: [], has192: false, has512: false, error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { results, manifest };
}

// "Torch" this site's favicon: re-fetch each favicon URL with cache:'reload' so
// the browser replaces exactly those HTTP-cache entries with fresh copies
// (site-scoped — other sites are untouched), then hard-reload the tab bypassing
// cache so Firefox re-requests and re-paints the new favicon. Uses only fetch +
// tabs, so no browsingData permission is required.
async function clearFaviconCache({ tabId, urls }) {
  await Promise.all((urls || []).map(u =>
    fetch(u, { cache: 'reload', credentials: 'omit' }).catch(() => {})
  ));
  if (tabId != null) {
    try { await browser.tabs.reload(tabId, { bypassCache: true }); } catch { /* tab gone — ignore */ }
  }
  return { ok: true };
}

// ─── Google Ads (GAQL) ────────────────────────────────────────────────────────
// Needs an OAuth grant (scope adwords), a developer token (from the Ads account
// API Center, approved by Google for production data), and — for MCC setups —
// the manager account's login-customer-id. Customer IDs are 10 digits, no dashes.

// Bump as Google sunsets versions (~1yr each). A 404 on every call usually
// means this version is no longer served.
const GA_ADS_API = 'https://googleads.googleapis.com/v21';
const ADS_ACCOUNTS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const ADS_STALE_MS = 6 * 60 * 60 * 1000;
const ADS_DEBOUNCE_MS = 60 * 1000;
const ADS_SEARCH_TERM_LIMIT = 25;        // initial top-N search terms; "Request More" pulls the rest
const ADS_SEARCH_TERM_MAX = 200;

function adsDigits(id) { return String(id || '').replace(/\D/g, ''); }

async function adsGetStatus() {
  const { adsAuth, adsDeveloperToken, adsManagerId } = await browser.storage.local.get(['adsAuth', 'adsDeveloperToken', 'adsManagerId']);
  return {
    connected: !!adsAuth,
    hasDevToken: !!adsDeveloperToken,
    managerId: adsManagerId || null,
    redirectUri: getGoogleRedirectUri(),
    connectedAt: adsAuth?.connectedAt ?? null,
    email: adsAuth ? await googleEnsureEmail('adsAuth') : null
  };
}

function adsConnect() {
  return googleOAuthConnectRequireScope('https://www.googleapis.com/auth/adwords', 'adsAuth', 'ADS_SCOPE_MISSING');
}

function adsDisconnect() {
  return googleDisconnect('adsAuth', ['adsAccounts', 'adsCache', 'adsAccountOverrides']);
}

function adsGetAccessToken() {
  return googleGetAccessToken('adsAuth');
}

// One GAQL request via searchStream (returns concatenated result rows)
async function adsSearch(accessToken, customerId, query) {
  const { adsDeveloperToken, adsManagerId } = await browser.storage.local.get(['adsDeveloperToken', 'adsManagerId']);
  if (!adsDeveloperToken) return { error: 'NO_DEV_TOKEN' };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': adsDeveloperToken,
    'Content-Type': 'application/json'
  };
  if (adsManagerId) headers['login-customer-id'] = adsDigits(adsManagerId);

  let res;
  try {
    res = await fetch(`${GA_ADS_API}/customers/${adsDigits(customerId)}/googleAds:searchStream`, {
      method: 'POST', headers, body: JSON.stringify({ query })
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (res.status === 429) return { error: 'RATE_LIMITED' };
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = (Array.isArray(body) ? body[0] : body)?.error?.message;
    return { error: 'API_ERROR', detail: msg || `HTTP ${res.status}` };
  }
  const data = await res.json();
  // searchStream returns an array of {results:[...]} batches
  const rows = [];
  (Array.isArray(data) ? data : [data]).forEach(batch => {
    (batch.results || []).forEach(r => rows.push(r));
  });
  return { rows };
}

// One mutate request to a resource-specific :mutate endpoint (sharedSets,
// campaignSharedSets, sharedCriteria, …). Mirrors adsSearch's headers + error
// handling. Returns { results:[{resourceName}] } or { error, detail }.
async function adsMutate(accessToken, customerId, resource, operations) {
  const { adsDeveloperToken, adsManagerId } = await browser.storage.local.get(['adsDeveloperToken', 'adsManagerId']);
  if (!adsDeveloperToken) return { error: 'NO_DEV_TOKEN' };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': adsDeveloperToken,
    'Content-Type': 'application/json'
  };
  if (adsManagerId) headers['login-customer-id'] = adsDigits(adsManagerId);

  let res;
  try {
    res = await fetch(`${GA_ADS_API}/customers/${adsDigits(customerId)}/${resource}:mutate`, {
      method: 'POST', headers, body: JSON.stringify({ operations })
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (res.status === 429) return { error: 'RATE_LIMITED' };
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = (Array.isArray(body) ? body[0] : body)?.error?.message;
    return { error: 'API_ERROR', detail: msg || `HTTP ${res.status}` };
  }
  const data = await res.json();
  return { results: data.results || [] };
}

// Accessible accounts. With a manager ID, list its client accounts (id + name);
// otherwise fall back to the bare accessible-customers id list.
async function adsListAccounts(accessToken) {
  const { adsAccounts, adsManagerId, adsDeveloperToken } = await browser.storage.local.get(['adsAccounts', 'adsManagerId', 'adsDeveloperToken']);
  if (adsAccounts && (Date.now() - adsAccounts.fetchedAt < ADS_ACCOUNTS_STALE_MS)) return { accounts: adsAccounts.accounts };
  if (!adsDeveloperToken) return { error: 'NO_DEV_TOKEN' };

  let accounts = [];
  if (adsManagerId) {
    const res = await adsSearch(accessToken, adsManagerId,
      'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code FROM customer_client WHERE customer_client.level <= 1');
    if (res.error) return res;
    accounts = (res.rows || [])
      .map(r => r.customerClient)
      .filter(c => c && !c.manager)
      .map(c => ({ id: adsDigits(c.id), name: c.descriptiveName || `Account ${c.id}`, currency: c.currencyCode || '' }));
  } else {
    let res;
    try {
      res = await fetch(`${GA_ADS_API}/customers:listAccessibleCustomers`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'developer-token': adsDeveloperToken }
      });
    } catch { return { error: 'NETWORK' }; }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { error: 'API_ERROR', detail: body?.error?.message || `HTTP ${res.status}` };
    }
    const data = await res.json();
    accounts = (data.resourceNames || []).map(rn => {
      const id = adsDigits(rn.split('/').pop());
      return { id, name: `Account ${id}`, currency: '' };
    });
  }
  await browser.storage.local.set({ adsAccounts: { fetchedAt: Date.now(), accounts } });
  return { accounts };
}

async function adsGetAccount(host) {
  if (!host) return null;
  const { adsAccountOverrides } = await browser.storage.local.get('adsAccountOverrides');
  return (adsAccountOverrides && adsAccountOverrides[host]) || null;
}

async function adsResolveAccount({ pageUrl }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };

  const listed = await adsListAccounts(tokenResult.accessToken);
  if (listed.error) return { connected: true, error: listed.error, detail: listed.detail };

  const host = gscPageHost(pageUrl);
  const chosen = await adsGetAccount(host);
  const account = (chosen && listed.accounts.some(a => a.id === chosen)) ? chosen : null;
  return { connected: true, host, account, accounts: listed.accounts };
}

async function adsSetAccount({ host, account }) {
  if (!host) return { ok: false };
  const { adsAccountOverrides } = await browser.storage.local.get('adsAccountOverrides');
  const overrides = adsAccountOverrides || {};
  if (account) overrides[host] = adsDigits(account); else delete overrides[host];
  await browser.storage.local.set({ adsAccountOverrides: overrides });
  const { adsCache } = await browser.storage.local.get('adsCache');
  if (adsCache) {
    let mutated = false;
    for (const k of Object.keys(adsCache)) { if (k.startsWith(`${host}::`)) { delete adsCache[k]; mutated = true; } }
    if (mutated) await browser.storage.local.set({ adsCache });
  }
  return { ok: true };
}

// GAQL date range (Ads data is ~current; end = yesterday to be safe)
function adsDateRange(range) {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - (range - 1));
  const prevEnd = new Date(start); prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setUTCDate(prevStart.getUTCDate() - (range - 1));
  return {
    startDate: gscFormatDate(start), endDate: gscFormatDate(end),
    prevStartDate: gscFormatDate(prevStart), prevEndDate: gscFormatDate(prevEnd)
  };
}

// Fill a per-day timeseries across the range (zeroes for missing days), ordered
function adsFillTimeseries(byDate, range) {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const out = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(end); d.setUTCDate(d.getUTCDate() - i);
    const key = gscFormatDate(d);
    out.push(byDate[key] || { date: key, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
  }
  return out;
}

function adsSumMetrics(rows) {
  const t = { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
  rows.forEach(r => { const m = adsMetrics(r.metrics); t.impressions += m.impressions; t.clicks += m.clicks; t.cost += m.cost; t.conversions += m.conversions; });
  return t;
}

function adsMetrics(m) {
  m = m || {};
  return {
    impressions: Number(m.impressions || 0),
    clicks: Number(m.clicks || 0),
    cost: Number(m.costMicros || 0) / 1e6,
    conversions: Number(m.conversions || 0)
  };
}

// Normalize a URL to origin+path (lowercased, no trailing slash) for matching
function adsNormUrl(u) {
  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase(); }
  catch { return (u || '').replace(/\/$/, '').toLowerCase(); }
}

async function adsGetPageData({ pageUrl, range, forceRefresh }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const { adsDeveloperToken } = await browser.storage.local.get('adsDeveloperToken');
  if (!adsDeveloperToken) return { connected: true, error: 'NO_DEV_TOKEN' };

  const host = gscPageHost(pageUrl);
  const customerId = await adsGetAccount(host);
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT', host };

  let path = '/';
  try { path = new URL(pageUrl).pathname; } catch { /* root */ }
  const target = adsNormUrl(pageUrl);

  const cacheKey = `${host}::${path}::${range}`;
  const { adsCache } = await browser.storage.local.get('adsCache');
  const cache = adsCache || {};
  const cached = cache[cacheKey];
  const isStale = !cached || cached.account !== customerId || (Date.now() - cached.fetchedAt > ADS_STALE_MS);
  const withinDebounce = cached && (Date.now() - cached.fetchedAt < ADS_DEBOUNCE_MS);
  if (cached && cached.account === customerId && ((!forceRefresh && !isStale) || (forceRefresh && withinDebounce))) {
    return { connected: true, ...cached, fromCache: true };
  }

  const { startDate, endDate, prevStartDate, prevEndDate } = adsDateRange(range);
  const dateWhere = `segments.date BETWEEN '${startDate}' AND '${endDate}'`;
  const prevWhere = `segments.date BETWEEN '${prevStartDate}' AND '${prevEndDate}'`;

  // 1) Ads + their final URLs/metrics, filtered client-side to this page
  const adRes = await adsSearch(accessToken, customerId,
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group_ad.ad.id, ad_group_ad.ad.name,
            ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.status,
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
     FROM ad_group_ad WHERE ${dateWhere} AND ad_group_ad.status != 'REMOVED'`);
  if (adRes.error) return { connected: true, error: adRes.error, detail: adRes.detail };

  const ads = [];
  const adGroupIds = new Set();
  const campaignIds = new Set();
  (adRes.rows || []).forEach(r => {
    const urls = (r.adGroupAd?.ad?.finalUrls) || [];
    if (!urls.some(u => adsNormUrl(u) === target)) return;
    adGroupIds.add(String(r.adGroup.id));
    campaignIds.add(String(r.campaign.id));
    ads.push({
      campaignId: String(r.campaign.id), campaign: r.campaign.name,
      adGroupId: String(r.adGroup.id), adGroup: r.adGroup.name, adGroupStatus: r.adGroup?.status || null,
      adId: String(r.adGroupAd.ad.id), adName: r.adGroupAd.ad.name || '',
      type: r.adGroupAd.ad.type || '', finalUrls: urls,
      ...adsMetrics(r.metrics)
    });
  });

  if (!ads.length) {
    const entry = { fetchedAt: Date.now(), account: customerId, range, path, ads: [], campaigns: [], keywords: [], searchTerms: [], timeseries: [], totals: null, previousTotals: null, currency: '', adGroupImpressionShare: {} };
    cache[cacheKey] = entry; await gscPruneCache(cache); await browser.storage.local.set({ adsCache: cache });
    return { connected: true, ...entry, fromCache: false };
  }

  const agList = `(${[...adGroupIds].join(',')})`;
  const campList = `(${[...campaignIds].join(',')})`;

  // 2) campaign IS, 3) keywords (+QS, ids), 4) search terms (+triggering keyword),
  // 5) daily timeseries per ad group, 6) previous-period totals, 7) ad-group-level IS
  // (unverified field support — adsSearch never throws, so a rejection just yields
  // an empty rows array and the feature silently no-ops), + currency
  const [campRes, kwRes, stRes, tsRes, prevRes, agIsRes, custRes] = await Promise.all([
    adsSearch(accessToken, customerId,
      `SELECT campaign.id, campaign.name, campaign.status, metrics.search_impression_share,
              metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
       FROM campaign WHERE ${dateWhere} AND campaign.id IN ${campList}`),
    adsSearch(accessToken, customerId,
      `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
              ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score,
              ad_group_criterion.quality_info.creative_quality_score,
              ad_group_criterion.quality_info.post_click_quality_score,
              ad_group_criterion.quality_info.search_predicted_ctr,
              metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM keyword_view WHERE ${dateWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId,
      `SELECT search_term_view.search_term, ad_group.id, segments.keyword.info.text,
              metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM search_term_view WHERE ${dateWhere} AND ad_group.id IN ${agList}
       ORDER BY metrics.impressions DESC LIMIT ${ADS_SEARCH_TERM_LIMIT}`),
    adsSearch(accessToken, customerId,
      `SELECT segments.date, ad_group.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM ad_group WHERE ${dateWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId,
      `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM ad_group WHERE ${prevWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId,
      `SELECT ad_group.id, metrics.search_impression_share,
              metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
       FROM ad_group WHERE ${dateWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId, 'SELECT customer.currency_code FROM customer LIMIT 1')
  ]);

  const campaigns = (campRes.rows || []).map(r => ({
    id: String(r.campaign.id), name: r.campaign.name,
    status: r.campaign?.status || null,
    impressionShare: r.metrics?.searchImpressionShare ?? null,
    lostBudget: r.metrics?.searchBudgetLostImpressionShare ?? null,
    lostRank: r.metrics?.searchRankLostImpressionShare ?? null
  }));
  const keywords = (kwRes.rows || []).map(r => ({
    text: r.adGroupCriterion?.keyword?.text || '',
    matchType: r.adGroupCriterion?.keyword?.matchType || '',
    qualityScore:         r.adGroupCriterion?.qualityInfo?.qualityScore         ?? null,
    creativeQualityScore:  r.adGroupCriterion?.qualityInfo?.creativeQualityScore  ?? null,
    postClickQualityScore: r.adGroupCriterion?.qualityInfo?.postClickQualityScore ?? null,
    searchPredictedCtr:    r.adGroupCriterion?.qualityInfo?.searchPredictedCtr    ?? null,
    adGroupId: String(r.adGroup?.id || ''),
    criterionId: String(r.adGroupCriterion?.criterionId || ''),
    ...adsMetrics(r.metrics)
  }));
  const searchTerms = (stRes.rows || []).map(r => ({
    text: r.searchTermView?.searchTerm || '',
    adGroupId: String(r.adGroup?.id || ''),
    keyword: r.segments?.keyword?.info?.text || '',
    ...adsMetrics(r.metrics)
  }));

  // Ad-group-level impression share — not exposed in the UI yet; consumed by the
  // Action Plan for page-specific (not campaign-wide) IS guidance. agIsRes.error
  // means Google rejected the field at this resource level; rows is then empty
  // and adGroupImpressionShare stays {} (graceful no-op, not a thrown error).
  const adGroupImpressionShare = {};
  (agIsRes.rows || []).forEach(r => {
    const id = String(r.adGroup?.id || '');
    if (!id) return;
    adGroupImpressionShare[id] = {
      impressionShare: r.metrics?.searchImpressionShare ?? null,
      lostBudget: r.metrics?.searchBudgetLostImpressionShare ?? null,
      lostRank: r.metrics?.searchRankLostImpressionShare ?? null
    };
  });

  // Per-ad-group daily rows → keep adGroupId so the popup can filter the chart
  // to one ad group client-side; the default chart sums all serving ad groups.
  const tsRows = (tsRes.rows || []).map(r => ({
    date: r.segments?.date, adGroupId: String(r.adGroup?.id || ''), ...adsMetrics(r.metrics)
  }));
  const byDate = {};
  tsRows.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date, impressions: 0, clicks: 0, cost: 0, conversions: 0 };
    byDate[r.date].impressions += r.impressions; byDate[r.date].clicks += r.clicks;
    byDate[r.date].cost += r.cost; byDate[r.date].conversions += r.conversions;
  });
  const timeseries = adsFillTimeseries(byDate, range);
  const totals = adsSumMetrics(tsRes.rows || []);
  const previousTotals = adsSumMetrics(prevRes.rows || []);
  const currency = custRes.rows?.[0]?.customer?.currencyCode || '';

  // True when the search-term query hit the cap — the popup offers "Request More"
  const searchTermsLimited = (stRes.rows || []).length >= ADS_SEARCH_TERM_LIMIT;

  const entry = { fetchedAt: Date.now(), account: customerId, range, path, ads, campaigns, keywords, searchTerms, searchTermsLimited, tsRows, timeseries, totals, previousTotals, currency, adGroupImpressionShare };
  cache[cacheKey] = entry; await gscPruneCache(cache); await browser.storage.local.set({ adsCache: cache });
  return { connected: true, ...entry, fromCache: false };
}

// "Request More" search terms: re-query the page's serving ad groups for the
// full top-N list (the initial page fetch caps at ADS_SEARCH_TERM_LIMIT).
async function adsGetMoreSearchTerms({ pageUrl, range }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error) return { error: tokenResult.error };
  const accessToken = tokenResult.accessToken;
  const host = gscPageHost(pageUrl);
  const customerId = await adsGetAccount(host);
  if (!customerId) return { error: 'NO_ACCOUNT' };

  // Serving ad-group ids for this page come from the cached page data
  let path = '/';
  try { path = new URL(pageUrl).pathname; } catch { /* root */ }
  const { adsCache } = await browser.storage.local.get('adsCache');
  const cached = (adsCache || {})[`${host}::${path}::${range}`];
  const adGroupIds = [...new Set((cached?.ads || []).map(a => a.adGroupId).filter(Boolean))];
  if (!adGroupIds.length) return { error: 'NO_ACCOUNT' };

  const { startDate, endDate } = adsDateRange(range);
  const res = await adsSearch(accessToken, customerId,
    `SELECT search_term_view.search_term, ad_group.id, segments.keyword.info.text,
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
     FROM search_term_view WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
     AND ad_group.id IN (${adGroupIds.join(',')})
     ORDER BY metrics.impressions DESC LIMIT ${ADS_SEARCH_TERM_MAX}`);
  if (res.error) return { error: res.error, detail: res.detail };
  const searchTerms = (res.rows || []).map(r => ({
    text: r.searchTermView?.searchTerm || '',
    adGroupId: String(r.adGroup?.id || ''),
    keyword: r.segments?.keyword?.info?.text || '',
    ...adsMetrics(r.metrics)
  }));

  // Update the cache so the expanded set survives a re-render
  if (cached) {
    cached.searchTerms = searchTerms;
    cached.searchTermsLimited = searchTerms.length >= ADS_SEARCH_TERM_MAX;
    await browser.storage.local.set({ adsCache });
  }
  return { searchTerms, searchTermsLimited: searchTerms.length >= ADS_SEARCH_TERM_MAX };
}

// Scoped daily timeseries for the chart when a keyword or search term is
// selected (ad-group scope is handled client-side from tsRows).
async function adsGetChartData({ pageUrl, range, scope }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error) return { error: tokenResult.error };
  const accessToken = tokenResult.accessToken;
  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { error: 'NO_ACCOUNT' };

  const { startDate, endDate } = adsDateRange(range);
  const dateWhere = `segments.date BETWEEN '${startDate}' AND '${endDate}'`;
  const esc = s => String(s).replace(/'/g, "\\'");

  let query;
  if (scope && scope.type === 'keyword' && scope.criterionId && scope.adGroupId) {
    query = `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
             FROM keyword_view WHERE ${dateWhere} AND ad_group.id = ${scope.adGroupId}
             AND ad_group_criterion.criterion_id = ${scope.criterionId}`;
  } else if (scope && scope.type === 'searchTerm' && scope.text) {
    query = `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
             FROM search_term_view WHERE ${dateWhere} AND search_term_view.search_term = '${esc(scope.text)}'`;
  } else {
    return { error: 'BAD_SCOPE' };
  }

  const res = await adsSearch(accessToken, customerId, query);
  if (res.error) return { error: res.error, detail: res.detail };
  const byDate = {};
  (res.rows || []).forEach(r => {
    const d = r.segments?.date; if (!d) return;
    const m = adsMetrics(r.metrics);
    if (!byDate[d]) byDate[d] = { date: d, impressions: 0, clicks: 0, cost: 0, conversions: 0 };
    byDate[d].impressions += m.impressions; byDate[d].clicks += m.clicks; byDate[d].cost += m.cost; byDate[d].conversions += m.conversions;
  });
  return { timeseries: adsFillTimeseries(byDate, range), totals: adsSumMetrics(res.rows || []) };
}

// Creative (RSA headlines/descriptions, with pinning) for one or more ads, plus
// each text asset's performance rating. Google does not expose per-asset
// impressions/clicks for RSAs — the performance_label (LOW/GOOD/BEST/LEARNING/
// PENDING) is the signal. Returns { ads: { [adId]: {type,name,headlines,descriptions} } }.
async function adsGetAdsDetail({ pageUrl, adIds }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error) return { error: tokenResult.error };
  const accessToken = tokenResult.accessToken;
  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { error: 'NO_ACCOUNT' };
  const ids = [...new Set((adIds || []).map(adsDigits).filter(Boolean))];
  if (!ids.length) return { ads: {} };
  const idList = `(${ids.join(',')})`;

  const [creativeRes, assetRes] = await Promise.all([
    adsSearch(accessToken, customerId,
      `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name,
              ad_group_ad.ad.responsive_search_ad.headlines,
              ad_group_ad.ad.responsive_search_ad.descriptions
       FROM ad_group_ad WHERE ad_group_ad.ad.id IN ${idList}`),
    adsSearch(accessToken, customerId,
      `SELECT ad_group_ad.ad.id, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label,
              ad_group_ad_asset_view.enabled, asset.text_asset.text
       FROM ad_group_ad_asset_view WHERE ad_group_ad.ad.id IN ${idList}`)
  ]);
  if (creativeRes.error) return { error: creativeRes.error, detail: creativeRes.detail };

  // Performance label / enabled, keyed adId → (fieldType::text). asset_view is
  // the only place the rating lives; missing labels just render as no badge.
  const labelMap = new Map();
  (assetRes.rows || []).forEach(r => {
    const adId = String(r.adGroupAd?.ad?.id || '');
    const v = r.adGroupAdAssetView;
    const text = r.asset?.textAsset?.text;
    if (!adId || !v || text == null) return;
    if (!labelMap.has(adId)) labelMap.set(adId, new Map());
    labelMap.get(adId).set(`${v.fieldType}::${text}`, { label: v.performanceLabel || null, enabled: v.enabled !== false });
  });

  const ads = {};
  (creativeRes.rows || []).forEach(r => {
    const ad = r.adGroupAd?.ad || {};
    const adId = String(ad.id || '');
    if (!adId) return;
    const rsa = ad.responsiveSearchAd || {};
    const labels = labelMap.get(adId) || new Map();
    const mapAsset = (a, fieldType) => {
      const text = a.text || '';
      const meta = labels.get(`${fieldType}::${text}`) || {};
      return { text, pinned: a.pinnedField || null, label: meta.label || null, enabled: meta.enabled !== false };
    };
    ads[adId] = {
      type: ad.type || '',
      name: ad.name || '',
      headlines: (rsa.headlines || []).map(a => mapAsset(a, 'HEADLINE')),
      descriptions: (rsa.descriptions || []).map(a => mapAsset(a, 'DESCRIPTION'))
    };
  });

  return { ads };
}

// ─── Negative keywords: write campaign-level exclusion lists ──────────────────
// For each campaign, push the chosen terms into a NEGATIVE_KEYWORDS shared set
// (exclusion list): reuse an attached list, else create one + attach it, then add
// the terms (deduped against what's already there). Campaign-level only.

const NEG_MATCH_TYPES = new Set(['BROAD', 'PHRASE', 'EXACT']);
function negMatchType(mt) {
  const v = String(mt || 'BROAD').toUpperCase();
  return NEG_MATCH_TYPES.has(v) ? v : 'BROAD';
}

async function adsAddNegativesForCampaign(accessToken, cid, camp) {
  const { campaignId, campaignName, listName, sharedSetId } = camp;
  const out = { campaignId, campaignName, listName: listName || null, added: [], skipped: [], error: null };
  const wanted = (camp.terms || []).filter(t => t && t.text && String(t.text).trim());
  if (!wanted.length) return out;

  // 1) Resolve the destination shared set: explicit id, else first attached
  //    NEGATIVE_KEYWORDS list, else create a new one and attach it.
  let sharedSetResource = sharedSetId ? `customers/${cid}/sharedSets/${adsDigits(sharedSetId)}` : null;

  // Skip the find step when the caller explicitly wants a brand-new list.
  if (!sharedSetResource && !camp.createNew) {
    const found = await adsSearch(accessToken, cid,
      `SELECT shared_set.id, shared_set.name FROM campaign_shared_set
       WHERE campaign.id = ${adsDigits(campaignId)}
         AND shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`);
    if (found.error) { out.error = found.detail || found.error; return out; }
    const existing = (found.rows || [])[0]?.sharedSet;
    if (existing) {
      sharedSetResource = `customers/${cid}/sharedSets/${adsDigits(existing.id)}`;
      out.listName = existing.name || out.listName;
    }
  }

  if (!sharedSetResource) {
    const name = listName || `Campaign - ${campaignName || 'Campaign'}`;
    const created = await adsMutate(accessToken, cid, 'sharedSets',
      [{ create: { name, type: 'NEGATIVE_KEYWORDS' } }]);
    if (created.error) { out.error = created.detail || created.error; return out; }
    sharedSetResource = created.results?.[0]?.resourceName;
    if (!sharedSetResource) { out.error = 'Could not create exclusion list'; return out; }
    out.listName = name;
    const attached = await adsMutate(accessToken, cid, 'campaignSharedSets',
      [{ create: { campaign: `customers/${cid}/campaigns/${adsDigits(campaignId)}`, sharedSet: sharedSetResource } }]);
    if (attached.error) { out.error = attached.detail || attached.error; return out; }
    // Verify the list is actually attached to the campaign before adding keywords.
    const setId = adsDigits(sharedSetResource.split('/').pop());
    const verify = await adsSearch(accessToken, cid,
      `SELECT campaign.id, shared_set.id FROM campaign_shared_set
       WHERE campaign.id = ${adsDigits(campaignId)} AND shared_set.id = ${setId}`);
    if (verify.error || !(verify.rows || []).length) {
      out.error = 'Exclusion list was created but could not verify it is attached to the campaign';
      return out;
    }
  }
  out.sharedSetResource = sharedSetResource;

  // 2) Read existing criteria so we skip duplicates (text + match type)
  const setId = adsDigits(sharedSetResource.split('/').pop());
  const existingRes = await adsSearch(accessToken, cid,
    `SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type
     FROM shared_criterion WHERE shared_set.id = ${setId}`);
  if (existingRes.error) { out.error = existingRes.detail || existingRes.error; return out; }
  const have = new Set((existingRes.rows || []).map(r =>
    `${(r.sharedCriterion?.keyword?.text || '').toLowerCase()}::${r.sharedCriterion?.keyword?.matchType || ''}`));

  // 3) Add the new terms
  const ops = [];
  wanted.forEach(t => {
    const mt = negMatchType(t.matchType);
    const text = String(t.text).trim();
    const key = `${text.toLowerCase()}::${mt}`;
    if (have.has(key)) { out.skipped.push({ text, matchType: mt }); return; }
    have.add(key);
    ops.push({ create: { sharedSet: sharedSetResource, keyword: { text, matchType: mt } } });
    out.added.push({ text, matchType: mt });
  });

  if (ops.length) {
    const addRes = await adsMutate(accessToken, cid, 'sharedCriteria', ops);
    if (addRes.error) { out.error = addRes.detail || addRes.error; out.added = []; return out; }
  }
  return out;
}

// Existing NEGATIVE_KEYWORDS exclusion lists attached to each given campaign, so
// the popup can offer them as destinations. Returns { byCampaign: {id:[{id,name}]} }.
async function adsGetCampaignNegLists({ pageUrl, campaignIds }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error) return { error: tokenResult.error };
  const accessToken = tokenResult.accessToken;
  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { error: 'NO_ACCOUNT' };
  const ids = [...new Set((campaignIds || []).map(adsDigits).filter(Boolean))];
  if (!ids.length) return { byCampaign: {} };

  const res = await adsSearch(accessToken, customerId,
    `SELECT campaign.id, shared_set.id, shared_set.name FROM campaign_shared_set
     WHERE campaign.id IN (${ids.join(',')})
       AND shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`);
  if (res.error) return { error: res.error, detail: res.detail };

  const byCampaign = {};
  (res.rows || []).forEach(r => {
    const cid = String(r.campaign?.id || '');
    const ss = r.sharedSet;
    if (!cid || !ss) return;
    (byCampaign[cid] = byCampaign[cid] || []).push({ id: String(ss.id), name: ss.name || `List ${ss.id}` });
  });
  return { byCampaign };
}

// Every enabled ad group in the resolved account (not just ones already
// serving ads on the current page) — lets the Add Keywords picker offer any
// ad group as a destination, not only the ones already tied to this page.
async function adsGetAllAdGroups({ pageUrl }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT' };
  const cid = adsDigits(customerId);

  const res = await adsSearch(accessToken, cid,
    `SELECT ad_group.id, ad_group.name, campaign.id, campaign.name
     FROM ad_group
     WHERE ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
     ORDER BY campaign.name, ad_group.name`);
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const adGroups = (res.rows || [])
    .map(r => ({
      adGroupId: String(r.adGroup?.id || ''),
      adGroupName: r.adGroup?.name || '',
      campaignId: String(r.campaign?.id || ''),
      campaignName: r.campaign?.name || ''
    }))
    .filter(a => a.adGroupId);

  return { connected: true, adGroups };
}

// Every keyword text already targeted anywhere in the account (not scoped to
// this page's ad groups) — used by the Add Keywords "Potential Blindspots"
// brainstorm to avoid suggesting something that's already covered elsewhere.
async function adsGetAllKeywords({ pageUrl }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT' };
  const cid = adsDigits(customerId);

  const res = await adsSearch(accessToken, cid,
    `SELECT ad_group_criterion.keyword.text
     FROM keyword_view
     WHERE ad_group_criterion.status != 'REMOVED' AND campaign.status = 'ENABLED'`);
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const texts = [...new Set((res.rows || [])
    .map(r => (r.adGroupCriterion?.keyword?.text || '').toLowerCase().trim())
    .filter(Boolean))];

  return { connected: true, texts };
}

async function adsAddNegatives({ pageUrl, campaigns }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT' };
  const cid = adsDigits(customerId);

  const results = [];
  for (const camp of (campaigns || [])) {
    results.push(await adsAddNegativesForCampaign(accessToken, cid, camp));
  }
  return { connected: true, results };
}

// ─── Add Keywords (Keyword Plan Idea Service + adGroupCriteria mutate) ──────
const KW_IDEA_CHUNK = 20; // practical per-request seed-keyword batch size

// A keyword's volume/competition/CPC/trend is page-independent (the request
// hardcodes English + GOOGLE_SEARCH with no geoTargetConstants — no
// per-account variance), so this cache is keyed by keyword text alone and
// shared by every caller: Add Keywords' candidate lookup, blindspot
// brainstorm, and the Search tab's query enrichment.
//
// Storage key is versioned (V2) to auto-discard the pre-existing
// `adsKeywordVolumeCache` entries: the original version cached ANY text
// match Google returned, even ones with no keywordIdeaMetrics at all, which
// meant a bad first test (e.g. an access-tier/request-shape issue returning
// text-only matches) got permanently memorized as "confirmed no data" and
// silently masked every retry for the following 30 days. See
// adsGetKeywordIdeas below — an entry now only gets cached once it actually
// carries real metrics.
const KW_VOLUME_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KW_VOLUME_CACHE_CAP = 1000;
const KW_VOLUME_CACHE_KEY = 'adsKeywordVolumeCacheV2';
// Flip to true locally to trace Keyword Plan Idea Service responses in the
// background console (about:debugging → Inspect) — distinguishes "no results"
// from "results with no metrics" (the Basic-access-tier symptom). Off by
// default so nothing logs in a shipped build.
const KW_VOLUME_DEBUG = false;

// One Keyword Plan Idea Service request. v1 defaults: English language, no
// geoTargetConstants (global volume — disclosed in the UI), GOOGLE_SEARCH
// network. Never throws — mirrors adsSearch/adsMutate's { rows/results } or
// { error, detail } contract, so a rejected/unsupported call just yields no
// volume rather than breaking the panel.
async function adsGenerateKeywordIdeas(accessToken, customerId, keywords) {
  const { adsDeveloperToken, adsManagerId } = await browser.storage.local.get(['adsDeveloperToken', 'adsManagerId']);
  if (!adsDeveloperToken) return { error: 'NO_DEV_TOKEN' };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': adsDeveloperToken,
    'Content-Type': 'application/json'
  };
  if (adsManagerId) headers['login-customer-id'] = adsDigits(adsManagerId);

  const body = {
    keywordSeed: { keywords: keywords.slice(0, KW_IDEA_CHUNK) },
    language: 'languageConstants/1000', // English
    keywordPlanNetwork: 'GOOGLE_SEARCH',
    includeAdultKeywords: false
  };

  let res;
  try {
    // GenerateKeywordIdeas is a custom method ON the customer resource — the
    // path is customers/{id}:generateKeywordIdeas, with NO /keywordPlanIdeas
    // segment (unlike googleAds:searchStream). The extra segment 404'd every
    // request, which is why Vol/CPC/DIFF were always empty.
    res = await fetch(`${GA_ADS_API}/customers/${adsDigits(customerId)}:generateKeywordIdeas`, {
      method: 'POST', headers, body: JSON.stringify(body)
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (res.status === 429) return { error: 'RATE_LIMITED' };
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const msg = (Array.isArray(errBody) ? errBody[0] : errBody)?.error?.message;
    return { error: 'API_ERROR', detail: msg || `HTTP ${res.status}` };
  }
  const data = await res.json();
  return { results: data.results || [] };
}

// Fetches volume ideas for an arbitrary-length keyword list, chunking at
// KW_IDEA_CHUNK per request. Returns
// { byKeyword: { "<lowercase text>": {avgMonthlySearches, competition,
// competitionIndex, lowTopOfPageBidMicros, highTopOfPageBidMicros,
// monthlySearchVolumes} } } — a partial/empty map (never an error) if the
// account/token isn't ready, since volume is enrichment only and must never
// block the rest of the panel. Cache hits (see KW_VOLUME_CACHE_TTL_MS above)
// never touch the network at all.
async function adsGetKeywordIdeas({ pageUrl, keywords }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error) return { byKeyword: {}, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  // Keyword Plan Idea data is account-INDEPENDENT (it's Google's global keyword
  // planner data), so any accessible customer ID can make the call. Prefer the
  // account mapped to this domain, but fall back to any accessible account (or
  // the manager ID) so volume shows whenever Ads is connected — not only on
  // domains the user has explicitly mapped in Setup.
  let customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) {
    const listed = await adsListAccounts(accessToken);
    if (listed.error) return { byKeyword: {}, error: listed.error, detail: listed.detail };
    const first = (listed.accounts || [])[0];
    const { adsManagerId } = await browser.storage.local.get('adsManagerId');
    customerId = (first && first.id) || adsManagerId || null;
  }
  if (!customerId) return { byKeyword: {}, error: 'NO_ACCOUNT' };
  const cid = adsDigits(customerId);

  const wanted = [...new Set((keywords || []).map(k => String(k || '').trim()).filter(Boolean))];
  if (!wanted.length) return { byKeyword: {} };

  const { [KW_VOLUME_CACHE_KEY]: storedCache } = await browser.storage.local.get(KW_VOLUME_CACHE_KEY);
  const cache = storedCache || {};

  const byKeyword = {};
  const toFetch = [];
  wanted.forEach(k => {
    const lc = k.toLowerCase();
    const cached = cache[lc];
    if (cached && (Date.now() - cached.fetchedAt < KW_VOLUME_CACHE_TTL_MS)) byKeyword[lc] = cached;
    else toFetch.push(k);
  });

  let cacheDirty = false;
  let anyChunkErrored = false;
  let lastChunkError = null;
  let resultCount = 0, metricsCount = 0;
  for (let i = 0; i < toFetch.length; i += KW_IDEA_CHUNK) {
    const chunk = toFetch.slice(i, i + KW_IDEA_CHUNK);
    const res = await adsGenerateKeywordIdeas(accessToken, cid, chunk);
    if (res.error) { anyChunkErrored = true; lastChunkError = res; continue; } // graceful no-op per chunk — never block the others
    (res.results || []).forEach(r => {
      const text = r.text || '';
      if (!text) return;
      resultCount++;
      const lc = text.toLowerCase();
      // Only cache entries that actually carry metrics. A text match with no
      // keywordIdeaMetrics at all is not a confirmed "zero volume" answer —
      // caching it anyway is exactly what silently locked in a bad first
      // test for 30 days (see the KW_VOLUME_CACHE_KEY comment above). An
      // unmetriced miss just gets re-tried on the next call instead.
      if (!r.keywordIdeaMetrics) { byKeyword[lc] = { avgMonthlySearches: null, competition: null, fetchedAt: Date.now() }; return; }
      metricsCount++;
      const entry = {
        avgMonthlySearches:     r.keywordIdeaMetrics.avgMonthlySearches ?? null,
        competition:            r.keywordIdeaMetrics.competition ?? null,
        competitionIndex:       r.keywordIdeaMetrics.competitionIndex ?? null,
        lowTopOfPageBidMicros:  r.keywordIdeaMetrics.lowTopOfPageBidMicros ?? null,
        highTopOfPageBidMicros: r.keywordIdeaMetrics.highTopOfPageBidMicros ?? null,
        monthlySearchVolumes:   r.keywordIdeaMetrics.monthlySearchVolumes ?? [],
        fetchedAt: Date.now()
      };
      byKeyword[lc] = entry;
      cache[lc] = entry;
      cacheDirty = true;
    });
  }

  // Diagnostic trail (gated by KW_VOLUME_DEBUG). Distinguishes "the request
  // never got results at all" from "results came back but with no metrics on
  // any of them" (the two collapse into the same empty UI otherwise).
  if (KW_VOLUME_DEBUG && toFetch.length) {
    console.log(`[adsGetKeywordIdeas] requested ${toFetch.length}, chunks errored: ${anyChunkErrored}` + (lastChunkError ? ` (${lastChunkError.error}: ${lastChunkError.detail || ''})` : '') + `, results: ${resultCount}, results with metrics: ${metricsCount}`);
  }

  if (cacheDirty) {
    const keys = Object.keys(cache);
    if (keys.length > KW_VOLUME_CACHE_CAP) {
      keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
      keys.slice(0, keys.length - KW_VOLUME_CACHE_CAP).forEach(k => delete cache[k]);
    }
    await browser.storage.local.set({ [KW_VOLUME_CACHE_KEY]: cache });
  }

  // Surface a genuine HTTP/API failure whenever ANY chunk hit one — even if
  // other chunks in the same batch came back fine, so a partial outage
  // doesn't get silently swallowed just because some keywords resolved.
  if (anyChunkErrored) {
    return { byKeyword, error: lastChunkError.error, detail: lastChunkError.detail };
  }
  return { byKeyword };
}

// Adds new positive keywords to a single ad group, deduping against existing
// keyword_view criteria (text + match type). Simpler than the negatives flow —
// no shared-set resolution, just attaching criteria to an ad group that
// already exists.
async function adsAddKeywordsForAdGroup(accessToken, cid, group) {
  const { adGroupId, adGroupName, campaignName } = group;
  const out = { adGroupId, adGroupName: adGroupName || null, campaignName: campaignName || null, added: [], skipped: [], error: null };
  const wanted = (group.terms || []).filter(t => t && t.text && String(t.text).trim());
  if (!wanted.length) return out;

  const existingRes = await adsSearch(accessToken, cid,
    `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
     FROM keyword_view WHERE ad_group.id = ${adsDigits(adGroupId)}`);
  if (existingRes.error) { out.error = existingRes.detail || existingRes.error; return out; }
  const have = new Set((existingRes.rows || []).map(r =>
    `${(r.adGroupCriterion?.keyword?.text || '').toLowerCase()}::${r.adGroupCriterion?.keyword?.matchType || ''}`));

  const ops = [];
  wanted.forEach(t => {
    const mt = negMatchType(t.matchType);
    const text = String(t.text).trim();
    const key = `${text.toLowerCase()}::${mt}`;
    if (have.has(key)) { out.skipped.push({ text, matchType: mt }); return; }
    have.add(key);
    ops.push({ create: { adGroup: `customers/${cid}/adGroups/${adsDigits(adGroupId)}`, status: 'ENABLED', keyword: { text, matchType: mt } } });
    out.added.push({ text, matchType: mt });
  });

  if (ops.length) {
    const addRes = await adsMutate(accessToken, cid, 'adGroupCriteria', ops);
    if (addRes.error) { out.error = addRes.detail || addRes.error; out.added = []; return out; }
  }
  return out;
}

async function adsAddKeywords({ pageUrl, groups }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT' };
  const cid = adsDigits(customerId);

  const results = [];
  for (const group of (groups || [])) {
    results.push(await adsAddKeywordsForAdGroup(accessToken, cid, group));
  }
  return { connected: true, results };
}

// ─── WebCEO (rank tracking, whitelabel-friendly) ─────────────────────────────
// Single-endpoint JSON API: POST {method, key, id, data} to the configured base
// URL; the response is an array whose first element carries result/errormsg/data.
// Auth is a plain API key (Agency Unlimited). Base URL defaults to the user's
// whitelabel host but is overridable in Settings.

const WEBCEO_API_DEFAULT = 'https://seo.plaudit.com/api/';
const WEBCEO_PROJECTS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const WEBCEO_STALE_MS = 6 * 60 * 60 * 1000;
const WEBCEO_BACKLINKS_STALE_MS = 24 * 60 * 60 * 1000;   // backlinks change slowly
const WEBCEO_AUDIT_STALE_MS = 24 * 60 * 60 * 1000;       // site audit changes slowly

async function webceoConfig() {
  const { webceoApiKey, webceoBaseUrl } = await browser.storage.local.get(['webceoApiKey', 'webceoBaseUrl']);
  return { apiKey: webceoApiKey || '', baseUrl: (webceoBaseUrl || WEBCEO_API_DEFAULT).trim() };
}

// One API call. Returns { data } on success or { error, detail } on failure.
async function webceoCall(method, data, { apiKey, baseUrl } = {}) {
  if (apiKey === undefined) { const cfg = await webceoConfig(); apiKey = cfg.apiKey; baseUrl = cfg.baseUrl; }
  if (!apiKey) return { error: 'NO_API_KEY' };
  const body = { method, key: apiKey, id: method };
  if (data !== undefined) body.data = data;
  let res;
  try {
    res = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { error: 'NETWORK', detail: String(e && e.message || e) };
  }
  if (res.status === 401 || res.status === 403) return { error: 'BAD_KEY' };
  if (res.status === 429) return { error: 'RATE_LIMITED' };
  let json;
  try { json = await res.json(); } catch { return { error: 'API_ERROR', detail: `HTTP ${res.status}` }; }
  const entry = Array.isArray(json) ? json[0] : json;
  if (!entry) return { error: 'API_ERROR', detail: 'Empty response' };
  if (entry.result && entry.result !== 0) {
    if (entry.result === 10) return { error: 'BAD_KEY', detail: entry.errormsg };   // unknown command / bad auth
    return { error: 'API_ERROR', detail: entry.errormsg || `result ${entry.result}` };
  }
  return { data: entry.data };
}

function webceoGetStatus() {
  return webceoConfig().then(({ apiKey, baseUrl }) => ({ connected: !!apiKey, baseUrl }));
}

// Projects (get_projects), cached 7d. Returns [{ project, name, domain, suspended }].
async function webceoListProjects(forceRefresh = false) {
  const { webceoProjects } = await browser.storage.local.get('webceoProjects');
  if (!forceRefresh && webceoProjects && (Date.now() - webceoProjects.fetchedAt < WEBCEO_PROJECTS_STALE_MS)) {
    return { projects: webceoProjects.list };
  }
  const res = await webceoCall('get_projects');
  if (res.error) return { error: res.error, detail: res.detail };
  const list = (res.data || [])
    .filter(p => !p.suspended)
    .map(p => ({ project: p.project, name: p.name || p.domain, domain: (p.domain || '').replace(/^www\./i, '').toLowerCase() }));
  await browser.storage.local.set({ webceoProjects: { fetchedAt: Date.now(), list } });
  return { projects: list };
}

async function webceoGetProject(host) {
  if (!host) return null;
  const { webceoProjectOverrides } = await browser.storage.local.get('webceoProjectOverrides');
  return (webceoProjectOverrides && webceoProjectOverrides[host]) || null;
}

// Resolve the project for a page: an explicit per-domain override, else the
// project whose domain matches the page host.
async function webceoResolveProject({ pageUrl }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const listed = await webceoListProjects();
  if (listed.error) return { connected: true, error: listed.error, detail: listed.detail };

  const host = gscPageHost(pageUrl);
  const chosen = await webceoGetProject(host);
  let project = chosen && listed.projects.find(p => p.project === chosen) ? chosen : null;
  if (!project && host) {
    const match = listed.projects.find(p => p.domain === host);
    if (match) project = match.project;
  }
  return { connected: true, host, project, projects: listed.projects };
}

async function webceoSetProject({ host, project }) {
  if (!host) return { ok: false };
  const { webceoProjectOverrides } = await browser.storage.local.get('webceoProjectOverrides');
  const overrides = webceoProjectOverrides || {};
  if (project) overrides[host] = project; else delete overrides[host];
  await browser.storage.local.set({ webceoProjectOverrides: overrides });
  await browser.storage.local.remove('webceoCache');
  return { ok: true };
}

// Flatten get_rankings (grouped=0) into one row per keyword × search engine, with
// the current position, the change vs the previous scan, volume and ranking URL.
function webceoFlattenRankings(rankingData) {
  const rows = [];
  (rankingData || []).forEach(kwEntry => {
    const volume = kwEntry.global_searches != null ? kwEntry.global_searches
      : (kwEntry.local_searches && kwEntry.local_searches[0] && kwEntry.local_searches[0].searches_number) || null;
    (kwEntry.positions || []).forEach(p => {
      // Most recent scanned entries first
      const scans = (p.scan_history || []).filter(s => s.scanned !== 0)
        .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const current = scans[0] || null;
      const previous = scans[1] || null;
      rows.push({
        keyword: kwEntry.kw,
        starred: kwEntry.starred === 1,
        volume,
        se: p.se || '',
        location: p.location || '',
        country: p.country || '',
        mobile: p.mobile || 0,
        position: current && current.pos != null ? current.pos : null,
        previous: previous && previous.pos != null ? previous.pos : null,
        date: current ? current.date : null,
        url: current ? current.url : null,
        history: scans.slice(0, 12).reverse().map(s => ({ date: s.date, pos: s.pos, url: s.url || null })) // oldest→newest for a sparkline + URL-drift detection
      });
    });
  });
  return rows;
}

async function webceoGetRankings({ pageUrl, historyDepth = 2, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host, projects: project.projects };

  const depth = Math.max(2, Math.min(parseInt(historyDepth, 10) || 2, 60));
  const cacheKey = `${host}::${project.project}::${depth}`;
  const { webceoCache } = await browser.storage.local.get('webceoCache');
  const cache = webceoCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < WEBCEO_STALE_MS)) {
    return { connected: true, ...cached, fromCache: true };
  }

  const res = await webceoCall('get_rankings', { project: project.project, grouped: 0, history_depth: depth });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const rows = webceoFlattenRankings(res.data && res.data.ranking_data);
  const projInfo = project.projects.find(p => p.project === project.project);
  const entry = {
    fetchedAt: Date.now(), host, project: project.project,
    projectName: projInfo ? projInfo.name : '', domain: res.data ? res.data.domain : (projInfo && projInfo.domain),
    rows, depth
  };
  cache[cacheKey] = entry;
  await browser.storage.local.set({ webceoCache: cache });
  return { connected: true, ...entry, fromCache: false };
}

// Add tracked keyword(s) to this domain's project (Search tab "+ Track" chip).
async function webceoAddKeywords({ pageUrl, keywords, tags }) {
  const list = (Array.isArray(keywords) ? keywords : [keywords]).map(k => String(k || '').trim()).filter(Boolean);
  if (!list.length) return { error: 'NO_KEYWORDS' };
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error) return { connected: true, error: resolved.error, detail: resolved.detail };
  if (!resolved.project) return { connected: true, error: 'NO_PROJECT' };

  const payload = { project: resolved.project, keywords: list };
  if (Array.isArray(tags) && tags.length) payload.tags = tags;
  const res = await webceoCall('add_rankings_keywords', payload);
  if (res.error) return { connected: true, error: res.error, detail: res.detail };
  await browser.storage.local.remove('webceoCache');   // rankings now stale
  return { connected: true, ok: true, added: list, project: resolved.project };
}

// The project's tracked keyword list (get_rankings_keywords) — used to flag
// already-tracked terms on the Search/Ads tabs.
async function webceoGetTrackedKeywords({ pageUrl }) {
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected || resolved.error || !resolved.project) return { keywords: [] };
  const res = await webceoCall('get_rankings_keywords', { project: resolved.project });
  if (res.error) return { keywords: [], error: res.error };
  const kws = (res.data && res.data.keywords) || [];
  return { keywords: kws.map(k => (typeof k === 'string' ? k : (k.keyword || k.kw || k.text || ''))).filter(Boolean) };
}

// Roll the flat get_backlinks list up into the shapes the panel renders:
// per-referring-domain groups (with a capped sample of their linking pages),
// an anchor-text distribution, top linked-to pages, and headline counts.
// Aggregating here keeps the message small even for large link sets.
function webceoBacklinkDomain(url) {
  try { return new URL(/^https?:\/\//.test(url) ? url : 'http://' + url).hostname.replace(/^www\./, ''); }
  catch { return String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

// Same on-site page? Compares host + path (www-insensitive, trailing-slash-
// insensitive, ignoring query/hash) so a backlink's target page can be
// matched against the page currently being inspected.
function webceoSamePage(a, b) {
  const norm = (u) => {
    if (!u) return '';
    try {
      const url = new URL(/^https?:\/\//.test(u) ? u : 'https://' + u);
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      const path = url.pathname.replace(/\/+$/, '') || '/';
      return host + path;
    } catch { return String(u).trim().toLowerCase(); }
  };
  return !!a && !!b && norm(a) === norm(b);
}

// The raw get_backlinks list is large and only needed for client-side
// re-aggregation (all vs. this-page) and the toxic export — keep just the
// fields webceoAggregateBacklinks reads, capped so the cache stays well
// under the storage quota.
const WEBCEO_RAW_BACKLINK_CAP = 6000;
function webceoTrimBacklinks(list) {
  return (list || []).slice(0, WEBCEO_RAW_BACKLINK_CAP).map(l => ({
    page_url: l.page_url, title: l.title, link_text: l.link_text,
    link_target_page: l.link_target_page, link_nofollow: l.link_nofollow,
    link_status: l.link_status, link_sitewide: l.link_sitewide, is_new: l.is_new,
    domain_trusted_flow: l.domain_trusted_flow, domain_citation_flow: l.domain_citation_flow,
    domain_primary_topic: l.domain_primary_topic, url_trusted_flow: l.url_trusted_flow,
    first_discovered: l.first_discovered
  }));
}

// Builds the popup payload from a cached raw-link entry: the whole-project
// aggregate, a page-scoped aggregate (links whose target is the current
// page), and the full deduped list of toxic referring domains for the
// disavow export (uncapped, unlike the per-domain link samples).
function webceoBuildBacklinksView(entry, pageUrl) {
  const raw = entry.rawLinks || [];
  const all = webceoAggregateBacklinks(raw);
  const thisPage = webceoAggregateBacklinks(raw.filter(l => webceoSamePage(l.link_target_page, pageUrl)));
  const toxSet = new Set();
  raw.forEach(l => { if ((l.link_status || '') === 'toxic') { const d = webceoBacklinkDomain(l.page_url); if (d) toxSet.add(d); } });
  return {
    host: entry.host, project: entry.project, projectName: entry.projectName,
    domain: entry.domain, scannedDate: entry.scannedDate, fetchedAt: entry.fetchedAt,
    ...all, thisPage, toxicDomains: [...toxSet].sort()
  };
}
function webceoAggregateBacklinks(links) {
  const domMap = new Map(), anchorMap = new Map(), targetMap = new Map();
  let follow = 0, nofollow = 0, toxic = 0, disavowed = 0, newLinks = 0, sitewide = 0;
  (links || []).forEach(l => {
    const nf = !!l.link_nofollow;
    if (nf) nofollow++; else follow++;
    const st = l.link_status || 'OK';
    if (st === 'toxic') toxic++;
    if (st.indexOf('disavowed') === 0 || st.indexOf('reported') !== -1) disavowed++;
    if (l.is_new) newLinks++;
    if (l.link_sitewide) sitewide++;

    const d = webceoBacklinkDomain(l.page_url);
    if (!domMap.has(d)) domMap.set(d, { domain: d, count: 0, follow: 0, nofollow: 0, toxic: 0, isNew: false, tf: l.domain_trusted_flow ?? null, cf: l.domain_citation_flow ?? null, topic: l.domain_primary_topic || '', links: [] });
    const g = domMap.get(d);
    g.count++;
    if (nf) g.nofollow++; else g.follow++;
    if (st === 'toxic') g.toxic++;
    if (l.is_new) g.isNew = true;
    if (g.tf == null && l.domain_trusted_flow != null) g.tf = l.domain_trusted_flow;
    if (g.cf == null && l.domain_citation_flow != null) g.cf = l.domain_citation_flow;
    if (g.links.length < 20) g.links.push({ page_url: l.page_url, title: l.title || '', anchor: l.link_text || '', target: l.link_target_page || '', nofollow: nf, status: st, tf: l.url_trusted_flow ?? null, first: l.first_discovered || null, sitewide: !!l.link_sitewide });

    const a = (l.link_text || '').trim() || '(empty anchor)';
    anchorMap.set(a, (anchorMap.get(a) || 0) + 1);
    const t = l.link_target_page || '';
    if (t) targetMap.set(t, (targetMap.get(t) || 0) + 1);
  });

  const domains = [...domMap.values()].sort((a, b) => (b.tf ?? -1) - (a.tf ?? -1) || b.count - a.count).slice(0, 300);
  const anchors = [...anchorMap.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 40);
  const targets = [...targetMap.entries()].map(([page, count]) => ({ page, count })).sort((a, b) => b.count - a.count).slice(0, 25);
  const tfVals = [...domMap.values()].map(g => g.tf).filter(v => v != null);
  const maxTF = tfVals.length ? Math.max(...tfVals) : null;
  const avgTF = tfVals.length ? Math.round(tfVals.reduce((s, v) => s + v, 0) / tfVals.length) : null;

  return { total: (links || []).length, referringDomains: domMap.size, follow, nofollow, toxic, disavowed, newLinks, sitewide, maxTF, avgTF, domains, anchors, targets };
}

// Backlinks for the current domain's project (get_backlinks). Cached 24h in
// webceoBacklinksCache; returns the aggregate (not the raw list) so the popup
// just renders. { connected:false } / { error:'NO_PROJECT' } gate the Overview
// entry the same way the rankings handler does.
async function webceoGetBacklinks({ pageUrl, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoBacklinksCache } = await browser.storage.local.get('webceoBacklinksCache');
  const cache = webceoBacklinksCache || {};
  const cached = cache[cacheKey];
  // `rawLinks` guard: entries cached by an older build hold only the
  // aggregate, so treat those as stale and re-fetch to populate rawLinks.
  if (!forceRefresh && cached && cached.rawLinks && (Date.now() - cached.fetchedAt < WEBCEO_BACKLINKS_STALE_MS)) {
    return { connected: true, ...webceoBuildBacklinksView(cached, pageUrl), fromCache: true };
  }

  const res = await webceoCall('get_backlinks', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const projInfo = project.projects.find(p => p.project === project.project);
  const entry = {
    fetchedAt: Date.now(), host, project: project.project,
    projectName: projInfo ? projInfo.name : '',
    domain: (res.data && res.data.domain) || (projInfo && projInfo.domain) || host,
    scannedDate: (res.data && res.data.scanned_date) || null,
    rawLinks: webceoTrimBacklinks(res.data && res.data.data)
  };
  cache[cacheKey] = entry;
  await browser.storage.local.set({ webceoBacklinksCache: cache });
  return { connected: true, ...webceoBuildBacklinksView(entry, pageUrl), fromCache: false };
}

// Site Audit (get_site_audit_data). Trims the (potentially large) per-page
// payload to just what the panel shows: each page's Problem factors, a capped
// sample of its broken links, optimization %, and speed scores. Whole-site
// headline metrics + site-wide Problem factors ride alongside.
const SITE_AUDIT_BROKEN_KINDS = {
  ilinks: 'Internal broken link', elinks: 'External broken link',
  pictures: 'Broken image', anchors: 'Broken anchor',
  i_server: 'Internal server error', e_server: 'External server error',
  i_page: 'Internal page error', e_page: 'External page error',
  mixed_content: 'Mixed content', ijavascript: 'Broken JS (internal)',
  ejavascript: 'Broken JS (external)', icss: 'Broken CSS (internal)', ecss: 'Broken CSS (external)'
};
// Keys of a factor object whose value is { status: 'Problem' }.
function webceoAuditProblems(obj) {
  const out = [];
  Object.keys(obj || {}).forEach(k => {
    const v = obj[k];
    if (v && typeof v === 'object' && v.status === 'Problem') out.push(k);
  });
  return out;
}
function webceoAggregateSiteAudit(d) {
  const pages = (d.pages || []).map(p => {
    const broken = [];
    let brokenCount = 0;
    Object.keys(SITE_AUDIT_BROKEN_KINDS).forEach(kind => {
      const list = p[kind] || [];
      brokenCount += list.length;
      list.forEach(item => { if (broken.length < 60) broken.push({ kind, url: item.url, status: item.status, line: item.line ?? null }); });
    });
    const landing = p.landing || {};
    const speed = p.speed_optimization || {};
    return {
      url: p.url,
      unavailable: !!p.page_unavailable,
      optimization: (landing.page_optimization != null) ? landing.page_optimization : null,
      totalWords: landing.total_words ?? null,
      desktopSpeed: speed.desktop_speed_score ?? null,
      mobileSpeed: speed.mobile_speed_score ?? null,
      generalProblems: webceoAuditProblems(p.general),
      landingProblems: webceoAuditProblems(landing),
      broken,
      brokenCount
    };
  });
  return {
    siteOptimization: d.site_optimization ?? null,
    generalErrors: d.general_errors ?? null,
    optimizerErrors: d.optimizer_errors ?? null,
    brokenLinks: d.broken_links ?? null,
    brokenAnchors: d.broken_anchors ?? null,
    scannedPages: d.scanned_pages ?? null,
    scannedObjects: d.scanned_objects ?? null,
    domainAge: d.domain_age ?? null,
    summary: webceoAuditProblems(d.summary),
    pages
  };
}

// Cached 24h in webceoAuditCache; { connected:false } / NO_PROJECT gate the
// Overview entry the same way the backlinks handler does.
async function webceoGetSiteAudit({ pageUrl, forceRefresh = false }) {
  const { apiKey } = await webceoConfig();
  if (!apiKey) return { connected: false };
  const host = gscPageHost(pageUrl);
  const project = await webceoResolveProject({ pageUrl });
  if (project.error) return { connected: true, error: project.error, detail: project.detail };
  if (!project.project) return { connected: true, error: 'NO_PROJECT', host };

  const cacheKey = `${host}::${project.project}`;
  const { webceoAuditCache } = await browser.storage.local.get('webceoAuditCache');
  const cache = webceoAuditCache || {};
  const cached = cache[cacheKey];
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt < WEBCEO_AUDIT_STALE_MS)) {
    return { connected: true, ...cached, fromCache: true };
  }

  const res = await webceoCall('get_site_audit_data', { project: project.project });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const projInfo = project.projects.find(p => p.project === project.project);
  const agg = webceoAggregateSiteAudit(res.data || {});
  const entry = {
    fetchedAt: Date.now(), host, project: project.project,
    projectName: projInfo ? projInfo.name : '',
    domain: (res.data && res.data.domain) || (projInfo && projInfo.domain) || host,
    scannedDate: (res.data && res.data.d_scan) || null,
    ...agg
  };
  cache[cacheKey] = entry;
  await browser.storage.local.set({ webceoAuditCache: cache });
  return { connected: true, ...entry, fromCache: false };
}

// Add a WebCEO "event" (chart annotation) to the domain's project for a date.
// Events show as notes on the rank/traffic/backlink charts (tools list below).
async function webceoAddEvent({ pageUrl, date, text }) {
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error) return { connected: true, error: resolved.error, detail: resolved.detail };
  if (!resolved.project) return { connected: true, error: 'NO_PROJECT' };

  // The API wants a singular `project` (an array yields "'project' parameter
  // is required") and a required, explicit `tools` list (omitting it yields
  // "'tools' parameter is required"). The full tool set below applies the
  // event to every tool — matching Web CEO's native "Create a new event"
  // dialog, which checks all tools by default.
  const res = await webceoCall('add_event', {
    project: resolved.project,
    date,
    text: String(text || '').slice(0, 500),
    visibility: 'public',
    tools: ['advisor', 'auditor', 'backlinks', 'business', 'competitorlinks', 'competitorstats', 'buzz', 'facebook', 'interlinks', 'links', 'partners', 'ranker', 'social', 'stats', 'submission', 'webmasters'],
    charts_visibility: 1
  });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };
  return { connected: true, ok: true, project: resolved.project, event: (res.data && res.data.event) || null };
}

// List WebCEO events (chart annotations) for the domain's project. Skips
// auto-generated "system" events. Returns [{ date:'YYYY-MM-DD', text }].
// WebCEO event text can contain HTML markup; the chart tooltip renders it as
// plain text, so strip tags + decode the common entities to a clean note.
function webceoStripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
async function webceoGetEvents({ pageUrl }) {
  const resolved = await webceoResolveProject({ pageUrl });
  if (!resolved.connected) return { connected: false };
  if (resolved.error || !resolved.project) return { connected: true, error: resolved.error || 'NO_PROJECT' };
  const idsRes = await webceoCall('get_event_ids', { project: resolved.project });
  if (idsRes.error) return { connected: true, error: idsRes.error };
  const ids = (idsRes.data && idsRes.data.ids) || [];
  if (!ids.length) return { connected: true, events: [] };
  const evRes = await webceoCall('get_events', { project: resolved.project, ids });
  if (evRes.error) return { connected: true, error: evRes.error };
  const events = ((evRes.data && evRes.data.events) || [])
    .filter(e => e.visibility !== 'system')
    .map(e => ({ date: e.date, text: webceoStripHtml(e.text) }))
    .filter(e => e.date);
  return { connected: true, events };
}

// Merge GA4 + WebCEO annotations by date for the chart-star overlay. Same text
// on the same date across sources collapses into one entry whose `sources`
// lists every place it lives (so the UI can flag "in all").
async function getChartAnnotations({ pageUrl }) {
  const connectedSources = [];
  const all = [];
  const ga = await ga4ListAnnotations({ pageUrl });
  if (ga.connected && !ga.error) { connectedSources.push('ga4'); (ga.annotations || []).forEach(a => all.push({ ...a, source: 'ga4' })); }
  const wc = await webceoGetEvents({ pageUrl });
  if (wc.connected && !wc.error) { connectedSources.push('webceo'); (wc.events || []).forEach(a => all.push({ ...a, source: 'webceo' })); }

  const byDate = {};
  all.forEach(a => {
    if (!a.date) return;
    const norm = (a.text || '').trim().toLowerCase();
    const list = byDate[a.date] || (byDate[a.date] = []);
    const existing = norm && list.find(e => e._norm === norm);
    if (existing) { if (!existing.sources.includes(a.source)) existing.sources.push(a.source); }
    else list.push({ text: a.text, _norm: norm, sources: [a.source] });
  });
  Object.values(byDate).forEach(list => list.forEach(e => { delete e._norm; }));
  return { connectedSources, byDate };
}

function webceoSaveConfig({ apiKey, baseUrl }) {
  const update = {};
  if (apiKey !== undefined) update.webceoApiKey = apiKey;
  if (baseUrl !== undefined) update.webceoBaseUrl = baseUrl;
  return browser.storage.local.set(update)
    .then(() => browser.storage.local.remove(['webceoProjects', 'webceoCache', 'webceoBacklinksCache', 'webceoAuditCache']))
    .then(() => ({ ok: true }));
}

function webceoDisconnect() {
  return browser.storage.local.remove(['webceoApiKey', 'webceoProjects', 'webceoCache', 'webceoBacklinksCache', 'webceoAuditCache', 'webceoProjectOverrides'])
    .then(() => ({ ok: true }));
}

// ─── Google Docs: Action Plan export ────────────────────────────────────────

// Only the Drive API is needed: we upload formatted HTML and let Drive convert
// it to a native Google Doc. This avoids the Docs API entirely (which would need
// a separate API enablement + the sensitive 'documents' scope).
const GOOGLE_DOCS_SCOPE = 'https://www.googleapis.com/auth/drive.file';

async function docsConnect() {
  return googleOAuthConnectRequireScope(GOOGLE_DOCS_SCOPE, 'docsAuth', 'DOCS_SCOPE_MISSING');
}

async function docsGetStatus() {
  const { docsAuth } = await browser.storage.local.get('docsAuth');
  return {
    connected: !!docsAuth,
    redirectUri: getGoogleRedirectUri(),
    connectedAt: docsAuth?.connectedAt ?? null,
    email: docsAuth ? await googleEnsureEmail('docsAuth') : null
  };
}

function docsDisconnect() {
  return googleDisconnect('docsAuth', ['docsFolderID']);
}

async function docsGetAccessToken() {
  return googleGetAccessToken('docsAuth');
}

async function docsGetOrCreateFolder(accessToken) {
  const { docsFolderID } = await browser.storage.local.get('docsFolderID');
  if (docsFolderID) return docsFolderID;

  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SEO Plans', mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!res.ok) return null;
  const { id } = await res.json();
  await browser.storage.local.set({ docsFolderID: id });
  return id;
}

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the Action Plan as an HTML document. Drive's import converter maps
// h1/h2 → heading styles, b/i → bold/italic, and inline color styles → text color.
function buildActionPlanHtml(plan, docTitle, fetchedAt) {
  const GRAY = '#999999';
  const EFFORT_COLOR = { surgical: '#15803d', moderate: '#b45309', rewrite: '#808080' };
  const out = [];

  out.push(`<h1>${htmlEsc(docTitle)}</h1>`);
  const dateStr = new Date(fetchedAt || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.push(`<p style="color:${GRAY};font-size:10pt">Generated ${htmlEsc(dateStr)}</p>`);

  const TIERS = [
    { effort: 'surgical', title: 'Quick wins' },
    { effort: 'moderate', title: 'Recommended' },
    { effort: 'rewrite',  title: 'Heavy lift' }
  ];
  TIERS.forEach(tier => {
    const recs = (plan.recommendations || []).filter(rec => rec.effort === tier.effort);
    if (!recs.length) return;
    out.push(`<h2>${htmlEsc(tier.title)}</h2>`);
    const color = EFFORT_COLOR[tier.effort];
    recs.forEach(rec => {
      out.push(`<p style="font-size:12pt"><b>${htmlEsc(rec.change)}</b></p>`);
      const ch = rec.channel === 'both' ? 'SEO + Paid' : rec.channel === 'paid' ? 'Paid' : 'SEO';
      const impactStr = (rec.impact ? `${tier.title} · ${rec.impact} impact` : tier.title) + ` · ${ch}`;
      out.push(`<p style="color:${color};font-size:10pt">${htmlEsc(impactStr)}</p>`);
      if (rec.evidence) out.push(`<p style="color:${GRAY}"><i>${htmlEsc(rec.evidence)}</i></p>`);
    });
  });

  if (plan.contentGaps && plan.contentGaps.length) {
    out.push('<h2>Content gaps</h2>');
    out.push(`<p>${htmlEsc(plan.contentGaps.join(', '))}</p>`);
  }

  const gap = plan.intentGap;
  if (gap && gap.pageIntent) {
    out.push('<h2>Intent gap</h2>');
    out.push(`<p><b>${htmlEsc(gap.pageIntent)} → ${htmlEsc(gap.trafficIntent || '')}</b></p>`);
    if (gap.summary) out.push(`<p style="color:${GRAY}"><i>${htmlEsc(gap.summary)}</i></p>`);
    if (gap.suggestions && gap.suggestions.length) {
      out.push('<p><b>Phrase suggestions:</b></p>');
      out.push(`<p>${htmlEsc(gap.suggestions.join(' / '))}</p>`);
    }
  }

  const eeat = plan.eeat;
  if (eeat && eeat.score) {
    out.push('<h2>E-E-A-T Signals</h2>');
    const scoreLabel = eeat.score.charAt(0).toUpperCase() + eeat.score.slice(1);
    out.push(`<p><b>Score: ${htmlEsc(scoreLabel)}</b></p>`);
    (eeat.signals || []).forEach(s => {
      out.push(`<p><b>${htmlEsc(s.dimension)}:</b> ${htmlEsc(s.observation)}</p>`);
    });
    if (eeat.gaps && eeat.gaps.length) {
      out.push('<p><b>Improvements:</b></p>');
      out.push('<ul>' + eeat.gaps.map(g => `<li>${htmlEsc(g)}</li>`).join('') + '</ul>');
    }
  }

  return `<html><head><meta charset="utf-8"></head><body>${out.join('')}</body></html>`;
}

// Derive a "host/path" label for a doc title from a page URL.
function docsUrlLabel(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const h = u.hostname.replace(/^www\./, '');
    const p = u.pathname.replace(/\/$/, '');
    return p ? `${h}${p}` : h;
  } catch { return 'page'; }
}

// Multipart-upload an HTML body to Drive, which converts it to a native Google
// Doc. Shared by every "Export to Google Doc" path. Returns { url } or
// { notConnected, error } / { error, detail }.
async function docsUploadHtmlDoc(accessToken, docTitle, html) {
  const folderId = await docsGetOrCreateFolder(accessToken);
  const metadata = { name: docTitle, mimeType: 'application/vnd.google-apps.document' };
  if (folderId) metadata.parents = [folderId];

  const boundary = '----seoInspectorBoundary' + Date.now();
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: text/html; charset=UTF-8\r\n\r\n' +
    html + '\r\n' +
    `--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
      await browser.storage.local.remove('docsAuth');
      return { notConnected: true, error: 'REAUTH_REQUIRED' };
    }
    return { error: 'CREATE_FAILED', detail };
  }
  const { id } = await res.json();
  return { url: `https://docs.google.com/document/d/${id}/edit` };
}

async function docsExportActionPlan({ plan, pageUrl, fetchedAt }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const date = new Date().toISOString().slice(0, 10);
  const docTitle = `${date}: Action Plan For ${docsUrlLabel(pageUrl)}`;
  const html = buildActionPlanHtml(plan, docTitle, fetchedAt);
  return docsUploadHtmlDoc(token.accessToken, docTitle, html);
}

// Negative keywords as nested bullets: one bullet per exclusion list, with its
// terms (match type shown as punctuation) nested beneath. Drive maps the nested
// <ul> to indented bullets in the Doc.
function negFormatTerm(text, matchType) {
  const mt = String(matchType || '').toUpperCase();
  if (mt === 'EXACT')  return `[${text}]`;
  if (mt === 'PHRASE') return `"${text}"`;
  return String(text);
}

function buildNegativesHtml(lists, docTitle) {
  const out = [`<h1>${htmlEsc(docTitle)}</h1>`];
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.push(`<p style="color:#999999;font-size:10pt">Generated ${htmlEsc(dateStr)}</p>`);
  out.push('<ul>');
  (lists || []).forEach(list => {
    out.push(`<li>Added Negatives to ${htmlEsc(list.campaignName || 'Campaign')} &rarr;&nbsp;&nbsp;${htmlEsc(list.name)}<ul>`);
    (list.terms || []).forEach(t => out.push(`<li>${htmlEsc(negFormatTerm(t.text, t.matchType))}</li>`));
    out.push('</ul></li>');
  });
  out.push('</ul>');
  return `<html><head><meta charset="utf-8"></head><body>${out.join('')}</body></html>`;
}

async function docsExportNegatives({ lists, pageUrl }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const date = new Date().toISOString().slice(0, 10);
  const docTitle = `${date}: Negative Keywords For ${docsUrlLabel(pageUrl)}`;
  const html = buildNegativesHtml(lists, docTitle);
  return docsUploadHtmlDoc(token.accessToken, docTitle, html);
}

// New keywords as nested bullets: one bullet per ad group, with its added
// keywords (match type shown as punctuation, same convention as negatives)
// nested beneath.
function buildAddKeywordsHtml(groups, docTitle) {
  const out = [`<h1>${htmlEsc(docTitle)}</h1>`];
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.push(`<p style="color:#999999;font-size:10pt">Generated ${htmlEsc(dateStr)}</p>`);
  out.push('<ul>');
  (groups || []).forEach(group => {
    const label = group.campaignName ? `${group.campaignName} | ${group.adGroupName || 'Ad Group'}` : (group.adGroupName || 'Ad Group');
    out.push(`<li>Added Keywords to ${htmlEsc(label)}<ul>`);
    (group.terms || []).forEach(t => out.push(`<li>${htmlEsc(negFormatTerm(t.text, t.matchType))}</li>`));
    out.push('</ul></li>');
  });
  out.push('</ul>');
  return `<html><head><meta charset="utf-8"></head><body>${out.join('')}</body></html>`;
}

async function docsExportAddKeywords({ groups, pageUrl }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const date = new Date().toISOString().slice(0, 10);
  const docTitle = `${date}: Added Keywords For ${docsUrlLabel(pageUrl)}`;
  const html = buildAddKeywordsHtml(groups, docTitle);
  return docsUploadHtmlDoc(token.accessToken, docTitle, html);
}

// ─── Google Sheets: per-domain keyword-brainstorm history ──────────────────
// Reuses the same drive.file grant as the Docs exports above — drive.file
// covers files the app creates via any Google Workspace API using that
// token, including Sheets-API-created spreadsheets, so no separate OAuth
// scope/connection is needed. One spreadsheet per domain (cached by domain
// in sheetsSpreadsheetIds), a single fixed tab ("Blindspot Ideas") that every
// export appends rows to — never a new tab per run — so the sheet reads as
// one continuously growing history log.

const SHEETS_TAB_NAME = 'Blindspot Ideas';
const SHEETS_HEADER_ROW = ['Date Added', 'Page URL', 'Keyword', 'Status', 'Confidence', 'Match Type', 'Volume', 'Competition', 'Reason'];
const SHEETS_SPREADSHEET_CACHE_CAP = 50;

const SHEETS_STATUS_LABEL = {
  already_suggested: 'Filtered: already suggested',
  branded:            'Filtered: branded term',
  already_targeted:   'Filtered: already targeted',
  no_volume:           'Filtered: no search volume',
};

function sheetsDomainFromUrl(pageUrl) {
  try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

// Finds (or creates) the one spreadsheet for this domain. A cached ID is
// verified before trust — the user may have deleted the file in Drive since
// last export — and silently recreated on 404/trashed, matching the same
// no-warning precedent as docsGetOrCreateFolder above.
async function sheetsGetOrCreateSpreadsheet(accessToken, domain) {
  const { sheetsSpreadsheetIds } = await browser.storage.local.get('sheetsSpreadsheetIds');
  const cache = sheetsSpreadsheetIds || {};
  const cached = cache[domain];
  if (cached && cached.id) {
    const check = await fetch(`https://www.googleapis.com/drive/v3/files/${cached.id}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).catch(() => null);
    if (check && check.ok) {
      const meta = await check.json();
      if (!meta.trashed) return { id: cached.id };
    }
    // 404, trashed, or network error: fall through and recreate below.
  }

  const title = `SEO Inspector Blindspots — ${domain}`;
  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: SHEETS_TAB_NAME } }]
    })
  });
  if (!createRes.ok) {
    const detail = await createRes.text().catch(() => '');
    if (createRes.status === 401) {
      await browser.storage.local.remove('docsAuth');
      return { notConnected: true, error: 'REAUTH_REQUIRED' };
    }
    return { error: 'CREATE_FAILED', detail };
  }
  const { spreadsheetId } = await createRes.json();

  // Sheets-API-created files land at Drive root — re-parent into the shared
  // "SEO Plans" folder alongside the Doc exports. Best-effort: still usable
  // at Drive root if this fails.
  const folderId = await docsGetOrCreateFolder(accessToken);
  if (folderId) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${folderId}&removeParents=root`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}` }
    }).catch(() => {});
  }

  // Header row, written once at creation time only.
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${SHEETS_TAB_NAME}'!A1:I1`)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [SHEETS_HEADER_ROW] })
    }
  ).catch(() => {});

  cache[domain] = { id: spreadsheetId, updatedAt: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > SHEETS_SPREADSHEET_CACHE_CAP) {
    keys.sort((a, b) => (cache[a].updatedAt || 0) - (cache[b].updatedAt || 0));
    keys.slice(0, keys.length - SHEETS_SPREADSHEET_CACHE_CAP).forEach(k => delete cache[k]);
  }
  await browser.storage.local.set({ sheetsSpreadsheetIds: cache });
  return { id: spreadsheetId };
}

async function sheetsAppendBlindspotIdeas(accessToken, spreadsheetId, rows) {
  const range = encodeURIComponent(`'${SHEETS_TAB_NAME}'!A:I`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
      await browser.storage.local.remove('docsAuth');
      return { notConnected: true, error: 'REAUTH_REQUIRED' };
    }
    return { error: 'APPEND_FAILED', detail };
  }
  return { ok: true };
}

async function sheetsExportBlindspotIdeas({ ideas, pageUrl }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  if (!Array.isArray(ideas) || !ideas.length) return { error: 'NO_IDEAS' };

  const domain = sheetsDomainFromUrl(pageUrl);
  const sheet = await sheetsGetOrCreateSpreadsheet(token.accessToken, domain);
  if (sheet.notConnected || sheet.error) return sheet;

  const dateAdded = new Date().toISOString().slice(0, 10);
  const rows = ideas.map(r => [
    dateAdded, pageUrl, r.text,
    SHEETS_STATUS_LABEL[r.filterReason] || 'Kept',
    r.confidence || '', r.matchType || '', r.volume ?? '', r.competition || '', r.reason || ''
  ]);

  const appendRes = await sheetsAppendBlindspotIdeas(token.accessToken, sheet.id, rows);
  if (appendRes.notConnected || appendRes.error) return appendRes;

  return { url: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit` };
}

// ─── Google Search Console: message handlers ────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  switch (message?.action) {
    case 'gscGetStatus':       return gscGetStatus();
    case 'gscConnect':         return gscConnect();
    case 'gscDisconnect':      return gscDisconnect();
    case 'gscGetPageData':     return gscGetPageData(message);
    case 'gscGetQueryData':    return gscGetQueryData(message);
    case 'gscGetMoreQueries':  return gscGetMoreQueries(message);
    case 'gscGetQueriesData':  return gscGetQueriesData(message);
    case 'gscGetChartData':    return gscGetChartData(message);
    case 'gscResolveProperty': return gscResolveProperty(message);
    case 'gscSetProperty':     return gscSetProperty(message);
    case 'gaGetStatus':        return gaGetStatus();
    case 'gaConnect':          return gaConnect();
    case 'gaDisconnect':       return gaDisconnect();
    case 'gaResolveProperty':  return gaResolveProperty(message);
    case 'gaSetProperty':      return gaSetProperty(message);
    case 'gaGetPageData':      return gaGetPageData(message);
    case 'gaGetPageUtmValues': return gaGetPageUtmValues(message);
    case 'gaGetChannelData':   return gaGetChannelData(message);
    case 'adsGetStatus':       return adsGetStatus();
    case 'adsConnect':         return adsConnect();
    case 'adsDisconnect':      return adsDisconnect();
    case 'adsResolveAccount':  return adsResolveAccount(message);
    case 'adsSetAccount':      return adsSetAccount(message);
    case 'adsGetPageData':     return adsGetPageData(message);
    case 'adsGetChartData':    return adsGetChartData(message);
    case 'adsGetMoreSearchTerms': return adsGetMoreSearchTerms(message);
    case 'adsGetAdsDetail':    return adsGetAdsDetail(message);
    case 'adsGetCampaignNegLists': return adsGetCampaignNegLists(message);
    case 'adsGetAllAdGroups':  return adsGetAllAdGroups(message);
    case 'adsGetAllKeywords':  return adsGetAllKeywords(message);
    case 'adsAddNegatives':    return adsAddNegatives(message);
    case 'adsGetKeywordIdeas': return adsGetKeywordIdeas(message);
    case 'adsAddKeywords':     return adsAddKeywords(message);
    case 'getRedirectInfo':    return getRedirectInfo(message);
    case 'traceUrl':           return traceUrl(message);
    case 'getTargetTab':       return getTargetTab();
    case 'injectContentScript': return injectContentScript(message);
    case 'openPopout':         return openPopoutWindow();
    case 'getDomainAge':       return getDomainAge(message);
    case 'dnsResolve':         return dnsResolve(message);
    case 'checkLinks':         return checkLinkStatuses(message);
    case 'validateFavicon':    return validateFavicon(message);
    case 'clearFaviconCache':  return clearFaviconCache(message);
    case 'webceoGetStatus':      return webceoGetStatus();
    case 'webceoSaveConfig':     return webceoSaveConfig(message);
    case 'webceoDisconnect':     return webceoDisconnect();
    case 'webceoResolveProject': return webceoResolveProject(message);
    case 'webceoSetProject':     return webceoSetProject(message);
    case 'webceoGetRankings':    return webceoGetRankings(message);
    case 'webceoAddKeywords':    return webceoAddKeywords(message);
    case 'webceoGetTrackedKeywords': return webceoGetTrackedKeywords(message);
    case 'webceoGetBacklinks':   return webceoGetBacklinks(message);
    case 'webceoGetSiteAudit':   return webceoGetSiteAudit(message);
    case 'webceoAddEvent':       return webceoAddEvent(message);
    case 'gaConnectEdit':        return gaConnectEdit();
    case 'ga4AddAnnotation':     return ga4AddAnnotation(message);
    case 'getChartAnnotations':  return getChartAnnotations(message);
    case 'docsConnect':          return docsConnect();
    case 'docsGetStatus':        return docsGetStatus();
    case 'docsDisconnect':       return docsDisconnect();
    case 'docsExportActionPlan': return docsExportActionPlan(message);
    case 'docsExportNegatives':  return docsExportNegatives(message);
    case 'docsExportAddKeywords': return docsExportAddKeywords(message);
    case 'sheetsExportBlindspotIdeas': return sheetsExportBlindspotIdeas(message);
    default: return undefined;
  }
});
