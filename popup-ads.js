// Google Ads (GAQL) tab: the paid campaigns / ad groups / ads pointing at the
// evaluated page, plus the keywords and search terms driving it. Mirrors the
// Analytics tab's look-back + per-domain account picker, and reuses the Search
// tab's on-page location flags (gscQueryLocations).

let adsSelectedRange = 30;
let _adsHost = null;
let _adsData = null;                                   // last adsGetPageData response
let _adsFilter = null;                                 // { type:'adGroup'|'keyword'|'searchTerm', ... } | null
let _adsTermIntent = null;                             // Search Terms intent filter (null = All)
let _adsFilled = [];                                   // chart timeseries currently displayed
let adsActiveMetrics = { impressions: true, clicks: true, cost: true, conversions: true };

const ADS_TOKEN_HELP = 'https://developers.google.com/google-ads/api/docs/get-started/dev-token';

const ADS_ERROR_MESSAGES = {
  RATE_LIMITED: 'Google Ads API rate limit reached. Try again in a moment.',
  API_ERROR: 'Google Ads API error.',
  NETWORK: 'Network error talking to Google Ads.',
  NO_DEV_TOKEN: 'Add your Google Ads developer token in Settings.',
  TOKEN_REFRESH_FAILED: 'Could not refresh your Google connection. Reconnect in Settings.'
};
function adsErrorMessage(error, detail) {
  const base = ADS_ERROR_MESSAGES[error] || `Google Ads error: ${error}`;
  return detail ? `${base} (${detail})` : base;
}

// ─── Formatting ────────────────────────────────────────────────────────────────

function adsNum(n) { return Math.round(n).toLocaleString(); }
function adsConv(n) { return (Math.round(n * 10) / 10).toLocaleString(); }
// Cost is rounded UP to the nearest whole unit (no decimals)
function adsCost(n, currency) {
  const v = Math.ceil(n || 0);
  if (currency) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v); }
    catch { /* fall through */ }
  }
  return '$' + v.toLocaleString();
}
function adsPct(v) { return v == null ? '—' : `${Math.round(v * 100)}%`; }
// Google Ads customer IDs are 10 digits, shown as XXX-XXX-XXXX
function formatAdsId(id) {
  const d = String(id).replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(id);
}

// Organic overlap: queries this page also ranks for in Search Console
function adsOrganicSet() {
  const set = new Set();
  if (typeof _gscQueries !== 'undefined' && Array.isArray(_gscQueries)) {
    _gscQueries.forEach(q => set.add((q.query || '').toLowerCase().trim()));
  }
  return set;
}

// Chips for a keyword/search term: on-page locations, an Organic pill, and a
// "Tracked" pill when the term is tracked in the Web CEO project.
function adsTermChips(text, organicSet) {
  const wrap = document.createElement('span');
  wrap.className = 'gsc-query-chips';
  if (organicSet.has((text || '').toLowerCase().trim())) {
    const pill = document.createElement('span');
    pill.className = 'gsc-branded-pill ads-organic-pill';
    pill.textContent = 'Organic';
    pill.title = 'This page also ranks for this term organically (Search Console)';
    wrap.appendChild(pill);
  }
  if (typeof webceoIsTracked === 'function' && webceoIsTracked(text)) {
    const pill = document.createElement('span');
    pill.className = 'gsc-branded-pill ads-tracked-pill';
    pill.textContent = 'Tracked';
    pill.title = 'Tracked in your Web CEO project';
    wrap.appendChild(pill);
  }
  (typeof gscQueryLocations === 'function' ? gscQueryLocations(text, pageData) : []).forEach(loc => {
    const chip = document.createElement('span');
    chip.className = 'gsc-chip';
    chip.textContent = loc;
    wrap.appendChild(chip);
  });
  return wrap.childNodes.length ? wrap : null;
}

// ─── Cross-tab signals: ad keyword set (for "Ad" chips elsewhere) ─────────────

let _adsKeywordSet = null;          // lowercased ad keyword texts, or null (unloaded)
let _adsKeywordLoading = false;

function adsIsBidKeyword(term) {
  return !!(_adsKeywordSet && _adsKeywordSet.has((term || '').toLowerCase().trim()));
}

// Loads the page's ad keywords once so other tabs can flag "Ad" terms
async function ensureAdsKeywordSet(onReady) {
  // Already loaded or in flight → do nothing (avoids re-render recursion: the
  // callback re-renders, which would call this loader, which would call back…).
  if (_adsKeywordSet || _adsKeywordLoading) return;
  _adsKeywordLoading = true;
  try {
    const tab = await getActiveTab();
    const res = await browser.runtime.sendMessage({ action: 'adsGetPageData', pageUrl: tab.url, range: adsSelectedRange });
    const set = new Set();
    if (res && res.keywords) res.keywords.forEach(k => { if (k.text) set.add(k.text.toLowerCase().trim()); });
    _adsKeywordSet = set;
  } catch { _adsKeywordSet = new Set(); }
  _adsKeywordLoading = false;
  if (onReady) onReady();
}

// ─── Cross-filter helpers ───────────────────────────────────────────────────
// Selecting an ad group / keyword / search term filters the chart and the other
// two lists. Matching is client-side off the association fields the background
// returns (adGroupId on everything; criterionId on keywords; triggering keyword
// text on search terms).

function adsFilterLabel() {
  if (!_adsFilter) return '';
  return _adsFilter.label || _adsFilter.text || '';
}

