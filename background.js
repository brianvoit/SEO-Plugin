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
      userCanonical: idx.userCanonical || null
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

const GA_METRIC_NAMES = ['sessions', 'activeUsers', 'screenPageViews'];

function gaParseMetricRow(row) {
  const v = row?.metricValues || [];
  return {
    sessions:  Number(v[0]?.value || 0),
    users:     Number(v[1]?.value || 0),
    pageviews: Number(v[2]?.value || 0)
  };
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

  let tsData, totalsData, channelsData;
  try {
    [tsData, totalsData, channelsData] = await Promise.all([
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
      })
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
  let totals = { sessions: 0, users: 0, pageviews: 0 };
  let previousTotals = { sessions: 0, users: 0, pageviews: 0 };
  (totalsData.rows || []).forEach(row => {
    const which = row.dimensionValues?.[0]?.value;
    if (which === 'date_range_1') previousTotals = gaParseMetricRow(row);
    else totals = gaParseMetricRow(row);
  });

  const channels = (channelsData.rows || []).map(row => ({
    channel: row.dimensionValues[0].value,
    ...gaParseMetricRow(row)
  }));

  const { gaProperties } = await browser.storage.local.get('gaProperties');
  const propertyName = gaProperties?.properties?.find(p => p.property === property)?.displayName || property;

  const entry = { fetchedAt: Date.now(), property, propertyName, range, path, timeseries, totals, previousTotals, channels };
  cache[cacheKey] = entry;
  await gscPruneCache(cache);
  await browser.storage.local.set({ gaCache: cache });

  return { connected: true, ...entry, fromCache: false };
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

// ─── Google Search Console: message handlers ────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  switch (message?.action) {
    case 'gscGetStatus':       return gscGetStatus();
    case 'gscConnect':         return gscConnect();
    case 'gscDisconnect':      return gscDisconnect();
    case 'gscGetPageData':     return gscGetPageData(message);
    case 'gscGetQueryData':    return gscGetQueryData(message);
    case 'gscResolveProperty': return gscResolveProperty(message);
    case 'gscSetProperty':     return gscSetProperty(message);
    case 'gaGetStatus':        return gaGetStatus();
    case 'gaConnect':          return gaConnect();
    case 'gaDisconnect':       return gaDisconnect();
    case 'gaResolveProperty':  return gaResolveProperty(message);
    case 'gaSetProperty':      return gaSetProperty(message);
    case 'gaGetPageData':      return gaGetPageData(message);
    case 'getRedirectInfo':    return getRedirectInfo(message);
    case 'getTargetTab':       return getTargetTab();
    case 'getDomainAge':       return getDomainAge(message);
    case 'dnsResolve':         return dnsResolve(message);
    default: return undefined;
  }
});
