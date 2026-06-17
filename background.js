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

async function googleOAuthConnect(scope, authKey) {
  const { gscClientId, gscClientSecret } = await browser.storage.local.get(['gscClientId', 'gscClientSecret']);
  if (!gscClientId) return { error: 'NO_CLIENT_ID' };

  const redirectUri = getGoogleRedirectUri();

  const codeVerifier = googleBase64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
  const codeChallenge = googleBase64UrlEncode(challengeBytes);
  const state = googleBase64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', gscClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scope);
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
      connectedAt: Date.now()
    }
  });
  return { connected: true };
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
    connectedAt: gscAuth?.connectedAt ?? null
  };
}

function gscConnect() {
  return googleOAuthConnect(GSC_SCOPE, 'gscAuth');
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
    connectedAt: gaAuth?.connectedAt ?? null
  };
}

function gaConnect() {
  return googleOAuthConnect(GA_SCOPE, 'gaAuth');
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

function adsDigits(id) { return String(id || '').replace(/\D/g, ''); }

async function adsGetStatus() {
  const { adsAuth, adsDeveloperToken, adsManagerId } = await browser.storage.local.get(['adsAuth', 'adsDeveloperToken', 'adsManagerId']);
  return {
    connected: !!adsAuth,
    hasDevToken: !!adsDeveloperToken,
    managerId: adsManagerId || null,
    redirectUri: getGoogleRedirectUri(),
    connectedAt: adsAuth?.connectedAt ?? null
  };
}

function adsConnect() {
  return googleOAuthConnect('https://www.googleapis.com/auth/adwords', 'adsAuth');
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
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name,
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
      adGroupId: String(r.adGroup.id), adGroup: r.adGroup.name,
      adId: String(r.adGroupAd.ad.id), adName: r.adGroupAd.ad.name || '',
      type: r.adGroupAd.ad.type || '', finalUrls: urls,
      ...adsMetrics(r.metrics)
    });
  });

  if (!ads.length) {
    const entry = { fetchedAt: Date.now(), account: customerId, range, path, ads: [], campaigns: [], keywords: [], searchTerms: [], timeseries: [], totals: null, previousTotals: null, currency: '' };
    cache[cacheKey] = entry; await gscPruneCache(cache); await browser.storage.local.set({ adsCache: cache });
    return { connected: true, ...entry, fromCache: false };
  }

  const agList = `(${[...adGroupIds].join(',')})`;
  const campList = `(${[...campaignIds].join(',')})`;

  // 2) campaign IS, 3) keywords (+QS, ids), 4) search terms (+triggering keyword),
  // 5) daily timeseries per ad group, 6) previous-period totals, + currency
  const [campRes, kwRes, stRes, tsRes, prevRes, custRes] = await Promise.all([
    adsSearch(accessToken, customerId,
      `SELECT campaign.id, campaign.name, metrics.search_impression_share,
              metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
       FROM campaign WHERE ${dateWhere} AND campaign.id IN ${campList}`),
    adsSearch(accessToken, customerId,
      `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
              ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score,
              metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM keyword_view WHERE ${dateWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId,
      `SELECT search_term_view.search_term, ad_group.id, segments.keyword.info.text,
              metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM search_term_view WHERE ${dateWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId,
      `SELECT segments.date, ad_group.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM ad_group WHERE ${dateWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId,
      `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM ad_group WHERE ${prevWhere} AND ad_group.id IN ${agList}`),
    adsSearch(accessToken, customerId, 'SELECT customer.currency_code FROM customer LIMIT 1')
  ]);

  const campaigns = (campRes.rows || []).map(r => ({
    id: String(r.campaign.id), name: r.campaign.name,
    impressionShare: r.metrics?.searchImpressionShare ?? null,
    lostBudget: r.metrics?.searchBudgetLostImpressionShare ?? null,
    lostRank: r.metrics?.searchRankLostImpressionShare ?? null
  }));
  const keywords = (kwRes.rows || []).map(r => ({
    text: r.adGroupCriterion?.keyword?.text || '',
    matchType: r.adGroupCriterion?.keyword?.matchType || '',
    qualityScore: r.adGroupCriterion?.qualityInfo?.qualityScore ?? null,
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

  const entry = { fetchedAt: Date.now(), account: customerId, range, path, ads, campaigns, keywords, searchTerms, tsRows, timeseries, totals, previousTotals, currency };
  cache[cacheKey] = entry; await gscPruneCache(cache); await browser.storage.local.set({ adsCache: cache });
  return { connected: true, ...entry, fromCache: false };
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

// ─── Google Search Console: message handlers ────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  switch (message?.action) {
    case 'gscGetStatus':       return gscGetStatus();
    case 'gscConnect':         return gscConnect();
    case 'gscDisconnect':      return gscDisconnect();
    case 'gscGetPageData':     return gscGetPageData(message);
    case 'gscGetQueryData':    return gscGetQueryData(message);
    case 'gscGetMoreQueries':  return gscGetMoreQueries(message);
    case 'gscGetChartData':    return gscGetChartData(message);
    case 'gscResolveProperty': return gscResolveProperty(message);
    case 'gscSetProperty':     return gscSetProperty(message);
    case 'gaGetStatus':        return gaGetStatus();
    case 'gaConnect':          return gaConnect();
    case 'gaDisconnect':       return gaDisconnect();
    case 'gaResolveProperty':  return gaResolveProperty(message);
    case 'gaSetProperty':      return gaSetProperty(message);
    case 'gaGetPageData':      return gaGetPageData(message);
    case 'gaGetChannelData':   return gaGetChannelData(message);
    case 'adsGetStatus':       return adsGetStatus();
    case 'adsConnect':         return adsConnect();
    case 'adsDisconnect':      return adsDisconnect();
    case 'adsResolveAccount':  return adsResolveAccount(message);
    case 'adsSetAccount':      return adsSetAccount(message);
    case 'adsGetPageData':     return adsGetPageData(message);
    case 'adsGetChartData':    return adsGetChartData(message);
    case 'getRedirectInfo':    return getRedirectInfo(message);
    case 'getTargetTab':       return getTargetTab();
    case 'openPopout':         return openPopoutWindow();
    case 'getDomainAge':       return getDomainAge(message);
    case 'dnsResolve':         return dnsResolve(message);
    default: return undefined;
  }
});