function adsAdGroupVisible(adGroupId) {
  const f = _adsFilter;
  if (!f) return true;
  return f.adGroupId ? adGroupId === f.adGroupId : true;
}
function adsKeywordVisible(kw) {
  const f = _adsFilter;
  if (!f) return true;
  if (f.type === 'keyword')    return kw.criterionId === f.criterionId;
  if (f.type === 'searchTerm') return kw.adGroupId === f.adGroupId && (kw.text || '').toLowerCase() === (f.keyword || '').toLowerCase();
  return kw.adGroupId === f.adGroupId;   // adGroup filter
}
function adsTermVisible(t) {
  const f = _adsFilter;
  if (!f) return true;
  if (f.type === 'searchTerm') return t.text === f.text && t.adGroupId === f.adGroupId;
  if (f.type === 'keyword')    return t.adGroupId === f.adGroupId && (t.keyword || '').toLowerCase() === (f.text || '').toLowerCase();
  return t.adGroupId === f.adGroupId;    // adGroup filter
}

function setAdsFilter(filter) {
  // Toggle off if the same thing is clicked again
  const same = _adsFilter && filter && _adsFilter.type === filter.type &&
    (_adsFilter.criterionId || _adsFilter.text) === (filter.criterionId || filter.text) &&
    _adsFilter.adGroupId === filter.adGroupId;
  _adsFilter = same ? null : filter;
  renderAdsAll();
  refreshAdsChart();
}

// ─── Ads-pointing-here table (one row per ad group) ─────────────────────────────

const ADS_AG_GRID = '1fr 56px 50px 64px 48px';

