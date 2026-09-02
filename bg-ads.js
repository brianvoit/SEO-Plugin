// Part of the extension background — see bg-core.js for how these files load.
// Google Ads: GAQL reads, negative-keyword writes, and Add Keywords.

// ─── Google Ads (GAQL) ────────────────────────────────────────────────────────
// Needs an OAuth grant (scope adwords), a developer token (from the Ads account
// API Center, approved by Google for production data), and — for MCC setups —
// the manager account's login-customer-id. Customer IDs are 10 digits, no dashes.

// Bump as Google sunsets versions. Google moved to monthly releases in Jan
// 2026, so a version now lasts roughly six months rather than a year — and
// there's no grace period: on the sunset date every call starts failing with
// "UNSUPPORTED_VERSION: Version vNN is deprecated. Requests to this version
// will be blocked." Seeing that on every Ads call means bump this to the
// newest generally available version (not the next one up, which just repeats
// the exercise a few months later).
const GA_ADS_API = 'https://googleads.googleapis.com/v25';
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

// Google Ads API error bodies put the actually-useful, field-specific
// message in error.details[] (a GoogleAdsFailure payload) — the top-level
// error.message is just the generic gRPC status text (e.g. "Request
// contains an invalid argument."), which doesn't say WHAT was invalid.
// Prefer the detailed per-error message when present, e.g. "REQUIRED:
// Missing required field." instead of the useless generic wrapper.
function adsErrorDetail(body) {
  const err = (Array.isArray(body) ? body[0] : body)?.error;
  if (!err) return null;
  for (const d of (err.details || [])) {
    const first = (d.errors || [])[0];
    if (first) {
      const code = first.errorCode ? Object.values(first.errorCode)[0] : null;
      return [code, first.message].filter(Boolean).join(': ') || err.message;
    }
  }
  return err.message;
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
    const msg = adsErrorDetail(body);
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
    const msg = adsErrorDetail(body);
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

async function adsClearCacheForHost(host) {
  const { adsCache } = await browser.storage.local.get('adsCache');
  if (!adsCache) return;
  let mutated = false;
  for (const k of Object.keys(adsCache)) { if (k.startsWith(`${host}::`)) { delete adsCache[k]; mutated = true; } }
  if (mutated) await browser.storage.local.set({ adsCache });
}

async function adsSetAccount({ host, account }) {
  if (!host) return { ok: false };
  const { adsAccountOverrides } = await browser.storage.local.get('adsAccountOverrides');
  const overrides = adsAccountOverrides || {};
  const digits = account ? adsDigits(account) : null;
  if (digits) overrides[host] = digits; else delete overrides[host];
  await browser.storage.local.set({ adsAccountOverrides: overrides });
  await adsClearCacheForHost(host);
  await clientRegistrySetBinding(host, 'adsAccount', digits);
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
    cache[cacheKey] = entry; await writeCache('adsCache', cache, GSC_CACHE_LIMIT);
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
  cache[cacheKey] = entry; await writeCache('adsCache', cache, GSC_CACHE_LIMIT);
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
// Enum values that mean "Google has no performance rating for this asset",
// as opposed to a rating. They are the API's way of saying null, and rendering
// them verbatim put a NOT_APPLICABLE chip on every row that read like a
// verdict. PENDING and LEARNING are deliberately NOT here — those are real
// states worth showing ("rated soon" / "still gathering data").
const ADS_NO_PERF_LABEL = new Set(['NOT_APPLICABLE', 'UNSPECIFIED', 'UNKNOWN']);
function adsPerfLabelOrNull(label) {
  const v = String(label || '').toUpperCase();
  return (!v || ADS_NO_PERF_LABEL.has(v)) ? null : label;
}

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
  // the only place the rating lives; an absent or non-rating label is stored as
  // null here so every consumer sees one representation of "not rated".
  const labelMap = new Map();
  (assetRes.rows || []).forEach(r => {
    const adId = String(r.adGroupAd?.ad?.id || '');
    const v = r.adGroupAdAssetView;
    const text = r.asset?.textAsset?.text;
    if (!adId || !v || text == null) return;
    if (!labelMap.has(adId)) labelMap.set(adId, new Map());
    labelMap.get(adId).set(`${v.fieldType}::${text}`, { label: adsPerfLabelOrNull(v.performanceLabel), enabled: v.enabled !== false });
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

// A lightweight, date-range-free sibling of adsGetPageData's final-URL
// matching above (line ~2976) — the Keyword Phrases panel's "Ad" chip only
// needs to know WHAT TEXT is running on ads targeting this page, not any
// performance metrics, so this skips the metrics query and date range
// entirely rather than reusing the heavier, cached-by-range adsGetPageData.
async function adsGetPageAdCopy({ pageUrl }) {
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

  const target = adsNormUrl(pageUrl);
  const adRes = await adsSearch(accessToken, customerId,
    `SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls
     FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'`);
  if (adRes.error) return { connected: true, error: adRes.error, detail: adRes.detail };

  const adIds = [];
  (adRes.rows || []).forEach(r => {
    const urls = (r.adGroupAd?.ad?.finalUrls) || [];
    if (urls.some(u => adsNormUrl(u) === target)) adIds.push(String(r.adGroupAd.ad.id));
  });
  if (!adIds.length) return { connected: true, texts: [] };

  const detail = await adsGetAdsDetail({ pageUrl, adIds });
  if (detail.error) return { connected: true, error: detail.error };

  const texts = [];
  Object.values(detail.ads || {}).forEach(ad => {
    (ad.headlines || []).forEach(h => { if (h.text) texts.push(h.text); });
    (ad.descriptions || []).forEach(d => { if (d.text) texts.push(d.text); });
  });
  return { connected: true, texts: [...new Set(texts)] };
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

// Every negative keyword already in force for the campaigns and ad groups that
// serve this page, so the Paid Action Plan cannot recommend adding an
// exclusion that is already there.
//
// A negative can live in three different places and Google surfaces them
// through three different resources — reading only one of them would still
// produce the wrong advice, so all three are read:
//   1. campaign_criterion   — a negative set directly on the campaign
//   2. ad_group_criterion   — a negative set directly on the ad group
//   3. shared_criterion     — a negative in a NEGATIVE_KEYWORDS exclusion list
//                             attached to the campaign (what adsAddNegatives
//                             writes into, so it is the likeliest home)
//
// Deduped to text::matchType, which is exactly the identity the write path
// uses to skip duplicates — the same term at a different match type is a
// genuinely different exclusion and is kept separately.
async function adsGetNegatives({ pageUrl, campaignIds, adGroupIds }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };
  const accessToken = tokenResult.accessToken;

  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT' };

  const camps = [...new Set((campaignIds || []).map(adsDigits).filter(Boolean))];
  const ags   = [...new Set((adGroupIds   || []).map(adsDigits).filter(Boolean))];
  if (!camps.length && !ags.length) return { connected: true, negatives: [] };

  // The shared-set lookup needs the campaigns' attached lists first, so it is
  // the one query that cannot go in the parallel batch below.
  let setIds = [];
  if (camps.length) {
    const setsRes = await adsSearch(accessToken, customerId,
      `SELECT shared_set.id FROM campaign_shared_set
       WHERE campaign.id IN (${camps.join(',')})
         AND shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`);
    if (!setsRes.error) {
      setIds = [...new Set((setsRes.rows || []).map(r => adsDigits(r.sharedSet?.id)).filter(Boolean))];
    }
  }

  // Every one of these is best-effort: adsSearch never throws, so an
  // unsupported field or a permissions gap yields empty rows and the plan
  // simply sees fewer negatives rather than failing to generate.
  const [campRes, agRes, setRes] = await Promise.all([
    camps.length ? adsSearch(accessToken, customerId,
      `SELECT campaign.id, campaign.name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
       FROM campaign_criterion
       WHERE campaign.id IN (${camps.join(',')})
         AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`) : { rows: [] },
    ags.length ? adsSearch(accessToken, customerId,
      `SELECT ad_group.id, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
       FROM ad_group_criterion
       WHERE ad_group.id IN (${ags.join(',')})
         AND ad_group_criterion.negative = TRUE AND ad_group_criterion.type = 'KEYWORD'`) : { rows: [] },
    setIds.length ? adsSearch(accessToken, customerId,
      `SELECT shared_set.id, shared_set.name, shared_criterion.keyword.text, shared_criterion.keyword.match_type
       FROM shared_criterion WHERE shared_set.id IN (${setIds.join(',')})`) : { rows: [] }
  ]);

  const byKey = new Map();
  const add = (text, matchType, scope, where) => {
    const t = String(text || '').trim();
    if (!t) return;
    const mt = String(matchType || 'BROAD').toUpperCase();
    const key = `${t.toLowerCase()}::${mt}`;
    const hit = byKey.get(key);
    if (hit) { if (where && !hit.where.includes(where)) hit.where.push(where); return; }
    byKey.set(key, { text: t, matchType: mt, scope, where: where ? [where] : [] });
  };

  (campRes.rows || []).forEach(r => add(
    r.campaignCriterion?.keyword?.text, r.campaignCriterion?.keyword?.matchType,
    'campaign', r.campaign?.name));
  (agRes.rows || []).forEach(r => add(
    r.adGroupCriterion?.keyword?.text, r.adGroupCriterion?.keyword?.matchType,
    'ad group', r.adGroup?.name));
  (setRes.rows || []).forEach(r => add(
    r.sharedCriterion?.keyword?.text, r.sharedCriterion?.keyword?.matchType,
    'list', r.sharedSet?.name));

  return { connected: true, negatives: [...byKey.values()] };
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
    `SELECT ad_group_criterion.keyword.text, ad_group.name, campaign.name
     FROM keyword_view
     WHERE ad_group_criterion.status != 'REMOVED' AND campaign.status = 'ENABLED'`);
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const texts = [];
  const seen = new Set();
  // Where each term already lives. Callers building a NEW ad group need this:
  // silently hiding an already-targeted suggestion looks like a weak
  // recommendation engine, whereas "already in Brand — Roofing" lets the user
  // choose between moving it, duplicating it, and skipping it. First occurrence
  // wins; a term in several ad groups is reported by one of them.
  const placements = {};
  for (const r of (res.rows || [])) {
    const text = (r.adGroupCriterion?.keyword?.text || '').toLowerCase().trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
    placements[text] = r.adGroup?.name || r.campaign?.name || 'this account';
  }

  return { connected: true, texts, placements };
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

// ─── Build ads for an unadvertised page ──────────────────────────────────────
// When no ad points at the current page the Ads tab has nothing to show, and
// Add Keywords degrades to research-only because it has no ad group to write
// to. These three handlers give that research somewhere to land: pick an
// existing Search campaign, and create an ad group + responsive search ad +
// keywords under it in one shot.
//
// Creating a CAMPAIGN is deliberately out of scope — budget, bidding strategy,
// geo and schedule are a much larger surface and a much larger blast radius.

// Every campaign type that can hold a keyword-targeted RSA ad group. Anything
// else (PERFORMANCE_MAX, SHOPPING, DISPLAY, DEMAND_GEN, VIDEO…) either has no
// ad groups at all or rejects keyword criteria, and picking one would surface
// as an opaque API error at write time — so they're filtered out with a reason
// rather than offered and allowed to fail.
const ADS_BUILDABLE_CHANNELS = new Set(['SEARCH']);

// Bidding strategies where an ad-group-level CPC bid is actually honoured.
// Under the automated strategies the field is ignored (or rejected), so the UI
// hides the bid input rather than collecting a number that does nothing.
const ADS_MANUAL_BID_STRATEGIES = new Set(['MANUAL_CPC', 'MANUAL_CPM', 'MANUAL_CPV']);

function adsChannelLabel(type) {
  return String(type || 'UNKNOWN').replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Campaigns in the page's account, split into ones that can take a new ad
// group and ones that can't. The excluded list is returned too — telling the
// user "your only campaign is Performance Max" is far more useful than an
// empty picker.
async function adsListCampaignsForBuild({ pageUrl }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };

  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT' };
  const cid = adsDigits(customerId);

  const res = await adsSearch(tokenResult.accessToken, cid,
    `SELECT campaign.id, campaign.name, campaign.status,
            campaign.advertising_channel_type, campaign.bidding_strategy_type,
            campaign_budget.amount_micros, campaign_budget.period
     FROM campaign
     WHERE campaign.status IN ('ENABLED', 'PAUSED')
     ORDER BY campaign.name`);
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  const eligible = [];
  const excluded = [];
  for (const row of (res.rows || [])) {
    const c = row.campaign || {};
    const channel = c.advertisingChannelType || null;
    const entry = {
      campaignId: c.id != null ? String(c.id) : null,
      campaignName: c.name || null,
      status: c.status || null,
      channelType: channel,
      channelLabel: adsChannelLabel(channel),
      biddingStrategy: c.biddingStrategyType || null,
      // Ad-group CPC bids only apply under a manual strategy; the UI uses this
      // to decide whether to ask for a bid at all.
      acceptsCpcBid: ADS_MANUAL_BID_STRATEGIES.has(String(c.biddingStrategyType || '')),
      budgetMicros: row.campaignBudget?.amountMicros != null ? Number(row.campaignBudget.amountMicros) : null,
      budgetPeriod: row.campaignBudget?.period || null
    };
    if (!entry.campaignId) continue;
    if (ADS_BUILDABLE_CHANNELS.has(String(channel))) eligible.push(entry);
    else excluded.push(entry);
  }
  return { connected: true, eligible, excluded };
}

// Existing ad group names, so the UI can suggest a name that matches whatever
// convention the account already uses instead of inventing its own.
async function adsGetCampaignAdGroupNames({ pageUrl, campaignId }) {
  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error) return { names: [] };
  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { names: [] };

  const res = await adsSearch(tokenResult.accessToken, adsDigits(customerId),
    `SELECT ad_group.name FROM ad_group
     WHERE campaign.id = ${adsDigits(campaignId)} AND ad_group.status != 'REMOVED'
     ORDER BY ad_group.name`);
  // Naming help is a nicety — never surface an error for it.
  return { names: (res.rows || []).map(r => r.adGroup?.name).filter(Boolean) };
}

// Google's RSA limits. Below the minimums the ad is rejected outright; above
// the maximums the extra assets are dropped silently, which is worse.
const RSA_LIMITS = {
  headline:    { max: 30, min: 3,  cap: 15 },
  description: { max: 90, min: 2,  cap: 4  }
};

// Trim, de-duplicate (case-insensitively) and length-check one asset list.
// Returns { ok, assets, error } — the caller stops before touching the API if
// this fails, so a miscounted character never becomes an opaque API error.
function rsaAssets(list, kind) {
  const spec = RSA_LIMITS[kind];
  const seen = new Set();
  const assets = [];
  for (const raw of (list || [])) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;      // Google rejects duplicate assets
    seen.add(key);
    if (text.length > spec.max) {
      return { ok: false, error: `${kind} over ${spec.max} characters (${text.length}): "${text}"` };
    }
    assets.push({ text });
    if (assets.length >= spec.cap) break;
  }
  if (assets.length < spec.min) {
    return { ok: false, error: `Need at least ${spec.min} ${kind}s, got ${assets.length}.` };
  }
  return { ok: true, assets };
}

// Atomic multi-resource write. Unlike adsMutate (one resource type per call,
// no dry run), googleAds:mutate takes operations across resource types in a
// single transaction and supports validateOnly — so an ad group, its ad and
// its keywords are created together or not at all, and can be checked first.
// Without this a partial failure would strand an orphaned empty ad group.
async function adsMutateOperations(accessToken, cid, mutateOperations, { validateOnly = false } = {}) {
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
    res = await fetch(`${GA_ADS_API}/customers/${adsDigits(cid)}/googleAds:mutate`, {
      method: 'POST',
      headers,
      // partialFailure stays false on purpose: a half-created ad group is
      // worse than a clean failure the user can retry.
      body: JSON.stringify({ mutateOperations, validateOnly, partialFailure: false })
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (res.status === 429) return { error: 'RATE_LIMITED' };
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: 'API_ERROR', detail: adsErrorDetail(body) || `HTTP ${res.status}` };
  }
  const data = await res.json();
  return { results: data.mutateOperationResponses || [] };
}

// Build an ad group + responsive search ad + keywords under an existing
// campaign, in one atomic operation.
//
// `validateOnly: true` runs the identical request as a dry run — Google checks
// everything and writes nothing — which is what the UI uses to preview before
// the real commit. Both paths go through the same operation list, so the
// preview can't drift from what actually gets written.
//
// Everything is created PAUSED. This writes to an account that spends real
// money, and nothing should start serving because someone clicked through a
// panel; enabling is a deliberate, separate act in the Ads UI.
async function adsCreateAdGroup(message) {
  const {
    pageUrl, campaignId, adGroupName, finalUrl,
    headlines, descriptions, keywords, cpcBidMicros, validateOnly
  } = message || {};

  if (!campaignId) return { connected: true, error: 'NO_CAMPAIGN' };
  const name = String(adGroupName || '').trim();
  if (!name) return { connected: true, error: 'INVALID', detail: 'Ad group name is required.' };

  // The ad points wherever the user is standing; the caller passes the URL
  // already resolved through any redirect chain, so ads never land on a hop.
  const dest = String(finalUrl || pageUrl || '').trim();
  if (!/^https?:\/\//i.test(dest)) {
    return { connected: true, error: 'INVALID', detail: 'A valid http(s) final URL is required.' };
  }

  const head = rsaAssets(headlines, 'headline');
  if (!head.ok) return { connected: true, error: 'INVALID', detail: head.error };
  const desc = rsaAssets(descriptions, 'description');
  if (!desc.ok) return { connected: true, error: 'INVALID', detail: desc.error };

  const tokenResult = await adsGetAccessToken();
  if (tokenResult.error === 'NOT_CONNECTED') return { connected: false };
  if (tokenResult.error === 'REAUTH_REQUIRED') return { connected: false, reauthRequired: true };
  if (tokenResult.error) return { connected: true, error: tokenResult.error };

  const customerId = await adsGetAccount(gscPageHost(pageUrl));
  if (!customerId) return { connected: true, error: 'NO_ACCOUNT' };
  const cid = adsDigits(customerId);

  // A negative id is a temporary resource name: later operations in the same
  // request refer to the ad group by it, and Google substitutes the real id.
  const TEMP_AD_GROUP = `customers/${cid}/adGroups/-1`;

  const adGroup = {
    resourceName: TEMP_AD_GROUP,
    name,
    campaign: `customers/${cid}/campaigns/${adsDigits(campaignId)}`,
    status: 'PAUSED',
    type: 'SEARCH_STANDARD'
  };
  // Only meaningful under a manual bidding strategy; the caller omits it
  // otherwise rather than sending a value the campaign would ignore.
  if (cpcBidMicros != null && Number.isFinite(Number(cpcBidMicros))) {
    adGroup.cpcBidMicros = String(Math.round(Number(cpcBidMicros)));
  }

  const ops = [
    { adGroupOperation: { create: adGroup } },
    { adGroupAdOperation: { create: {
      adGroup: TEMP_AD_GROUP,
      status: 'PAUSED',
      ad: { finalUrls: [dest], responsiveSearchAd: { headlines: head.assets, descriptions: desc.assets } }
    } } }
  ];

  // Keywords are ENABLED — the paused ad group already stops everything, and
  // leaving them paused too would mean a second cleanup pass later.
  const wantedKeywords = [];
  const seenKeyword = new Set();
  for (const k of (keywords || [])) {
    const text = String(k?.text || '').trim();
    if (!text) continue;
    const matchType = negMatchType(k.matchType);
    const key = `${text.toLowerCase()}::${matchType}`;
    if (seenKeyword.has(key)) continue;
    seenKeyword.add(key);
    wantedKeywords.push({ text, matchType });
    ops.push({ adGroupCriterionOperation: { create: {
      adGroup: TEMP_AD_GROUP, status: 'ENABLED', keyword: { text, matchType }
    } } });
  }

  const res = await adsMutateOperations(tokenResult.accessToken, cid, ops, { validateOnly: !!validateOnly });
  if (res.error) return { connected: true, error: res.error, detail: res.detail };

  // A dry run returns empty responses by design — report what WOULD be made.
  if (validateOnly) {
    return {
      connected: true, validated: true,
      adGroupName: name, finalUrl: dest,
      headlines: head.assets.map(a => a.text),
      descriptions: desc.assets.map(a => a.text),
      keywords: wantedKeywords
    };
  }

  // Pull the real ad group id back out of the first operation's response so
  // the UI can deep-link to it.
  const created = (res.results || [])[0]?.adGroupResult?.resourceName || null;
  const newAdGroupId = created ? created.split('/').pop() : null;

  return {
    connected: true, created: true,
    adGroupId: newAdGroupId, adGroupName: name, finalUrl: dest,
    headlines: head.assets.map(a => a.text),
    descriptions: desc.assets.map(a => a.text),
    keywords: wantedKeywords
  };
}
