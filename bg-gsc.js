// Part of the extension background — see bg-core.js for how these files load.
// Google Search Console.

// ─── Google Search Console: OAuth + API ─────────────────────────────────────

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GSC_API_BASE = 'https://www.googleapis.com/webmasters/v3';
const GSC_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

const GSC_SITES_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const GSC_STALE_MS = 6 * 60 * 60 * 1000;
const GSC_DEBOUNCE_MS = 60 * 1000;

async function gscGetStatus() {
  const { gscAuth } = await browser.storage.local.get('gscAuth');
  return {
    connected: !!gscAuth,
    redirectUri: getGoogleRedirectUri(),
    connectedAt: gscAuth?.connectedAt ?? null,
    email: gscAuth ? await googleEnsureEmail('gscAuth') : null,
    // Lets Setup present the OAuth Client drawer as optional rather than as a
    // required first step, on builds that ship a default client.
    hasBundledOAuth: hasBundledOAuthClient()
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
  await clientRegistrySetBinding(host, 'gscProperty', siteUrl || null);
  return { ok: true };
}

// Full, unfiltered property list (gscResolveProperty only returns the ones
// already matching the current page's host) — used by the Client panel,
// which needs to bind a GSC property to a domain it isn't currently viewing.
async function gscListProperties() {
  const tokenResult = await gscGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  try {
    const sites = await gscFetchSites(tokenResult.accessToken);
    return { connected: true, sites };
  } catch (err) {
    return { connected: true, error: err.code || 'API_ERROR', detail: err.detail };
  }
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

// GSC's `page` dimension holds the exact URL Google indexed and served. When a
// domain has several verified variants (http/https × www/non-www) — and above
// all under a `sc-domain:` property, which aggregates data across ALL of them —
// the rows can carry any variant. An `equals` filter pins to one exact string,
// so it silently returns zero rows whenever Google indexed a different variant
// than the one being browsed (data visible in the GSC UI, missing here).
//
// Match every variant instead, via an anchored regex (RE2): scheme and `www.`
// are optional and a trailing slash is tolerated, but ^...$ keeps /about from
// matching /about-us. Query strings are part of the indexed URL, so when one is
// present it must match exactly.
function gscPageFilterEntry(pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch { return null; }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const host = esc(u.hostname.replace(/^www\./, '').toLowerCase());
  const path = u.pathname.replace(/\/+$/, '');            // '' for the root
  const tail = u.search ? esc(path + u.search) : `${esc(path)}/?`;
  return { dimension: 'page', operator: 'includingRegex', expression: `^https?://(www\\.)?${host}${tail}$` };
}

// Same, wrapped as a ready dimensionFilterGroups body fragment. A malformed URL
// degrades to today's exact-match behaviour rather than dropping the filter
// (which would silently widen every query to the whole property).
function gscPageFilter(pageUrl) {
  const filter = gscPageFilterEntry(pageUrl)
    || { dimension: 'page', operator: 'equals', expression: pageUrl };
  return { dimensionFilterGroups: [{ filters: [filter] }] };
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
  const pageFilter = gscPageFilter(pageUrl);

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
      gscPageFilterEntry(pageUrl) || { dimension: 'page', operator: 'equals', expression: pageUrl },
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
  const pageFilter = gscPageFilter(pageUrl);

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
  const pageFilter = gscPageFilter(pageUrl);

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
  const filters = [gscPageFilterEntry(pageUrl) || { dimension: 'page', operator: 'equals', expression: pageUrl }];
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