function renderAdsTree() {
  const root = document.getElementById('ads-tree');
  root.replaceChildren();
  const ads = (_adsData.ads || []).filter(a => adsAdGroupVisible(a.adGroupId));
  const isByCampaign = new Map((_adsData.campaigns || []).map(c => [c.id, c]));
  const currency = _adsData.currency;

  // header
  const header = document.createElement('div');
  header.className = 'ads-row ads-row--ag ads-row--header';
  ['Ad group', 'Impr', 'Clicks', 'Cost', 'Conv'].forEach((c, i) => {
    const cell = document.createElement('span');
    // Impr stays right-aligned; Clicks/Cost/Conv are centered
    cell.className = i === 0 ? 'ads-cell-term' : ('ads-cell-num' + (i >= 2 ? ' ads-cell-num--c' : ''));
    cell.textContent = c;
    header.appendChild(cell);
  });
  root.appendChild(header);

  // aggregate ads → campaign → ad group
  const byCampaign = new Map();
  ads.forEach(a => {
    if (!byCampaign.has(a.campaignId)) byCampaign.set(a.campaignId, { name: a.campaign, groups: new Map() });
    const groups = byCampaign.get(a.campaignId).groups;
    if (!groups.has(a.adGroupId)) groups.set(a.adGroupId, { id: a.adGroupId, name: a.adGroup, impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    const g = groups.get(a.adGroupId);
    g.impressions += a.impressions; g.clicks += a.clicks; g.cost += a.cost; g.conversions += a.conversions;
  });

  byCampaign.forEach((camp, campId) => {
    const cRow = document.createElement('div');
    cRow.className = 'ads-campaign';
    const cName = document.createElement('span');
    cName.className = 'ads-campaign-name';
    cName.textContent = camp.name;
    cRow.appendChild(cName);
    const is = isByCampaign.get(campId);
    if (is && is.impressionShare != null) {
      const chip = document.createElement('span');
      chip.className = 'ads-is-chip';
      chip.textContent = `IS ${adsPct(is.impressionShare)}`;
      chip.title = `Search impression share ${adsPct(is.impressionShare)}` +
        (is.lostRank != null ? ` · lost to rank ${adsPct(is.lostRank)}` : '') +
        (is.lostBudget != null ? ` · lost to budget ${adsPct(is.lostBudget)}` : '');
      cRow.appendChild(chip);
    }
    root.appendChild(cRow);

    camp.groups.forEach(g => {
      const row = document.createElement('div');
      row.className = 'ads-row ads-row--ag ads-row--click' +
        (_adsFilter && _adsFilter.type === 'adGroup' && _adsFilter.adGroupId === g.id ? ' ads-row--active' : '');
      const name = document.createElement('span');
      name.className = 'ads-cell-term ads-term-text';
      name.textContent = g.name;
      name.title = g.name;
      row.appendChild(name);
      [adsNum(g.impressions), adsNum(g.clicks), adsCost(g.cost, currency), adsConv(g.conversions)].forEach((v, i) => {
        const cell = document.createElement('span');
        cell.className = 'ads-cell-num' + (i >= 1 ? ' ads-cell-num--c' : '');   // Impr right, rest centered
        cell.textContent = v;
        row.appendChild(cell);
      });
      row.addEventListener('click', () => setAdsFilter({ type: 'adGroup', adGroupId: g.id, label: g.name }));
      root.appendChild(row);
    });
  });
}

// ─── Keyword + search-term tables (sortable, default Impr desc) ────────────────

// Match type as punctuation on the keyword: broad = none, "phrase", [exact]
function adsFormatKeyword(text, matchType) {
  const mt = (matchType || '').toUpperCase();
  if (mt === 'EXACT')  return `[${text}]`;
  if (mt === 'PHRASE') return `"${text}"`;
  return text;
}

const ADS_KW_COLS = [
  { key: 'text', label: 'Keyword', term: true },
  { key: 'qualityScore', label: 'QS' },
  { key: 'impressions', label: 'Impr' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'cost', label: 'Cost' },
  { key: 'conversions', label: 'Conv' }
];
const ADS_TERM_COLS = [
  { key: 'text', label: 'Search term', term: true },
  { key: 'impressions', label: 'Impr' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'cost', label: 'Cost' },
  { key: 'conversions', label: 'Conv' }
];

function buildAdsMetricTable(container, rows, { withQs = false, intentFilter = null } = {}) {
  const cols = withQs ? ADS_KW_COLS : ADS_TERM_COLS;
  if (!container._sort) container._sort = { column: 'impressions', dir: 'desc' };
  const sort = container._sort;
  const organic = adsOrganicSet();

  const render = () => {
    container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'ads-row ads-row--header' + (withQs ? ' ads-row--kw' : '');
    cols.forEach(c => {
      const cell = document.createElement('span');
      const centered = ['clicks', 'cost', 'conversions'].includes(c.key);
      cell.className = (c.term ? 'ads-cell-term' : ('ads-cell-num' + (centered ? ' ads-cell-num--c' : ''))) + ' ads-sort';
      const active = sort.column === c.key;
      cell.textContent = c.label + (active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
      cell.addEventListener('click', () => {
        if (sort.column === c.key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else { sort.column = c.key; sort.dir = c.term ? 'asc' : 'desc'; }
        render();
      });
      header.appendChild(cell);
    });
    container.appendChild(header);

    const visible = rows.filter(r =>
      (withQs ? adsKeywordVisible(r) : adsTermVisible(r)) &&
      (!intentFilter || intentOf(r.text) === intentFilter));
    const sorted = visible.sort((a, b) => {
      if (sort.column === 'text') {
        const av = (a.text || '').toLowerCase(), bv = (b.text || '').toLowerCase();
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const av = a[sort.column] == null ? -Infinity : a[sort.column];
      const bv = b[sort.column] == null ? -Infinity : b[sort.column];
      return sort.dir === 'asc' ? av - bv : bv - av;
    });

    sorted.forEach(r => {
      const row = document.createElement('div');
      const isActive = _adsFilter && (withQs
        ? (_adsFilter.type === 'keyword' && _adsFilter.criterionId === r.criterionId)
        : (_adsFilter.type === 'searchTerm' && _adsFilter.text === r.text && _adsFilter.adGroupId === r.adGroupId));
      row.className = 'ads-row ads-row--click' + (withQs ? ' ads-row--kw' : '') + (isActive ? ' ads-row--active' : '');

      // term + chips on one line; the term text itself opens a Google search
      const term = document.createElement('span');
      term.className = 'ads-cell-term';
      const label = document.createElement('span');
      label.textContent = withQs ? adsFormatKeyword(r.text, r.matchType) : (r.text || '(none)');
      if (r.text) {
        label.className = 'ads-term-text ads-term-link';
        label.title = `Search Google for “${r.text}”`;
        label.addEventListener('click', (e) => {
          e.stopPropagation();   // don't also trigger the row's cross-filter
          browser.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(r.text)}` });
        });
      } else {
        label.className = 'ads-term-text';
      }
      term.appendChild(label);
      const chips = adsTermChips(r.text, organic);
      if (chips) term.appendChild(chips);
      row.appendChild(term);

      if (withQs) {
        const qs = document.createElement('span');
        qs.className = 'ads-cell-num';
        qs.textContent = r.qualityScore != null ? r.qualityScore : '—';
        row.appendChild(qs);
      }

      [adsNum(r.impressions), adsNum(r.clicks), adsCost(r.cost, container._currency), adsConv(r.conversions)].forEach((v, i) => {
        const cell = document.createElement('span');
        cell.className = 'ads-cell-num' + (i >= 1 ? ' ads-cell-num--c' : '');   // Impr right, rest centered
        cell.textContent = v;
        row.appendChild(cell);
      });

      row.addEventListener('click', () => {
        if (withQs) setAdsFilter({ type: 'keyword', text: r.text, matchType: r.matchType, adGroupId: r.adGroupId, criterionId: r.criterionId, label: adsFormatKeyword(r.text, r.matchType) });
        else setAdsFilter({ type: 'searchTerm', text: r.text, adGroupId: r.adGroupId, keyword: r.keyword, label: r.text });
      });
      container.appendChild(row);
    });

    // Search-term table loads the top 25 first; offer to pull the rest
    if (!withQs && !_adsFilter && _adsData && _adsData.searchTermsLimited) {
      const more = document.createElement('button');
      more.className = 'gsc-more-queries-btn';
      more.textContent = 'Request more';
      more.addEventListener('click', () => requestMoreAdsSearchTerms(more));
      container.appendChild(more);
    }
  };

  render();
}

// Pull the full search-term list (beyond the initial top 25) and re-render
async function requestMoreAdsSearchTerms(btn) {
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const tab = await getActiveTab();
    const res = await browser.runtime.sendMessage({ action: 'adsGetMoreSearchTerms', pageUrl: tab.url, range: adsSelectedRange });
    if (res && res.searchTerms) {
      _adsData.searchTerms = res.searchTerms;
      _adsData.searchTermsLimited = res.searchTermsLimited;
      const tt = document.getElementById('ads-terms-table');
      tt._currency = _adsData.currency;
      const terms = _adsData.searchTerms;
      renderIntentChips(document.getElementById('ads-terms-intent'), terms.filter(adsTermVisible), t => t.text, _adsTermIntent, (intent) => {
        _adsTermIntent = intent;
        renderAdsAll();
      });
      buildAdsMetricTable(tt, terms, { intentFilter: _adsTermIntent });
      ensureIntents(terms.map(t => t.text), () => renderAdsAll());
      return;
    }
  } catch { /* fall through to re-enable */ }
  btn.disabled = false;
  btn.textContent = 'Request more';
}

// ─── Top chart + scorecards (same engine as GA/GSC) ────────────────────────────

// buildCombinedChart / attachChartHover metric config. Cost gets a $ axis; the
// per-metric colours come from CSS [data-metric="…"] (impressions/clicks via the
// shared vars, cost→--chart-position, conversions→--chart-conv).
const ADS_METRICS = {
  impressions: { label: 'Impressions', format: v => adsNum(v) },
  clicks:      { label: 'Clicks',      format: v => adsNum(v) },
  cost:        { label: 'Cost',        format: v => adsCost(v, _adsData && _adsData.currency),
                 axisFormat: v => '$' + chartAxisNum(v) },
  conversions: { label: 'Conversions', format: v => adsConv(v) }
};
const ADS_METRIC_ORDER = ['impressions', 'clicks', 'cost', 'conversions'];

// Empty day shape for gaps in the series
function adsEmptyDay(date) { return { date, impressions: 0, clicks: 0, cost: 0, conversions: 0 }; }

function adsSumTs(ts) {
  return ts.reduce((a, d) => ({
    impressions: a.impressions + d.impressions, clicks: a.clicks + d.clicks,
    cost: a.cost + d.cost, conversions: a.conversions + d.conversions
  }), { impressions: 0, clicks: 0, cost: 0, conversions: 0 });
}

// Client-side fill over the active look-back (mirrors the background filler) for
// the ad-group case, which we aggregate from tsRows without a re-query.
function adsFillClient(byDate) {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const out = [];
  for (let i = adsSelectedRange - 1; i >= 0; i--) {
    const d = new Date(end); d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDate[key] || adsEmptyDay(key));
  }
  return out;
}

function renderAdsScorecards(totals, previousTotals) {
  const t = totals || adsEmptyDay(null);
  const p = previousTotals || {};
  document.getElementById('ads-total-impressions').textContent = adsNum(t.impressions);
  document.getElementById('ads-total-clicks').textContent = adsNum(t.clicks);
  document.getElementById('ads-total-cost').textContent = adsCost(t.cost, _adsData && _adsData.currency);
  document.getElementById('ads-total-conversions').textContent = adsConv(t.conversions);
  // No prior-period baseline when a filter is active → blank the deltas
  const hasPrev = previousTotals != null;
  renderGscChange('ads-change-impressions', hasPrev ? t.impressions : null, hasPrev ? p.impressions : null);
  renderGscChange('ads-change-clicks',      hasPrev ? t.clicks : null,      hasPrev ? p.clicks : null);
  renderGscChange('ads-change-cost',        hasPrev ? t.cost : null,        hasPrev ? p.cost : null);
  renderGscChange('ads-change-conversions', hasPrev ? t.conversions : null, hasPrev ? p.conversions : null);
}

function renderAdsChart() {
  const container = document.getElementById('ads-chart-combined');
  if (!container) return;
  if (!_adsFilled.length) { container.replaceChildren(); return; }
  const width = container.clientWidth || 320;
  const built = buildCombinedChart(_adsFilled, adsActiveMetrics, { width, metrics: ADS_METRICS });
  container.replaceChildren(svgFromString(built.svg));
  attachChartHover(container.querySelector('svg'), _adsFilled, adsActiveMetrics, built);
}

// Recompute the displayed series + scorecards for the current filter, then draw.
async function refreshAdsChart() {
  if (!_adsData) return;
  const f = _adsFilter;
  let ts, totals, prev;

  if (!f) {
    ts = _adsData.timeseries || []; totals = _adsData.totals; prev = _adsData.previousTotals;
  } else if (f.type === 'adGroup') {
    const byDate = {};
    (_adsData.tsRows || []).filter(r => r.adGroupId === f.adGroupId).forEach(r => {
      if (!byDate[r.date]) byDate[r.date] = adsEmptyDay(r.date);
      byDate[r.date].impressions += r.impressions; byDate[r.date].clicks += r.clicks;
      byDate[r.date].cost += r.cost; byDate[r.date].conversions += r.conversions;
    });
    ts = adsFillClient(byDate); totals = adsSumTs(ts); prev = null;
  } else {
    const scope = f.type === 'keyword'
      ? { type: 'keyword', criterionId: f.criterionId, adGroupId: f.adGroupId }
      : { type: 'searchTerm', text: f.text };
    try {
      const tab = await getActiveTab();
      const res = await browser.runtime.sendMessage({ action: 'adsGetChartData', pageUrl: tab.url, range: adsSelectedRange, scope });
      if (res && res.timeseries) { ts = res.timeseries; totals = res.totals; prev = null; }
    } catch { /* fall through to the default below */ }
    if (!ts) { ts = _adsData.timeseries || []; totals = _adsData.totals; prev = _adsData.previousTotals; }
  }

  _adsFilled = ts || [];
  renderAdsScorecards(totals, prev);
  renderAdsChart();
}

// Re-render the lists + filter bar for the current filter (no chart re-query).
function renderAdsAll() {
  if (!_adsData) return;
  const section = document.getElementById('ads-filter-section');
  if (_adsFilter) {
    section.classList.remove('hidden');
    document.getElementById('ads-filter-type').textContent =
      _adsFilter.type === 'adGroup' ? 'ad group' : _adsFilter.type === 'keyword' ? 'keyword' : 'search term';
    document.getElementById('ads-filter-text').textContent = adsFilterLabel();
  } else {
    section.classList.add('hidden');
  }

  renderAdsTree();
  const kt = document.getElementById('ads-keywords-table'); kt._currency = _adsData.currency;
  buildAdsMetricTable(kt, _adsData.keywords || [], { withQs: true });

  const tt = document.getElementById('ads-terms-table'); tt._currency = _adsData.currency;
  const terms = _adsData.searchTerms || [];
  // Intent chips count over the cross-filter-visible terms (all intents), then narrow
  const xfTerms = terms.filter(adsTermVisible);
  renderIntentChips(document.getElementById('ads-terms-intent'), xfTerms, t => t.text, _adsTermIntent, (intent) => {
    _adsTermIntent = intent;
    renderAdsAll();
  });
  buildAdsMetricTable(tt, terms, { intentFilter: _adsTermIntent });
  // Classify search terms by intent (shared Haiku cache); re-render once when ready
  ensureIntents(terms.map(t => t.text), () => renderAdsAll());
}

// Metric scorecards toggle their series in/out of the chart
document.querySelectorAll('#ads-metric-toggles .ads-metric-toggle').forEach(card => {
  card.addEventListener('click', () => {
    const m = card.dataset.metric;
    const on = !adsActiveMetrics[m];
    // Keep at least one metric on
    if (!on && ADS_METRIC_ORDER.filter(k => adsActiveMetrics[k]).length === 1) return;
    adsActiveMetrics[m] = on;
    card.setAttribute('aria-pressed', String(on));
    browser.storage.local.set({ adsActiveMetrics });
    renderAdsChart();
  });
});

document.getElementById('btn-ads-clear-filter').addEventListener('click', () => {
  _adsFilter = null;
  renderAdsAll();
  refreshAdsChart();
});

// Keep the chart sized to its container (popup width / settings collapse)
if (window.ResizeObserver) {
  let raf = null;
  new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; renderAdsChart(); });
  }).observe(document.getElementById('ads-chart-combined'));
}

// ─── Panel + states ──────────────────────────────────────────────────────────

function setAdsRangeUI(range) {
  document.querySelectorAll('#ads-range-group .mode-option').forEach(btn =>
    btn.classList.toggle('is-active', parseInt(btn.dataset.range, 10) === range));
}

function renderAdsPanel(response) {
  const ids = ['ads-not-connected', 'ads-no-token', 'ads-no-account', 'ads-error', 'ads-data'];
  ids.forEach(id => document.getElementById(id).classList.add('hidden'));

  if (!response || !response.connected) {
    document.getElementById('ads-not-connected-text').textContent = response?.reauthRequired
      ? 'Your Google Ads connection expired — reconnect it in Settings.'
      : 'Connect Google Ads in Settings to see the paid campaigns, keywords, and search terms pointing to this page.';
    document.getElementById('ads-not-connected').classList.remove('hidden');
    return;
  }
  if (response.error === 'NO_DEV_TOKEN') {
    document.getElementById('ads-no-token').classList.remove('hidden');
    return;
  }
  if (response.error === 'NO_ACCOUNT') {
    if (response.host) _adsHost = response.host;
    loadAdsAccountPicker(document.getElementById('ads-account-picker'), document.getElementById('ads-account-picker-empty'), document.getElementById('ads-tab-account-search'), () => loadAdsData(false));
    document.getElementById('ads-no-account').classList.remove('hidden');
    return;
  }
  if (response.error) {
    document.getElementById('ads-error-text').textContent = adsErrorMessage(response.error, response.detail);
    document.getElementById('ads-error').classList.remove('hidden');
    return;
  }

  setAdsRangeUI(adsSelectedRange);
  const hasAds = (response.ads || []).length > 0;
  document.getElementById('ads-none').classList.toggle('hidden', hasAds);
  ['ads-chart-section', 'ads-campaigns-section', 'ads-keywords-section', 'ads-terms-section'].forEach(id =>
    document.getElementById(id).classList.toggle('hidden', !hasAds));
  document.getElementById('ads-filter-section').classList.add('hidden');

  if (hasAds) {
    _adsData = response;
    _adsFilter = null;
    _adsTermIntent = null;
    _adsFilled = response.timeseries || [];
    renderAdsScorecards(response.totals, response.previousTotals);
    renderAdsChart();
    renderAdsAll();
    // Web CEO "Tracked" pills appear once the tracked-keyword set has loaded
    if (typeof ensureWebceoTracked === 'function') ensureWebceoTracked(() => renderAdsAll());
  } else {
    _adsData = null;
    _adsFilter = null;
  }
  document.getElementById('ads-fetched-meta').textContent =
    `Account ${response.account} · ${response.path} · Updated ${gscRelativeTime(response.fetchedAt)}`;
  document.getElementById('ads-data').classList.remove('hidden');
}

async function loadAdsData(forceRefresh = false) {
  const tab = await getActiveTab();
  try { _adsHost = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { _adsHost = null; }
  const response = await browser.runtime.sendMessage({ action: 'adsGetPageData', pageUrl: tab.url, range: adsSelectedRange, forceRefresh });
  renderAdsPanel(response);
}

// ─── Account picker (per-domain, mirrors the GA property picker) ─────────────────

function renderAdsAccountOptions(container, accounts, selected, onSelect) {
  container.replaceChildren();

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ga-property-search';
  search.placeholder = 'Search accounts…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  container.appendChild(search);

  accounts
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
    .forEach(acc => {
      const opt = document.createElement('button');
      opt.className = 'gsc-property-option' + (acc.id === selected ? ' gsc-property-option--active' : '');
      opt.dataset.search = `${acc.name} ${acc.id}`.toLowerCase();
      const radio = document.createElement('span');
      radio.className = 'gsc-property-radio';
      const text = document.createElement('span');
      text.className = 'gsc-property-option-text';
      text.textContent = acc.name;
      opt.append(radio, text);
      const idEl = document.createElement('span');
      idEl.className = 'gsc-property-id';
      idEl.textContent = formatAdsId(acc.id);
      opt.appendChild(idEl);
      opt.addEventListener('click', async () => {
        container.querySelectorAll('.gsc-property-option').forEach(el =>
          el.classList.toggle('gsc-property-option--active', el === opt));
        await browser.runtime.sendMessage({ action: 'adsSetAccount', host: _adsHost, account: acc.id });
        if (onSelect) onSelect();
      });
      container.appendChild(opt);
    });

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    container.querySelectorAll('.gsc-property-option').forEach(el =>
      el.classList.toggle('hidden', q && !el.dataset.search.includes(q)));
  });
}

// Shared loader used by both the tab's no-account state and the Settings box
async function loadAdsAccountPicker(container, emptyEl, _unusedSearch, onSelect) {
  container.replaceChildren();
  if (emptyEl) emptyEl.classList.add('hidden');
  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'adsResolveAccount', pageUrl: tab.url });
  if (!res || !res.connected) return;
  if (res.error) {
    if (emptyEl) { emptyEl.textContent = adsErrorMessage(res.error, res.detail); emptyEl.classList.remove('hidden'); }
    return;
  }
  _adsHost = res.host;
  if (!res.accounts.length) {
    if (emptyEl) { emptyEl.textContent = 'No Google Ads accounts available on the connected login.'; emptyEl.classList.remove('hidden'); }
    return;
  }
  renderAdsAccountOptions(container, res.accounts, res.account, onSelect);
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function refreshAdsSettingsStatus() {
  const status = await browser.runtime.sendMessage({ action: 'adsGetStatus' });
  const badge   = document.getElementById('ads-status-badge');
  const setup   = document.getElementById('ads-setup-form');
  const info    = document.getElementById('ads-connected-info');

  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setup.classList.add('hidden');
    info.classList.remove('hidden');
    browser.storage.local.get(['adsDeveloperToken', 'adsManagerId']).then(({ adsDeveloperToken, adsManagerId }) => {
      setAdsTokenState(!!adsDeveloperToken);
      document.getElementById('ads-manager-id').value = adsManagerId || '';
      // Once the developer token is stored, collapse the inputs out of the way
      // (the Manager/MCC ID is optional — non-manager accounts don't need it)
      setAdsConfigCollapsed(!!adsDeveloperToken);
    });
    refreshAdsAccountInfo();
  } else {
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setup.classList.remove('hidden');
    info.classList.add('hidden');
  }
  return status;
}

async function refreshAdsAccountInfo() {
  const matchEl = document.getElementById('ads-account-match');
  const allEl   = document.getElementById('ads-account-all');
  matchEl.className = 'gsc-property-match hidden';
  allEl.replaceChildren();

  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'adsResolveAccount', pageUrl: tab.url });
  if (!res || !res.connected) return;
  if (res.error) {
    matchEl.textContent = res.error === 'NO_DEV_TOKEN' ? 'Add a developer token above to list accounts' : adsErrorMessage(res.error, res.detail);
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  _adsHost = res.host;
  if (!res.accounts.length) {
    matchEl.textContent = 'No accounts on the connected login';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  // Collapse to the linked account (green) once chosen, like the GSC/GA boxes
  const sel = res.account && res.accounts.find(a => a.id === res.account);
  if (sel) {
    renderSelectedRow(allEl, sel.name,
      async () => {
        await browser.runtime.sendMessage({ action: 'adsSetAccount', host: _adsHost, account: null });
        renderAdsAccountOptions(allEl, res.accounts, null, null);
      }, formatAdsId(sel.id));
    return;
  }
  renderAdsAccountOptions(allEl, res.accounts, res.account, null);
}

document.getElementById('btn-ads-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-ads-connect');
  const errorEl = document.getElementById('ads-connect-error');
  errorEl.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    const result = await browser.runtime.sendMessage({ action: 'adsConnect' });
    if (result.error) {
      if (result.error !== 'FLOW_CANCELLED') {
        errorEl.textContent = gscConnectErrorMessage(result.error);
        errorEl.classList.remove('hidden');
      }
    } else {
      await refreshAdsSettingsStatus();
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Connect Google Ads';
  }
});

// The "Connected" chip doubles as the disconnect control (hover → red Disconnect)
document.getElementById('ads-status-badge').addEventListener('click', async (e) => {
  if (!e.currentTarget.classList.contains('gsc-status-badge--connected')) return;
  await browser.runtime.sendMessage({ action: 'adsDisconnect' });
  setAdsTokenState(false);   // return the token field to its editable state
  await refreshAdsSettingsStatus();
});

// Collapse the developer-token + Manager-ID inputs once both are saved, leaving
// just a "saved · Edit" summary above the account picker.
function setAdsConfigCollapsed(collapsed) {
  document.getElementById('ads-config-fields').classList.toggle('hidden', collapsed);
  document.getElementById('ads-config-collapsed').classList.toggle('hidden', !collapsed);
}

document.getElementById('btn-ads-edit-config').addEventListener('click', () => setAdsConfigCollapsed(false));

// Developer token field: masked "saved" + trash once stored, editable + reveal
// eye when empty — mirrors the Claude API key (popup-settings.js setKeyState).
function setAdsTokenState(hasToken) {
  const input = document.getElementById('ads-dev-token');
  document.getElementById('btn-ads-token-vis').classList.toggle('hidden', hasToken);
  document.getElementById('btn-ads-token-clear').classList.toggle('hidden', !hasToken);
  input.type = 'password';
  input.value = '';
  input.readOnly = hasToken;
  input.placeholder = hasToken ? '••••••••••••' : 'Google Ads developer token';
  document.getElementById('ads-eye-open').classList.remove('hidden');
  document.getElementById('ads-eye-closed').classList.add('hidden');
}

document.getElementById('btn-ads-token-vis').addEventListener('click', () => {
  const input = document.getElementById('ads-dev-token');
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  document.getElementById('ads-eye-open').classList.toggle('hidden', isHidden);
  document.getElementById('ads-eye-closed').classList.toggle('hidden', !isHidden);
});

document.getElementById('btn-ads-token-clear').addEventListener('click', async () => {
  await browser.storage.local.remove(['adsDeveloperToken', 'adsAccounts']);
  setAdsTokenState(false);
  refreshAdsAccountInfo();
});

document.getElementById('btn-ads-save-config').addEventListener('click', async () => {
  const tokenInput = document.getElementById('ads-dev-token');
  const adsManagerId = document.getElementById('ads-manager-id').value.trim();
  const update = { adsManagerId };
  // Only overwrite the token when the user actually typed a new one
  const typed = !tokenInput.readOnly ? tokenInput.value.trim() : '';
  if (!tokenInput.readOnly) update.adsDeveloperToken = typed;
  // Manager / account list depend on these, so drop the cached accounts
  await browser.storage.local.set(update);
  await browser.storage.local.remove('adsAccounts');
  if (!tokenInput.readOnly && typed) setAdsTokenState(true);
  // Collapse once the developer token is stored (Manager/MCC ID is optional)
  const { adsDeveloperToken } = await browser.storage.local.get('adsDeveloperToken');
  if (adsDeveloperToken) setAdsConfigCollapsed(true);
  refreshAdsAccountInfo();
});

document.getElementById('btn-ads-goto-settings').addEventListener('click', () => showSettings());
document.getElementById('btn-ads-goto-settings-2').addEventListener('click', () => showSettings());
document.getElementById('ads-token-link').addEventListener('click', () => browser.tabs.create({ url: ADS_TOKEN_HELP }));
document.getElementById('ads-token-link-2').addEventListener('click', () => browser.tabs.create({ url: ADS_TOKEN_HELP }));

document.querySelectorAll('#ads-range-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = parseInt(btn.dataset.range, 10);
    if (range === adsSelectedRange) return;
    adsSelectedRange = range;
    setAdsRangeUI(range);
    browser.storage.local.set({ adsSelectedRange: range });
    loadAdsData(false);
  });
});

function loadAdsPrefs() {
  return browser.storage.local.get(['adsSelectedRange', 'adsActiveMetrics']).then(({ adsSelectedRange: stored, adsActiveMetrics: metrics }) => {
    adsSelectedRange = stored || 30;
    setAdsRangeUI(adsSelectedRange);
    if (metrics && typeof metrics === 'object') {
      ADS_METRIC_ORDER.forEach(m => { adsActiveMetrics[m] = metrics[m] !== false; });
      if (!ADS_METRIC_ORDER.some(m => adsActiveMetrics[m])) adsActiveMetrics.impressions = true;
    }
    document.querySelectorAll('#ads-metric-toggles .ads-metric-toggle').forEach(card => {
      card.setAttribute('aria-pressed', String(adsActiveMetrics[card.dataset.metric] !== false));
    });
  });
}

// ─── Ad copy generator: Responsive display assets via Claude Sonnet ──────────
// Generates Headlines (≤30), Long Headlines (≤90), and Descriptions (≤90) for
// an ad pointing to the current page. Grounded in the page's intent + sentiment
// (aiInsightsCache), the actual Google Ads search terms that triggered ads for
// it, its Web CEO tracked keywords, and the organic GSC queries whose classified
// intent matches the page. Sonnet (not Haiku) for ad copy.

const ADS_GEN_ASSETS = [
  { key: 'headlines',     label: 'Headlines',      max: 30 },
  { key: 'longHeadlines', label: 'Long Headlines', max: 90 },
  { key: 'descriptions',  label: 'Descriptions',   max: 90 },
];

function buildAdCopySystem(insights, brandTerms) {
  const lines = [
    'You are an expert Google Ads copywriter. Write responsive display ad assets for an ad that drives traffic to the landing page described below.',
    '',
    'Return ONLY a compact JSON object — no prose, no code fences — of exactly this shape:',
    '{"headlines":[5 strings],"longHeadlines":[5 strings],"descriptions":[5 strings]}',
    '',
    'Hard character limits (count every character including spaces; NEVER exceed):',
    '- headlines: 5 items, each at most 30 characters',
    '- longHeadlines: 5 items, each at most 90 characters',
    '- descriptions: 5 items, each at most 90 characters',
    '',
    'Follow Google Ads editorial policy:',
    '- Title or sentence case — never ALL CAPS (standard acronyms/trademarks excepted).',
    '- No exclamation marks in headlines; at most one in any description.',
    '- No repeated or gimmicky punctuation, no emoji, no phone numbers.',
    '- No misleading claims or unverifiable superlatives ("#1", "best", "guaranteed").',
    '',
    'Make every asset specific to this page\'s actual offering — do not invent facts.',
    '- Prioritize the real paid search terms, then the tracked keywords and matching organic queries; weave the most relevant ones in naturally without keyword-stuffing.',
    '- Vary the angle across the five options (benefit, feature, proof, call-to-action, audience).',
  ];
  if (insights?.intent && typeof OG_INTENT_GUIDANCE !== 'undefined' && OG_INTENT_GUIDANCE[insights.intent]) {
    lines.push(`- Search intent is ${insights.intent}: ${OG_INTENT_GUIDANCE[insights.intent]}`);
  }
  if (insights?.sentiment && typeof OG_SENTIMENT_GUIDANCE !== 'undefined' && OG_SENTIMENT_GUIDANCE[insights.sentiment]) {
    lines.push(`- Page sentiment is ${insights.sentiment}: ${OG_SENTIMENT_GUIDANCE[insights.sentiment]}`);
  }
  if (brandTerms.length) {
    lines.push(`- You may use the brand name (${brandTerms.join(', ')}) where it strengthens the ad.`);
  }
  return lines.join('\n');
}

function adsGenCopyBtn(text) {
  const btn = document.createElement('button');
  btn.className = 'gen-result-btn';
  btn.title = 'Copy';
  btn.appendChild(svgFromString(
    '<svg class="icon-copy" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="5" y="4" width="9" height="11" rx="1.5"/>' +
    '<path d="M3 12H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1"/></svg>'));
  btn.appendChild(svgFromString(
    '<svg class="icon-check hidden" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="2 8 6 12 14 4"/></svg>'));
  btn.addEventListener('click', async () => { await copyToClipboard(text); flashCopyBtn(btn); });
  return btn;
}

function renderAdCopy(resultEl, parsed, insights) {
  resultEl.replaceChildren();

  const label = document.createElement('div');
  label.className = 'gen-result-label';
  label.appendChild(document.createTextNode('AD COPY FOR THIS PAGE '));
  const chips = typeof buildInsightChips === 'function' ? buildInsightChips(insights) : null;
  if (chips) label.appendChild(chips);
  resultEl.appendChild(label);

  let rendered = 0;
  ADS_GEN_ASSETS.forEach(asset => {
    const items = Array.isArray(parsed[asset.key]) ? parsed[asset.key] : [];
    const texts = items.map(t => String(t || '').trim()).filter(Boolean);
    if (!texts.length) return;
    rendered += texts.length;

    const group = document.createElement('div');
    group.className = 'ads-gen-group';

    const head = document.createElement('div');
    head.className = 'ads-gen-group-head';
    head.appendChild(document.createTextNode(asset.label + ' '));
    const lim = document.createElement('span');
    lim.textContent = `· max ${asset.max}`;
    head.appendChild(lim);
    group.appendChild(head);

    texts.forEach(text => {
      const item = document.createElement('div');
      item.className = 'ads-gen-item';

      const txt = document.createElement('span');
      txt.className = 'ads-gen-text';
      txt.textContent = text;

      const count = document.createElement('span');
      count.className = 'ads-gen-count ' + (text.length <= asset.max ? 'is-count-green' : 'is-count-red');
      count.textContent = `${text.length}/${asset.max}`;

      item.appendChild(txt);
      item.appendChild(count);
      item.appendChild(adsGenCopyBtn(text));
      group.appendChild(item);
    });

    resultEl.appendChild(group);
  });

  if (!rendered) throw new Error('No usable ad copy in the response');
}

async function generateAdCopy() {
  const btn = document.getElementById('btn-gen-adcopy');
  const resultEl = document.getElementById('ads-gen-result');
  if (!btn || !resultEl || btn.disabled) return;

  if (!pageData) {
    resultEl.classList.remove('hidden');
    resultEl.classList.add('is-error');
    resultEl.replaceChildren();
    const e = document.createElement('div');
    e.className = 'gen-result-text';
    e.textContent = 'Open this on a regular web page to generate ad copy.';
    resultEl.appendChild(e);
    return;
  }

  btn.disabled = true;
  btn.querySelector('.icon-generate').classList.add('hidden');
  btn.querySelector('.icon-spinner').classList.remove('hidden');
  resultEl.classList.remove('hidden', 'is-error');
  resultEl.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'gen-result-text';
  loading.textContent = 'Generating ad copy…';
  resultEl.appendChild(loading);

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const tab = await getActiveTab();
    const pageUrl = pageData.canonical || tab.url;

    let host = '';
    try { host = new URL(pageUrl, tab.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const brandTerms = (allBrandedTerms[host] || '').split('|').map(s => s.trim()).filter(Boolean);

    // Page intent + sentiment from the per-URL insights cache
    const cacheKey = (tab.url || '').split('#')[0];
    const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
    const insights = (aiInsightsCache || {})[cacheKey] || null;
    const pageIntent = insights?.intent || null;

    // Tracked keywords for this domain's Web CEO project
    let trackedKeywords = [];
    try {
      const res = await browser.runtime.sendMessage({ action: 'webceoGetTrackedKeywords', pageUrl: tab.url });
      trackedKeywords = (res && res.keywords || []).map(k => String(k).trim()).filter(Boolean).slice(0, 15);
    } catch { /* best-effort */ }

    // Actual Google Ads search terms that triggered ads for this page (top, deduped)
    let adsSearchTerms = [];
    if (typeof _adsData !== 'undefined' && _adsData && Array.isArray(_adsData.searchTerms)) {
      const seen = new Set();
      for (const t of _adsData.searchTerms) {
        const s = String(t && t.text || '').trim();
        const lc = s.toLowerCase();
        if (!s || seen.has(lc)) continue;
        seen.add(lc);
        adsSearchTerms.push(s);
        if (adsSearchTerms.length >= 10) break;
      }
    }

    // Organic GSC queries whose classified intent matches the page's intent
    const organic = (typeof _gscQueries !== 'undefined' && Array.isArray(_gscQueries)) ? _gscQueries : [];
    let organicMatched = [];
    if (organic.length) {
      const matched = (pageIntent && typeof intentOf === 'function')
        ? organic.filter(q => intentOf(q.query) === pageIntent)
        : [];
      organicMatched = (matched.length ? matched : organic).slice(0, 10).map(q => q.query).filter(Boolean);
    }

    const context = [
      `Landing page URL: ${pageUrl}`,
      `Page title: "${pageData.title?.text}"`,
      pageData.metaDescription?.text && `Meta description: "${pageData.metaDescription.text}"`,
      pageIntent          && `Page search intent: ${pageIntent}`,
      insights?.sentiment && `Page sentiment: ${insights.sentiment}`,
      trackedKeywords.length  && `Tracked keywords (prioritize these): ${trackedKeywords.join(', ')}`,
      adsSearchTerms.length   && `Actual paid search terms that triggered ads for this page (real user demand): ${adsSearchTerms.join(', ')}`,
      organicMatched.length   && `Organic queries matching this page's intent: ${organicMatched.join(', ')}`,
      pageData.headings?.length && `Headings:\n${pageData.headings.map(h => `${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`,
      pageData.bodyTextExcerpt  && `Page content excerpt: "${pageData.bodyTextExcerpt}"`
    ].filter(Boolean).join('\n\n');

    const system = buildAdCopySystem(insights, brandTerms);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system,
        messages: [{ role: 'user', content: context }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text ?? '').replace(/^```(?:json)?|```$/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Could not parse the ad copy response'); }

    renderAdCopy(resultEl, parsed, insights);
  } catch (err) {
    resultEl.replaceChildren();
    resultEl.classList.add('is-error');
    const errEl = document.createElement('div');
    errEl.className = 'gen-result-text';
    errEl.textContent = err.message;
    resultEl.appendChild(errEl);
  } finally {
    btn.disabled = false;
    btn.querySelector('.icon-generate').classList.remove('hidden');
    btn.querySelector('.icon-spinner').classList.add('hidden');
  }
}

document.getElementById('btn-gen-adcopy').addEventListener('click', generateAdCopy);
