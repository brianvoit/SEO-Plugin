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

// ─── Display mode: popup vs. sidebar ────────────────────────────────────────
// In sidebar mode the toolbar button has no popup, so a click falls through to
// onClicked, which toggles Firefox's native sidebar (a real viewport resize).

async function applyDisplayMode() {
  const { displayMode } = await browser.storage.local.get('displayMode');
  const useSidebar = displayMode !== 'popup';   // default to sidebar when unset
  await browser.action.setPopup({ popup: useSidebar ? '' : 'popup.html' });
}

applyDisplayMode();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.displayMode) applyDisplayMode();
});

browser.action.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

// ─── Redirect trace: status code + redirect chain per tab ───────────────────
// Observe-only webRequest on top-level navigations, so the popup can show how
// you arrived at the current page (direct vs. via redirects) and the full chain.

const redirectByTab = new Map();   // tabId -> { requestId, chain:[{url,status}], finalUrl, finalStatus, error, done }

const REDIRECT_FILTER = { urls: ['*://*/*'], types: ['main_frame'] };

browser.webRequest.onBeforeRequest.addListener(details => {
  if (details.frameId !== 0) return;
  redirectByTab.set(details.tabId, {
    requestId: details.requestId,
    chain: [],
    finalUrl: null,
    finalStatus: null,
    error: null,
    done: false
  });
}, REDIRECT_FILTER);

browser.webRequest.onBeforeRedirect.addListener(details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || entry.requestId !== details.requestId) return;
  entry.chain.push({ url: details.url, status: details.statusCode });
}, REDIRECT_FILTER);

browser.webRequest.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || entry.requestId !== details.requestId) return;
  entry.chain.push({ url: details.url, status: details.statusCode });
  entry.finalUrl = details.url;
  entry.finalStatus = details.statusCode;
  entry.done = true;
  browser.runtime.sendMessage({ action: 'redirectUpdated', tabId: details.tabId }).catch(() => {});
}, REDIRECT_FILTER);

browser.webRequest.onErrorOccurred.addListener(details => {
  if (details.frameId !== 0) return;
  const entry = redirectByTab.get(details.tabId);
  if (!entry || entry.requestId !== details.requestId) return;
  entry.error = details.error;
  entry.done = true;
}, REDIRECT_FILTER);

browser.tabs.onRemoved.addListener(tabId => redirectByTab.delete(tabId));

function getRedirectInfo({ tabId }) {
  return Promise.resolve(redirectByTab.get(tabId) || null);
}

// ─── Google Search Console: OAuth + API ─────────────────────────────────────

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GSC_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GSC_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GSC_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GSC_API_BASE = 'https://www.googleapis.com/webmasters/v3';
const GSC_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

const GSC_SITES_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const GSC_STALE_MS = 6 * 60 * 60 * 1000;
const GSC_DEBOUNCE_MS = 60 * 1000;
const GSC_CACHE_LIMIT = 20;

function gscBase64UrlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getGscRedirectUri() {
  const redirectBase = browser.identity.getRedirectURL();
  const subdomain = new URL(redirectBase).hostname.split('.')[0];
  return `http://127.0.0.1/mozoauth2/${subdomain}`;
}

async function gscGetStatus() {
  const { gscAuth } = await browser.storage.local.get('gscAuth');
  return {
    connected: !!gscAuth,
    redirectUri: getGscRedirectUri(),
    connectedAt: gscAuth?.connectedAt ?? null
  };
}

async function gscConnect() {
  const { gscClientId, gscClientSecret } = await browser.storage.local.get(['gscClientId', 'gscClientSecret']);
  if (!gscClientId) return { error: 'NO_CLIENT_ID' };

  const redirectUri = getGscRedirectUri();

  const codeVerifier = gscBase64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
  const codeChallenge = gscBase64UrlEncode(challengeBytes);
  const state = gscBase64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

  const authUrl = new URL(GSC_AUTH_URL);
  authUrl.searchParams.set('client_id', gscClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GSC_SCOPE);
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

  const tokenRes = await fetch(GSC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString()
  });
  if (!tokenRes.ok) return { error: 'TOKEN_EXCHANGE_FAILED' };
  const tokenData = await tokenRes.json();

  await browser.storage.local.set({
    gscAuth: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      scope: tokenData.scope,
      connectedAt: Date.now()
    }
  });
  return { connected: true };
}

async function gscDisconnect() {
  const { gscAuth } = await browser.storage.local.get('gscAuth');
  if (gscAuth?.refreshToken) {
    try {
      await fetch(`${GSC_REVOKE_URL}?token=${encodeURIComponent(gscAuth.refreshToken)}`, { method: 'POST' });
    } catch { /* best-effort revoke */ }
  }
  await browser.storage.local.remove(['gscAuth', 'gscSites', 'gscCache', 'gscInspectionCache', 'gscQueryCache']);
  return { connected: false };
}

async function gscGetAccessToken() {
  const { gscAuth, gscClientId, gscClientSecret } = await browser.storage.local.get(['gscAuth', 'gscClientId', 'gscClientSecret']);
  if (!gscAuth) return { error: 'NOT_CONNECTED' };
  if (gscAuth.expiresAt > Date.now() + 60000) return { accessToken: gscAuth.accessToken };

  const body = new URLSearchParams({
    client_id: gscClientId,
    refresh_token: gscAuth.refreshToken,
    grant_type: 'refresh_token'
  });
  if (gscClientSecret) body.set('client_secret', gscClientSecret);

  const res = await fetch(GSC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) {
    if (res.status === 400) {
      await browser.storage.local.remove('gscAuth');
      return { error: 'REAUTH_REQUIRED' };
    }
    return { error: 'TOKEN_REFRESH_FAILED' };
  }
  const data = await res.json();
  const updated = { ...gscAuth, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  await browser.storage.local.set({ gscAuth: updated });
  return { accessToken: updated.accessToken };
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

function gscResolveSiteUrl(sites, pageUrl) {
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

  const siteUrl = gscResolveSiteUrl(sites, pageUrl);
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

  const siteUrl = gscResolveSiteUrl(sites, pageUrl);
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

// ─── Google Search Console: message handlers ────────────────────────────────

browser.runtime.onMessage.addListener((message) => {
  switch (message?.action) {
    case 'gscGetStatus':     return gscGetStatus();
    case 'gscConnect':       return gscConnect();
    case 'gscDisconnect':    return gscDisconnect();
    case 'gscGetPageData':   return gscGetPageData(message);
    case 'gscGetQueryData':  return gscGetQueryData(message);
    case 'getRedirectInfo':  return getRedirectInfo(message);
    default: return undefined;
  }
});
