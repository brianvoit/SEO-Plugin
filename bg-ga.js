// Part of the extension background — see bg-core.js for how these files load.
// Google Analytics (GA4).

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

// Drop cached GA data for this host so a newly-picked property takes effect.
async function gaClearCacheForHost(host) {
  const { gaCache } = await browser.storage.local.get('gaCache');
  if (!gaCache) return;
  let mutated = false;
  for (const key of Object.keys(gaCache)) {
    if (key.startsWith(`${host}::`)) { delete gaCache[key]; mutated = true; }
  }
  if (mutated) await browser.storage.local.set({ gaCache });
}

async function gaSetProperty({ host, property }) {
  if (!host) return { ok: false };
  const { gaPropertyOverrides } = await browser.storage.local.get('gaPropertyOverrides');
  const overrides = gaPropertyOverrides || {};
  if (property) overrides[host] = property; else delete overrides[host];
  await browser.storage.local.set({ gaPropertyOverrides: overrides });
  await gaClearCacheForHost(host);
  await clientRegistrySetBinding(host, 'gaProperty', property || null);
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
