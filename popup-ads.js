// Google Ads (GAQL) tab: the paid campaigns / ad groups / ads pointing at the
// evaluated page, plus the keywords and search terms driving it. Mirrors the
// Analytics tab's look-back + per-domain account picker, and reuses the Search
// tab's on-page location flags (gscQueryLocations).

let adsSelectedRange = 30;
let _adsHost = null;
let _adsData = null;                                   // last adsGetPageData response
let _adsFilter = null;                                 // { type:'adGroup'|'keyword'|'searchTerm', ... } | null
let _adsTermIntent = null;                             // Search Terms intent filter (null = All)
let _adsTermSearch = '';                               // regex filter for the search-terms table
let _adsTermSearchExclude = false;                     // false = match (include), true = exclude
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
function adsTermChips(text, organicSet, opts = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'gsc-query-chips';

  // Static Tracked pill — keywords only. Search terms handle their Track chip
  // inline in the row (before the spacer) so it appears next to the term text.
  // When opts.track is set it means search-term context: skip the static pill.
  if (!opts.track && typeof webceoIsTracked === 'function' && webceoIsTracked(text)) {
    const pill = document.createElement('span');
    pill.className = 'gsc-branded-pill ads-tracked-pill';
    pill.textContent = 'Tracked';
    pill.title = 'Tracked in your Web CEO project';
    wrap.appendChild(pill);
  }

  if (organicSet.has((text || '').toLowerCase().trim())) {
    const pill = document.createElement('span');
    pill.className = 'gsc-branded-pill ads-organic-pill';
    pill.textContent = 'Organic';
    pill.title = 'This page also ranks for this term organically (Search Console)';
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
// Regex filter for the Search Terms table (invalid regex → no filtering)
function adsTermSearchMatch(text) {
  if (!_adsTermSearch) return true;
  let re;
  try { re = new RegExp(_adsTermSearch, 'i'); } catch { return true; }
  const m = re.test(text || '');
  return _adsTermSearchExclude ? !m : m;
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
  ['Campaigns', 'Impr', 'Clicks', 'Cost', 'Conv'].forEach((c, i) => {
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

  // Campaigns sorted by total cost (desc); ad groups within each by cost (desc)
  const campaigns = Array.from(byCampaign.entries()).map(([campId, camp]) => {
    const groups = Array.from(camp.groups.values()).sort((a, b) => b.cost - a.cost);
    const total = groups.reduce((s, g) => s + g.cost, 0);
    return { campId, camp, groups, total };
  }).sort((a, b) => b.total - a.total);

  campaigns.forEach(({ campId, camp, groups }) => {
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

    groups.forEach(g => {
      const row = document.createElement('div');
      row.className = 'ads-row ads-row--ag ads-row--click' +
        (_adsFilter && _adsFilter.type === 'adGroup' && _adsFilter.adGroupId === g.id ? ' ads-row--active' : '');
      const name = document.createElement('span');
      name.className = 'ads-cell-term';
      const nameLink = document.createElement('span');
      nameLink.className = 'ads-term-text ads-term-link';
      nameLink.textContent = g.name;
      nameLink.title = `View ads in “${g.name}”`;
      nameLink.addEventListener('click', (e) => {
        e.stopPropagation();   // drill in instead of cross-filtering the row
        drillIntoAdGroup(g.id);
      });
      name.appendChild(nameLink);
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
  if (container._kwShowAll === undefined) container._kwShowAll = false;
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
      (!intentFilter || intentOf(r.text) === intentFilter) &&
      (withQs || adsTermSearchMatch(r.text)));
    const sorted = visible.sort((a, b) => {
      if (sort.column === 'text') {
        const av = (a.text || '').toLowerCase(), bv = (b.text || '').toLowerCase();
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const av = a[sort.column] == null ? -Infinity : a[sort.column];
      const bv = b[sort.column] == null ? -Infinity : b[sort.column];
      return sort.dir === 'asc' ? av - bv : bv - av;
    });

    // Keywords table: hide zero-impression rows behind a reveal button unless
    // a cross-filter is active (the filtered keyword must always be visible).
    let toRender = sorted;
    let hiddenKwCount = 0;
    if (withQs && !_adsFilter && !container._kwShowAll) {
      const withImpr = sorted.filter(r => r.impressions > 0);
      const noImpr   = sorted.filter(r => !r.impressions);
      if (noImpr.length > 0) { toRender = withImpr; hiddenKwCount = noImpr.length; }
    }

    toRender.forEach(r => {
      const row = document.createElement('div');
      const isActive = _adsFilter && (withQs
        ? (_adsFilter.type === 'keyword' && _adsFilter.criterionId === r.criterionId)
        : (_adsFilter.type === 'searchTerm' && _adsFilter.text === r.text && _adsFilter.adGroupId === r.adGroupId));
      row.className = 'ads-row ads-row--click' + (withQs ? ' ads-row--kw' : '') + (isActive ? ' ads-row--active' : '');

      // term + chips on one line; the term text itself opens a Google search
      const term = document.createElement('span');
      term.className = 'ads-cell-term';

      // Circle+ brand button at the far left of search term rows (mirrors GSC queries).
      // For already-branded terms, an empty span keeps the grid aligned.
      if (!withQs) {
        const isBranded = typeof isQueryBranded === 'function'
          && isQueryBranded(r.text, _adsHost ? (allBrandedTerms[_adsHost] || '') : '');
        if (isBranded) {
          term.appendChild(document.createElement('span'));
        } else {
          const addBtn = document.createElement('button');
          addBtn.className = 'gsc-query-add';
          addBtn.title = 'Mark as brand';
          addBtn.setAttribute('aria-label', 'Mark as brand');
          // Use svgEl (createElementNS) not svgFromString — DOMParser inside
          // a render() closure can return a <parseerror> element that renders
          // as visible XML text rather than the intended icon.
          const circlePlus = svgEl('svg', { viewBox: '0 0 16 16', width: '13', height: '13', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' });
          circlePlus.appendChild(svgEl('circle', { cx: '8', cy: '8', r: '6.4' }));
          circlePlus.appendChild(svgEl('line', { x1: '8', y1: '5.2', x2: '8', y2: '10.8' }));
          circlePlus.appendChild(svgEl('line', { x1: '5.2', y1: '8', x2: '10.8', y2: '8' }));
          addBtn.appendChild(circlePlus);
          addBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (!_adsHost || !r.text) return;
            const termText = r.text.trim();
            const existing = allBrandedTerms[_adsHost] || '';
            if (typeof isQueryBranded === 'function' && isQueryBranded(termText, existing)) return;
            const escaped = termText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            allBrandedTerms[_adsHost] = existing ? `${existing}|${escaped}` : escaped;
            browser.storage.local.set({ brandedTerms: { ...allBrandedTerms } });
            renderAdsAll();
          });
          term.appendChild(addBtn);
        }
      }

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

      // Search terms: Track chip inline (immediately after label), then a flex
      // spacer, then Organic + location chips pushed to the far right of the cell.
      if (!withQs) {
        const tracked = typeof webceoIsTracked === 'function' && webceoIsTracked(r.text);
        const trackChip = document.createElement('button');
        if (tracked) {
          trackChip.className = 'gsc-track-chip gsc-track-chip--done';
          trackChip.textContent = 'Tracked';
          trackChip.disabled = true;
          trackChip.title = 'Tracked in your Web CEO project';
        } else {
          trackChip.className = 'gsc-track-chip';
          trackChip.textContent = '+ Track';
          trackChip.title = 'Track this keyword in your Web CEO project';
          trackChip.addEventListener('click', e => {
            e.stopPropagation();
            const intent = typeof intentOf === 'function' ? intentOf(r.text) : null;
            if (typeof trackQueryInWebceo === 'function') trackQueryInWebceo(r.text, trackChip, intent);
          });
        }
        term.appendChild(trackChip);
        const spacer = document.createElement('span');
        spacer.className = 'ads-term-spacer';
        term.appendChild(spacer);
      }

      // Right-side chips: Organic + location (opts.track=true tells adsTermChips
      // to skip the static Tracked pill since search terms handle it inline above)
      const chips = adsTermChips(r.text, organic, withQs ? {} : { track: true });
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

    // Keywords: reveal button for zero-impression rows
    if (hiddenKwCount > 0) {
      const more = document.createElement('button');
      more.className = 'gsc-more-queries-btn';
      more.textContent = `Show ${hiddenKwCount} more (no impressions)`;
      more.addEventListener('click', () => { container._kwShowAll = true; render(); });
      container.appendChild(more);
    }

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
  // Intent chips count over the cross-filter + regex-visible terms (all intents), then narrow
  const xfTerms = terms.filter(t => adsTermVisible(t) && adsTermSearchMatch(t.text));
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

// Search Terms regex filter (mirrors the Search tab's query search)
document.getElementById('ads-terms-search').addEventListener('input', e => {
  _adsTermSearch = e.target.value;
  e.target.classList.toggle('is-invalid', !!_adsTermSearch && typeof isValidRegex === 'function' && !isValidRegex(_adsTermSearch));
  if (_adsData) renderAdsAll();
});
document.getElementById('btn-ads-terms-search-mode').addEventListener('click', () => {
  _adsTermSearchExclude = !_adsTermSearchExclude;
  document.getElementById('btn-ads-terms-search-mode').textContent = _adsTermSearchExclude ? 'Excl.' : 'Match';
  if (_adsData) renderAdsAll();
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
  { key: 'headlines',     label: 'Headlines',      max: 30, one: 'headline' },
  { key: 'longHeadlines', label: 'Long Headlines', max: 90, one: 'long headline' },
  { key: 'descriptions',  label: 'Descriptions',   max: 90, one: 'description' },
];

const AD_COPY_SYSTEM_BASE = [
  'You are an expert Google Ads copywriter. Write responsive display ad assets for an ad that drives traffic to the landing page described below.',
  '',
  'Return ONLY a compact JSON object — no prose, no code fences — of exactly this shape:',
  '{"headlines":[15 strings],"longHeadlines":[5 strings],"descriptions":[5 strings]}',
  '',
  'Hard character limits. Count every character including spaces and NEVER exceed:',
  '- headlines: exactly 15, each at most 30 characters',
  '- longHeadlines: exactly 5, each at most 90 characters',
  '- descriptions: exactly 5, each 70 to 90 characters and NEVER more than 90. Count each one; if it would exceed 90, rewrite it shorter before responding.',
  '',
  'Style and policy:',
  '- Never use em dashes or en dashes. Use commas or periods instead.',
  '- Never use exclamation marks anywhere.',
  '- Use title or sentence case, never ALL CAPS (standard acronyms or trademarks excepted).',
  '- No repeated or gimmicky punctuation, no emoji, no phone numbers.',
  '- No misleading claims or unverifiable superlatives like "#1", "best", or "guaranteed".',
  '',
  'Make every asset specific to this page\'s actual offering. Do not invent facts.',
  '- Prioritize the real paid search terms, then the tracked keywords and matching organic queries; weave the most relevant ones in naturally without keyword-stuffing.',
  '- Vary the angle across the options (benefit, feature, proof, call to action, audience, urgency, question); avoid near-duplicate headlines.',
].join('\n');

// Returns only the page-specific suffix (intent + sentiment + brand terms).
// The cacheable base lives in AD_COPY_SYSTEM_BASE above.
function buildAdCopySystem(insights, brandTerms) {
  const lines = [];
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

// Strip em/en dashes and exclamation marks (per the user's house style) and tidy
// the resulting spacing/punctuation.
function sanitizeAdText(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/\s*[—–]\s*/g, ', ');   // em / en dash → comma
  t = t.replace(/\s*!+\s*/g, '. ');     // exclamation → period
  t = t.replace(/\s*,\s*,\s*/g, ', ');  // collapse doubled commas
  t = t.replace(/\.\s*\.+/g, '. ');     // collapse doubled periods
  t = t.replace(/\s+([,.;:])/g, '$1');  // no space before punctuation
  t = t.replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/[,;:]+$/, '').trim();  // no trailing comma/semicolon
  return t;
}

// System prompt for replacing a SINGLE asset line (not the whole set).
function buildAdLineSystem(asset, insights, brandTerms, existing) {
  const lines = [
    `You are an expert Google Ads copywriter. Write ONE replacement ${asset.one} for an ad pointing to the landing page described below.`,
    `- At most ${asset.max} characters. Count carefully and never exceed.`,
  ];
  if (asset.key === 'descriptions') lines.push('- Aim for 70 to 90 characters.');
  lines.push('- Never use em dashes, en dashes, or exclamation marks.');
  lines.push('- Title or sentence case, no ALL CAPS, no emoji, no phone numbers, no unverifiable superlatives.');
  lines.push('- Be specific to the page; do not invent facts. Prioritize the real paid search terms, tracked keywords, and matching organic queries, woven in naturally.');
  if (existing && existing.length) {
    lines.push(`- It must be clearly different from these existing options: ${existing.map(e => `"${e}"`).join('; ')}.`);
  }
  if (insights?.intent && typeof OG_INTENT_GUIDANCE !== 'undefined' && OG_INTENT_GUIDANCE[insights.intent]) {
    lines.push(`- Search intent is ${insights.intent}: ${OG_INTENT_GUIDANCE[insights.intent]}`);
  }
  if (insights?.sentiment && typeof OG_SENTIMENT_GUIDANCE !== 'undefined' && OG_SENTIMENT_GUIDANCE[insights.sentiment]) {
    lines.push(`- Page sentiment is ${insights.sentiment}: ${OG_SENTIMENT_GUIDANCE[insights.sentiment]}`);
  }
  if (brandTerms && brandTerms.length) {
    lines.push(`- You may use the brand name (${brandTerms.join(', ')}) where it strengthens the ad.`);
  }
  lines.push('- Return ONLY the replacement text. No quotes, no labels, no JSON, no explanation.');
  return lines.join('\n');
}

// Replace just one asset field in place. Reuses the grounding gathered at
// generation time (_adCopyContext); avoids duplicating sibling options.
async function regenerateAdCopyLine(asset, index, input, count, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key');

    const existing = [];
    const group = input.closest('.adcopy-group');
    if (group) group.querySelectorAll('.adcopy-field').forEach(el => {
      if (el !== input && el.value.trim()) existing.push(el.value.trim());
    });

    const system = buildAdLineSystem(asset, _adCopyInsights, _adCopyBrandTerms, existing);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_MID,
        max_tokens: 120,
        system,
        messages: [{ role: 'user', content: _adCopyContext || 'No additional context available.' }]
      })
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message ?? `HTTP ${res.status}`); }

    const data = await res.json();
    let out = sanitizeAdText((data.content?.[0]?.text ?? '').trim().replace(/^["']|["']$/g, ''));
    if (!out) throw new Error('empty');
    if (out.length > asset.max) out = adcopyHardTrim(out, asset.max);

    input.value = out;
    count.className = adcopyCountClass(out.length, asset.max);
    count.textContent = `${out.length}/${asset.max}`;
    if (_adCopy && Array.isArray(_adCopy[asset.key])) _adCopy[asset.key][index] = out;
  } catch {
    btn.title = 'Regenerate failed — try again';
    setTimeout(() => { btn.title = 'Regenerate this line'; }, 2500);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
}

// Last-resort deterministic shortener: trim to a word boundary within max.
function adcopyHardTrim(s, max) {
  s = String(s || '').trim();
  if (s.length <= max) return s;
  let t = s.slice(0, max);
  const sp = t.lastIndexOf(' ');
  if (sp > max * 0.6) t = t.slice(0, sp);
  return t.replace(/[\s,.;:!?–—-]+$/, '').trim();
}

// Guarantee every asset fits its limit. One targeted Claude pass rewrites only
// the overflow items (best quality); a word-boundary trim is the final guard.
async function enforceAdCopyLimits(claudeApiKey, parsed) {
  const over = [];
  ADS_GEN_ASSETS.forEach(a => {
    const arr = Array.isArray(parsed[a.key]) ? parsed[a.key] : [];
    arr.forEach((t, i) => { if (String(t || '').length > a.max) over.push({ key: a.key, i, max: a.max, text: String(t) }); });
  });
  if (!over.length) return parsed;

  try {
    const system = 'Rewrite each ad asset to fit within its character limit while keeping its meaning, intent, and tone. Never use em dashes, en dashes, or exclamation marks. Return ONLY a JSON array of the rewritten strings, in the same order, no prose.';
    const content = over.map((o, n) => `${n}. (max ${o.max} characters) ${o.text}`).join('\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: MODEL_MID, max_tokens: 600, system, messages: [{ role: 'user', content }] })
    });
    if (res.ok) {
      const data = await res.json();
      let raw = (data.content?.[0]?.text ?? '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s !== -1 && e > s) raw = raw.slice(s, e + 1);
      const arr = JSON.parse(raw);
      over.forEach((o, n) => {
        let fixed = sanitizeAdText(arr[n]);
        if (!fixed || fixed.length > o.max) fixed = adcopyHardTrim(fixed || o.text, o.max);
        parsed[o.key][o.i] = fixed;
      });
      return parsed;
    }
  } catch { /* fall through to deterministic trim */ }

  over.forEach(o => { parsed[o.key][o.i] = adcopyHardTrim(o.text, o.max); });
  return parsed;
}

function adsGenCopyBtn(getText) {
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
  btn.addEventListener('click', async () => {
    const t = typeof getText === 'function' ? getText() : getText;
    await copyToClipboard(t);
    flashCopyBtn(btn);
  });
  return btn;
}

function adcopyCountClass(len, max) {
  return 'ads-gen-count ' + (len <= max ? 'is-count-green' : 'is-count-red');
}

// One editable asset field: input (headlines) / textarea (long headlines,
// descriptions) with a live char-count badge, a per-line regenerate button,
// and a copy button — all pinned inside the field at the far right.
function makeAdcopyField(asset, text, index) {
  const max = asset.max;
  const row = document.createElement('div');
  row.className = 'adcopy-field-row';

  const useTextarea = max > 30;
  const input = document.createElement(useTextarea ? 'textarea' : 'input');
  input.className = 'adcopy-field';
  input.spellcheck = false;
  if (useTextarea) input.rows = 2; else input.type = 'text';
  input.value = text;

  const count = document.createElement('span');
  count.className = adcopyCountClass(text.length, max);
  count.textContent = `${text.length}/${max}`;

  input.addEventListener('input', () => {
    const len = input.value.length;
    count.className = adcopyCountClass(len, max);
    count.textContent = `${len}/${max}`;
  });

  // Regenerate just this line (sits between the count and the copy button)
  const regenBtn = document.createElement('button');
  regenBtn.className = 'gen-result-btn adcopy-regen-line';
  regenBtn.title = 'Regenerate this line';
  regenBtn.appendChild(svgFromString(
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 3.9 1.6L13.5 5.6"/>' +
    '<polyline points="13.5 2 13.5 5.6 9.9 5.6"/></svg>'));
  regenBtn.addEventListener('click', () => regenerateAdCopyLine(asset, index, input, count, regenBtn));

  // Count + regenerate + copy live inside the field, pinned to the far right.
  const actions = document.createElement('div');
  actions.className = 'adcopy-field-actions';
  actions.appendChild(count);
  actions.appendChild(regenBtn);
  actions.appendChild(adsGenCopyBtn(() => input.value));

  if (useTextarea) row.classList.add('adcopy-field-row--multiline');
  row.appendChild(input);
  row.appendChild(actions);
  return row;
}

function adcopyBodyMessage(msg, isError) {
  const tunedEl = document.getElementById('adcopy-tuned');
  if (tunedEl) tunedEl.replaceChildren();
  const body = document.getElementById('adcopy-body');
  if (!body) return;
  body.replaceChildren();
  const el = document.createElement('div');
  el.className = 'adcopy-message gen-result-text' + (isError ? ' is-error' : '');
  el.textContent = msg;
  body.appendChild(el);
}

function renderAdCopyFields(parsed, insights) {
  const body = document.getElementById('adcopy-body');
  if (!body) return;
  body.replaceChildren();

  // "Tuned for" chips sit in the panel header, in line with the AD COPY label
  const tunedEl = document.getElementById('adcopy-tuned');
  if (tunedEl) {
    tunedEl.replaceChildren();
    const chips = typeof buildInsightChips === 'function' ? buildInsightChips(insights) : null;
    if (chips) {
      tunedEl.appendChild(document.createTextNode('Tuned for '));
      tunedEl.appendChild(chips);
    }
  }

  let rendered = 0;
  ADS_GEN_ASSETS.forEach(asset => {
    const items = Array.isArray(parsed[asset.key]) ? parsed[asset.key] : [];
    const texts = items.map(t => String(t || '').trim()).filter(Boolean);
    if (!texts.length) return;
    rendered += texts.length;

    const group = document.createElement('section');
    group.className = 'field-section adcopy-group';

    const head = document.createElement('div');
    head.className = 'field-header';
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = asset.label;
    const meta = document.createElement('span');
    meta.className = 'adcopy-group-meta';
    meta.textContent = `max ${asset.max}`;
    head.appendChild(lbl);
    head.appendChild(meta);
    group.appendChild(head);

    texts.forEach((text, i) => group.appendChild(makeAdcopyField(asset, text, i)));
    body.appendChild(group);
  });

  if (!rendered) throw new Error('No usable ad copy in the response');
}

// In-memory cache so re-opening the panel doesn't re-bill; cleared on page
// refresh via resetAdCopy (called from clearGenResults).
let _adCopy = null;          // last parsed { headlines, longHeadlines, descriptions }
let _adCopyInsights = null;  // insights it was tuned for
let _adCopyContext = '';     // grounding string reused for per-line regeneration
let _adCopyBrandTerms = [];
let _adCopyLoading = false;

function resetAdCopy() {
  _adCopy = null;
  _adCopyInsights = null;
  _adCopyContext = '';
  _adCopyBrandTerms = [];
  const tunedEl = document.getElementById('adcopy-tuned');
  if (tunedEl) tunedEl.replaceChildren();
  const body = document.getElementById('adcopy-body');
  if (body) body.replaceChildren();
}

// Opening the panel: show cached copy, the in-flight state, or generate fresh.
function openAdCopyPanel() {
  if (_adCopyLoading) { adcopyBodyMessage('Generating ad copy…'); return; }
  if (_adCopy) { renderAdCopyFields(_adCopy, _adCopyInsights); return; }
  generateAdCopy(false);
}

function setAdCopyBusy(busy) {
  _adCopyLoading = busy;
  const regen = document.getElementById('btn-adcopy-regen');
  if (regen) { regen.disabled = busy; regen.textContent = busy ? 'Generating…' : 'Regenerate'; }
}

// Gather the page grounding shared by every ad-copy Claude call (the full set:
// title/meta/headings/excerpt, intent + sentiment, brand terms, Web CEO tracked
// keywords, real paid search terms, and intent-matched organic queries). Returns
// { context, insights, brandTerms } — no Claude call here.
async function buildAdCopyGrounding() {
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

  return { context, insights, brandTerms };
}

async function generateAdCopy(force) {
  if (_adCopyLoading) return;
  if (!pageData) { adcopyBodyMessage('Open this on a regular web page to generate ad copy.', true); return; }
  if (!force && _adCopy) { renderAdCopyFields(_adCopy, _adCopyInsights); return; }

  setAdCopyBusy(true);
  adcopyBodyMessage('Generating ad copy…');

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const { context, insights, brandTerms } = await buildAdCopyGrounding();
    const systemDynamic = buildAdCopySystem(insights, brandTerms);
    const systemBlocks = [{ type: 'text', text: AD_COPY_SYSTEM_BASE, cache_control: { type: 'ephemeral' } }];
    if (systemDynamic) systemBlocks.push({ type: 'text', text: systemDynamic });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_MID,
        max_tokens: 1600,
        system: systemBlocks,
        messages: [{ role: 'user', content: context }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    // Robust JSON extraction: strip code fences, then take the outermost {…}.
    let raw = (data.content?.[0]?.text ?? '').trim();
    raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) raw = raw.slice(start, end + 1);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Could not parse the ad copy response'); }

    // House style: strip em/en dashes + exclamation marks, then guarantee limits.
    ADS_GEN_ASSETS.forEach(a => {
      if (Array.isArray(parsed[a.key])) parsed[a.key] = parsed[a.key].map(t => sanitizeAdText(t));
    });
    parsed = await enforceAdCopyLimits(claudeApiKey, parsed);

    _adCopy = parsed;
    _adCopyInsights = insights;
    _adCopyContext = context;
    _adCopyBrandTerms = brandTerms;
    renderAdCopyFields(parsed, insights);
  } catch (err) {
    adcopyBodyMessage(err.message, true);
  } finally {
    setAdCopyBusy(false);
  }
}

// ─── Refine Negatives: find low-quality search terms to exclude ───────────────
// The inverse of the ad-copy generator: same page grounding, but Claude flags
// search terms that are irrelevant / wasteful so they can be pushed to
// campaign-level exclusion lists (NEGATIVE_KEYWORDS shared sets). Terms that
// convert, rank organically, or match the page's intent are protected in code
// and never offered to Claude as candidates. Sonnet (judgment, not bulk text).

const NEG_MATCH_OPTS = [
  { value: 'BROAD',  label: 'Broad' },
  { value: 'PHRASE', label: 'Phrase' },
  { value: 'EXACT',  label: 'Exact' },
];
const NEG_CANDIDATE_CAP = 120;   // highest-spend candidates sent to Claude

// What the confidence levels mean (shown as chip tooltips; mirrored in the prompt)
const NEG_CONF_HELP = {
  high:   'High confidence: clearly unrelated to this page or obvious junk. Safe to exclude.',
  medium: 'Medium confidence: probably irrelevant, but worth a quick look before excluding.',
  low:    'Low confidence: borderline. Only weak signals it is irrelevant — review carefully.',
};

let _negRecs = null;          // [{ text, reason, confidence, matchType, include, campaignId, campaignName, metrics… }]
let _negInsights = null;
let _negContext = '';
let _negProtectedCount = 0;
let _negLoading = false;
let _negResultLists = null;   // after commit: [{ name, terms:[{text,matchType}] }] for export
let _negCampaignLists = {};   // campaignId → [{id,name}] existing exclusion lists
let _negListChoice = {};      // campaignId → chosen list id ('' = create a new list)

function negNormMatch(mt) {
  const v = String(mt || 'BROAD').toUpperCase();
  return (v === 'EXACT' || v === 'PHRASE' || v === 'BROAD') ? v : 'BROAD';
}

// Tolerant parse of Claude's recommendation list: handles code fences, an object
// wrapper ({negatives:[…]}), surrounding prose, and a truncated response (salvages
// whatever complete {…} objects it can). Returns an array, or null if nothing usable.
function parseNegativesJson(text) {
  const raw = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  let v = tryParse(raw);
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.negatives)) return v.negatives;
  if (v && Array.isArray(v.terms)) return v.terms;

  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s !== -1 && e > s) {
    v = tryParse(raw.slice(s, e + 1));
    if (Array.isArray(v)) return v;
  }

  // Salvage individual objects (e.g. when the array was cut off mid-stream)
  const objs = raw.match(/\{[^{}]*\}/g);
  if (objs) {
    const out = [];
    objs.forEach(o => { const p = tryParse(o); if (p && (p.term || p.index != null)) out.push(p); });
    if (out.length) return out;
  }
  return null;
}

// The "Add to Google Ads" button lives in the panel header; show it only once
// there are recommendations to commit.
function setNegCommitVisible(show) {
  const btn = document.getElementById('btn-negatives-commit');
  if (btn) btn.classList.toggle('hidden', !show);
}

function resetNegatives() {
  _negRecs = null;
  _negInsights = null;
  _negContext = '';
  _negProtectedCount = 0;
  _negResultLists = null;
  _negCampaignLists = {};
  _negListChoice = {};
  setNegCommitVisible(false);
  const tunedEl = document.getElementById('negatives-tuned');
  if (tunedEl) tunedEl.replaceChildren();
  const body = document.getElementById('negatives-body');
  if (body) body.replaceChildren();
}

// ─── Negatives analysis cache (survives popup close/reopen) ──────────────────
// Keyed by page URL; cleared once terms are successfully pushed to Google Ads.
// TTL: 24 h (stale analysis is worse than re-running).

const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function saveNegCache() {
  try {
    const tab = await getActiveTab();
    const key = (tab.url || '').split('#')[0];
    const { negAnalysisCache } = await browser.storage.local.get('negAnalysisCache');
    const cache = negAnalysisCache || {};
    cache[key] = {
      recs: _negRecs,
      insights: _negInsights,
      protectedCount: _negProtectedCount,
      listChoice: _negListChoice,
      campaignLists: _negCampaignLists,
      fetchedAt: Date.now()
    };
    await browser.storage.local.set({ negAnalysisCache: cache });
  } catch { /* best-effort */ }
}

async function loadNegCache() {
  try {
    const tab = await getActiveTab();
    const key = (tab.url || '').split('#')[0];
    const { negAnalysisCache } = await browser.storage.local.get('negAnalysisCache');
    const entry = negAnalysisCache && negAnalysisCache[key];
    if (!entry || !Array.isArray(entry.recs)) return false;
    if (Date.now() - entry.fetchedAt > NEG_CACHE_TTL_MS) return false;
    _negRecs = entry.recs;
    _negInsights = entry.insights || null;
    _negProtectedCount = entry.protectedCount || 0;
    _negListChoice = entry.listChoice || {};
    _negCampaignLists = entry.campaignLists || {};
    return true;
  } catch { return false; }
}

async function clearNegCache() {
  try {
    const tab = await getActiveTab();
    const key = (tab.url || '').split('#')[0];
    const { negAnalysisCache } = await browser.storage.local.get('negAnalysisCache');
    if (negAnalysisCache && negAnalysisCache[key]) {
      delete negAnalysisCache[key];
      await browser.storage.local.set({ negAnalysisCache });
    }
  } catch { /* best-effort */ }
}

function negBodyMessage(msg, isError) {
  setNegCommitVisible(false);
  const tunedEl = document.getElementById('negatives-tuned');
  if (tunedEl) tunedEl.replaceChildren();
  const body = document.getElementById('negatives-body');
  if (!body) return;
  body.replaceChildren();
  const el = document.createElement('div');
  el.className = 'adcopy-message gen-result-text' + (isError ? ' is-error' : '');
  el.textContent = msg;
  body.appendChild(el);
}

function setNegBusy(busy) {
  _negLoading = busy;
  const regen = document.getElementById('btn-negatives-regen');
  if (regen) { regen.disabled = busy; regen.textContent = busy ? 'Analyzing…' : 'Re-analyze'; }
}

// adGroupId → { campaignId, campaignName } from the loaded ads
function negAdGroupCampaignMap() {
  const m = new Map();
  (_adsData?.ads || []).forEach(a => {
    if (a.adGroupId && !m.has(a.adGroupId)) m.set(a.adGroupId, { campaignId: a.campaignId, campaignName: a.campaign });
  });
  return m;
}

// Lookback picker (shares adsSelectedRange with the Ads tab)
function setNegRangeUI(range) {
  document.querySelectorAll('#negatives-range-group .mode-option').forEach(btn =>
    btn.classList.toggle('is-active', parseInt(btn.dataset.range, 10) === range));
}

document.querySelectorAll('#negatives-range-group .mode-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    const range = parseInt(btn.dataset.range, 10);
    if (range === adsSelectedRange) return;
    adsSelectedRange = range;
    setNegRangeUI(range);
    if (typeof setAdsRangeUI === 'function') setAdsRangeUI(range);
    browser.storage.local.set({ adsSelectedRange: range });
    // Refresh the page's ads data for the new window, then re-analyze
    negBodyMessage('Analyzing search terms…');
    await loadAdsData(false);
    generateNegatives(true);
  });
});

// Opening the panel: show cached recs, the in-flight state, or analyze fresh.
async function openNegativesPanel() {
  setNegRangeUI(adsSelectedRange);
  if (_negLoading) { negBodyMessage('Analyzing search terms…'); return; }
  if (_negRecs) { renderNegatives(); return; }
  // Restore cached analysis (from a previous popup session) before deciding to re-run.
  const restored = await loadNegCache();
  if (restored) { renderNegatives(); return; }
  generateNegatives(false);
}

const NEGATIVES_SYSTEM_BASE = [
  'You are a Google Ads search-term analyst. From the candidate search terms below, identify ONLY the ones that are irrelevant to this landing page or clearly low-quality and wasteful, and should be added as NEGATIVE keywords.',
  '',
  'Return ONLY a JSON array (no prose, no code fences). Each element is exactly:',
  '{"index": <number from the candidate list>, "term": "<the term>", "reason": "<short reason, 12 words max>", "matchType": "BROAD|PHRASE|EXACT", "confidence": "high|medium|low"}',
  '',
  'Only include terms you would actually exclude. If a term is plausibly relevant to the page, leave it out entirely.',
  'Match type guidance:',
  '- EXACT: one specific junk query to block verbatim.',
  '- PHRASE: a wasteful phrase whose close variants should also be blocked.',
  '- BROAD: an entire irrelevant theme or word that should never trigger this page.',
  'Be conservative: excluding a relevant term is worse than missing a junk one.',
  'confidence = how sure you are the term is irrelevant or wasteful for THIS page:',
  '- high: clearly unrelated to the page\'s product or service, or obvious junk. Safe to exclude.',
  '- medium: probably irrelevant, but a human should glance at it first.',
  '- low: borderline; only weak signals that it is irrelevant.',
  'Never use em dashes or en dashes in the reason text.',
].join('\n');

// Returns only the page-specific suffix (intent + brand terms).
// The cacheable base lives in NEGATIVES_SYSTEM_BASE above.
function buildNegativesSystem(insights, brandTerms) {
  const lines = [];
  if (insights?.intent && typeof OG_INTENT_GUIDANCE !== 'undefined' && OG_INTENT_GUIDANCE[insights.intent]) {
    lines.push(`The page's search intent is ${insights.intent}. Terms with a clearly different intent are strong negative candidates.`);
  }
  if (brandTerms.length) {
    lines.push(`Brand terms for this site: ${brandTerms.join(', ')}. Never exclude brand terms.`);
  }
  return lines.join('\n');
}

async function generateNegatives(force) {
  if (_negLoading) return;
  if (!_adsData || !(_adsData.searchTerms || []).length) {
    negBodyMessage('No search terms for this page yet. Open the Ads tab on a page with paid traffic first.', true);
    return;
  }
  if (!force && _negRecs) { renderNegatives(); return; }

  setNegBusy(true);
  negBodyMessage('Analyzing search terms…');

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const tab = await getActiveTab();

    // Negatives live in the long tail — pull the full search-term list first.
    if (_adsData.searchTermsLimited) {
      try {
        const more = await browser.runtime.sendMessage({ action: 'adsGetMoreSearchTerms', pageUrl: tab.url, range: adsSelectedRange });
        if (more && more.searchTerms) { _adsData.searchTerms = more.searchTerms; _adsData.searchTermsLimited = more.searchTermsLimited; }
      } catch { /* best effort — analyze what we have */ }
    }

    const pageUrl = pageData?.canonical || tab.url;
    let host = '';
    try { host = new URL(pageUrl, tab.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const brandTerms = (allBrandedTerms[host] || '').split('|').map(s => s.trim()).filter(Boolean);

    const cacheKey = (tab.url || '').split('#')[0];
    const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
    const insights = (aiInsightsCache || {})[cacheKey] || null;
    const pageIntent = insights?.intent || null;

    // Make sure intents are classified so the protection check below can use them.
    if (typeof ensureIntents === 'function') ensureIntents((_adsData.searchTerms || []).map(t => t.text), () => {});

    const organic = adsOrganicSet();
    const agMap = negAdGroupCampaignMap();

    // Aggregate each term across ad groups → campaigns, dropping protected terms.
    const byTerm = new Map();
    (_adsData.searchTerms || []).forEach(t => {
      const text = (t.text || '').trim();
      if (!text) return;
      const lc = text.toLowerCase();
      if (!byTerm.has(lc)) byTerm.set(lc, { text, impressions: 0, clicks: 0, cost: 0, conversions: 0, campaigns: new Map() });
      const agg = byTerm.get(lc);
      agg.impressions += t.impressions || 0; agg.clicks += t.clicks || 0;
      agg.cost += t.cost || 0; agg.conversions += t.conversions || 0;
      const camp = agMap.get(t.adGroupId);
      if (camp && camp.campaignId) agg.campaigns.set(camp.campaignId, camp.campaignName);
    });

    const candidates = [];
    let protectedCount = 0;
    byTerm.forEach(agg => {
      const lc = agg.text.toLowerCase();
      const isConverting  = agg.conversions > 0;
      const isOrganic     = organic.has(lc);
      const isIntentMatch = pageIntent && typeof intentOf === 'function' && intentOf(agg.text) === pageIntent;
      if (isConverting || isOrganic || isIntentMatch) { protectedCount++; return; }
      if (!agg.campaigns.size) return;   // can't attach a negative without a campaign
      candidates.push(agg);
    });
    _negProtectedCount = protectedCount;

    if (!candidates.length) {
      _negRecs = []; _negInsights = insights; _negResultLists = null;
      renderNegatives();
      return;
    }

    // Highest-spend first — those waste the most money — then cap for cost.
    const ranked = candidates.sort((a, b) => (b.cost - a.cost) || (b.impressions - a.impressions)).slice(0, NEG_CANDIDATE_CAP);

    const candidateLines = ranked.map((c, i) =>
      `${i}. "${c.text}" — impr ${adsNum(c.impressions)}, clicks ${adsNum(c.clicks)}, cost ${adsCost(c.cost, _adsData.currency)}, conv ${adsConv(c.conversions)}`
    ).join('\n');

    const context = [
      `Landing page URL: ${pageUrl}`,
      `Page title: "${pageData?.title?.text || ''}"`,
      pageData?.metaDescription?.text && `Meta description: "${pageData.metaDescription.text}"`,
      pageIntent          && `Page search intent: ${pageIntent}`,
      insights?.sentiment && `Page sentiment: ${insights.sentiment}`,
      brandTerms.length   && `Brand terms: ${brandTerms.join(', ')}`,
      pageData?.headings?.length && `Headings:\n${pageData.headings.map(h => `${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`,
      pageData?.bodyTextExcerpt  && `Page content excerpt: "${pageData.bodyTextExcerpt}"`,
      'Candidate search terms (already filtered to drop converting, organic, and intent-matching terms):\n' + candidateLines,
    ].filter(v => v !== undefined && v !== false && v !== null && v !== '').join('\n\n');

    const negSystemDynamic = buildNegativesSystem(insights, brandTerms);
    const negSystemBlocks = [{ type: 'text', text: NEGATIVES_SYSTEM_BASE, cache_control: { type: 'ephemeral' } }];
    if (negSystemDynamic) negSystemBlocks.push({ type: 'text', text: negSystemDynamic });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_MID,
        max_tokens: 4096,
        system: negSystemBlocks,
        messages: [{ role: 'user', content: context }]
      })
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message ?? `HTTP ${res.status}`); }

    const data = await res.json();
    const parsed = parseNegativesJson(data.content?.[0]?.text ?? '');
    if (!parsed) throw new Error('Could not parse the analysis response');

    // Map Claude's picks back to candidates, expanding to one row per campaign.
    const recs = [];
    parsed.forEach(p => {
      const idx = Number(p.index);
      const cand = Number.isInteger(idx) ? ranked[idx]
        : ranked.find(c => c.text.toLowerCase() === String(p.term || '').toLowerCase());
      if (!cand) return;
      const matchType  = negNormMatch(p.matchType);
      const reason     = String(p.reason || '').trim();
      const confidence = ['high', 'medium', 'low'].includes(String(p.confidence || '').toLowerCase()) ? p.confidence.toLowerCase() : '';
      [...cand.campaigns.entries()].forEach(([campaignId, campaignName]) => {
        recs.push({
          text: cand.text, reason, confidence, matchType, include: true,
          campaignId, campaignName,
          impressions: cand.impressions, clicks: cand.clicks, cost: cand.cost, conversions: cand.conversions
        });
      });
    });

    _negRecs = recs;
    _negInsights = insights;
    _negContext = context;
    _negResultLists = null;
    saveNegCache();

    // Existing exclusion lists per campaign → destination picker (default: first
    // attached list if any, else create a new one).
    _negCampaignLists = {};
    _negListChoice = {};
    const campIds = [...new Set(recs.map(r => r.campaignId).filter(Boolean))];
    if (campIds.length) {
      try {
        const lr = await browser.runtime.sendMessage({ action: 'adsGetCampaignNegLists', pageUrl: tab.url, campaignIds: campIds });
        if (lr && lr.byCampaign) _negCampaignLists = lr.byCampaign;
      } catch { /* best effort — default to creating a new list */ }
    }
    campIds.forEach(id => { _negListChoice[id] = (_negCampaignLists[id] && _negCampaignLists[id][0]?.id) || ''; });

    renderNegatives();
  } catch (err) {
    negBodyMessage(err.message, true);
  } finally {
    setNegBusy(false);
  }
}

// A campaign sub-header: name + estimated savings + destination-list picker.
function makeNegCampaignRow(campaignId, name, savingsEl) {
  const row = document.createElement('div');
  row.className = 'neg-campaign';

  const left = document.createElement('span');
  left.className = 'neg-campaign-left';
  const nm = document.createElement('span');
  nm.className = 'neg-campaign-name';
  nm.textContent = name || 'Campaign';
  nm.title = name || 'Campaign';
  left.appendChild(nm);
  if (savingsEl) left.appendChild(savingsEl);
  row.appendChild(left);

  // Destination exclusion list: existing attached lists + "create new"
  const sel = document.createElement('select');
  sel.className = 'neg-list-select';
  sel.title = 'Exclusion list these negatives are added to';
  (_negCampaignLists[campaignId] || []).forEach(l => {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.name;
    sel.appendChild(o);
  });
  const createOpt = document.createElement('option');
  createOpt.value = '';
  createOpt.textContent = `Create new: ${name || 'Campaign'} — Negatives`;
  sel.appendChild(createOpt);
  sel.value = _negListChoice[campaignId] ?? '';
  sel.addEventListener('change', () => { _negListChoice[campaignId] = sel.value; });
  row.appendChild(sel);

  return row;
}

// Column header for a campaign's table
function makeNegTableHead() {
  const head = document.createElement('div');
  head.className = 'neg-table-head';
  const hMatch = document.createElement('span'); hMatch.className = 'neg-h-match'; hMatch.textContent = 'Match';
  const hImpr  = document.createElement('span'); hImpr.className  = 'neg-h-impr';  hImpr.textContent  = 'Impr';
  const hClk   = document.createElement('span'); hClk.className   = 'neg-h-clk';   hClk.textContent   = 'Clicks';
  const hCost  = document.createElement('span'); hCost.className  = 'neg-h-cost';  hCost.textContent  = 'Cost';
  head.append(hMatch, hImpr, hClk, hCost);
  return head;
}

// One table row: [✓] [Broad|Phrase|Exact] [term] … [Impr][Clicks][Cost]; the
// confidence chip + explanation sit on the line below.
function makeNegRow(r, onToggle) {
  const row = document.createElement('div');
  row.className = 'neg-row' + (r.include ? '' : ' neg-row--off');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'neg-row-check';
  cb.checked = r.include;
  cb.addEventListener('change', () => {
    r.include = cb.checked;
    row.classList.toggle('neg-row--off', !cb.checked);
    if (onToggle) onToggle();
  });

  // Match-type selector — right after the checkbox
  const seg = document.createElement('div');
  seg.className = 'neg-match-seg';
  NEG_MATCH_OPTS.forEach(opt => {
    const b = document.createElement('button');
    b.className = 'neg-match-opt' + (r.matchType === opt.value ? ' is-active' : '');
    b.textContent = opt.label;
    b.title = adsFormatKeyword(r.text, opt.value);
    b.addEventListener('click', () => {
      r.matchType = opt.value;
      seg.querySelectorAll('.neg-match-opt').forEach(el => el.classList.toggle('is-active', el === b));
    });
    seg.appendChild(b);
  });

  // Metrics — far right
  const impr = document.createElement('span'); impr.className = 'neg-cell-impr neg-m'; impr.textContent = adsNum(r.impressions);
  const clk  = document.createElement('span'); clk.className  = 'neg-cell-clk neg-m';  clk.textContent  = adsNum(r.clicks);
  const cost = document.createElement('span'); cost.className = 'neg-cell-cost neg-m'; cost.textContent = adsCost(r.cost, _adsData && _adsData.currency);

  // Term — clickable; opens a Google search so you can confirm relevance
  const term = document.createElement('div');
  term.className = 'neg-row-term neg-term-link';
  term.textContent = r.text;
  term.title = `Search Google for “${r.text}”`;
  term.addEventListener('click', () => {
    browser.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(r.text)}` });
  });

  // Confidence chip + explanation — line below the term
  const reason = document.createElement('div');
  reason.className = 'neg-row-reason';
  if (r.confidence) {
    const conf = document.createElement('span');
    conf.className = 'neg-conf neg-conf--' + r.confidence;
    conf.textContent = r.confidence;
    conf.title = NEG_CONF_HELP[r.confidence] || '';
    reason.appendChild(conf);
  }
  if (r.reason) {
    const txt = document.createElement('span');
    txt.className = 'neg-reason-text';
    txt.textContent = r.reason;
    reason.appendChild(txt);
  }

  row.append(cb, seg, impr, clk, cost, term, reason);
  return row;
}

function renderNegatives() {
  const body = document.getElementById('negatives-body');
  if (!body) return;
  body.replaceChildren();

  // "Tuned for" chips in the panel header
  const tunedEl = document.getElementById('negatives-tuned');
  if (tunedEl) {
    tunedEl.replaceChildren();
    const chips = typeof buildInsightChips === 'function' ? buildInsightChips(_negInsights) : null;
    if (chips) { tunedEl.appendChild(document.createTextNode('Tuned for ')); tunedEl.appendChild(chips); }
  }

  if (!_negRecs || !_negRecs.length) {
    negBodyMessage(_negProtectedCount
      ? `No low-quality terms found. ${_negProtectedCount} term${_negProtectedCount === 1 ? '' : 's'} protected (converting, organic, or intent-matching).`
      : 'No low-quality terms found. Every candidate looks relevant to this page.');
    return;
  }

  setNegCommitVisible(true);
  const commitBtn = document.getElementById('btn-negatives-commit');
  if (commitBtn) { commitBtn.disabled = false; commitBtn.textContent = 'Add to Google Ads'; }

  // Each campaign is its own table: name + savings, then a header, then rows.
  const table = document.createElement('div');
  table.className = 'neg-table';

  const groups = new Map();
  _negRecs.forEach(r => {
    if (!groups.has(r.campaignId)) groups.set(r.campaignId, { name: r.campaignName, recs: [] });
    groups.get(r.campaignId).recs.push(r);
  });

  groups.forEach((g, campaignId) => {
    const savingsEl = document.createElement('span');
    savingsEl.className = 'neg-campaign-saved';
    // Live: cost of the checked terms for this campaign over the selected window
    const update = () => {
      const incl = (_negRecs || []).filter(r => r.campaignId === campaignId && r.include);
      const sum = incl.reduce((s, r) => s + (r.cost || 0), 0);
      savingsEl.textContent = incl.length ? `${adsCost(sum, _adsData && _adsData.currency)} saved` : 'none selected';
      savingsEl.title = `Estimated spend from the ${incl.length} checked term${incl.length === 1 ? '' : 's'} over the selected window`;
    };
    table.appendChild(makeNegCampaignRow(campaignId, g.name, savingsEl));
    table.appendChild(makeNegTableHead());
    g.recs.forEach(r => table.appendChild(makeNegRow(r, update)));
    update();
  });
  body.appendChild(table);

  // Export area (populated after a successful commit)
  const exportWrap = document.createElement('div');
  exportWrap.id = 'neg-export';
  exportWrap.className = 'field-section neg-export hidden';
  body.appendChild(exportWrap);
}

async function commitNegatives(btn) {
  if (!btn || btn.disabled) return;
  const selected = (_negRecs || []).filter(r => r.include && r.campaignId);
  if (!selected.length) { btn.title = 'Check at least one term first'; return; }

  btn.disabled = true;
  btn.textContent = 'Adding…';
  const exportWrap = document.getElementById('neg-export');
  try {
    const tab = await getActiveTab();
    const byCamp = new Map();
    selected.forEach(r => {
      if (!byCamp.has(r.campaignId)) byCamp.set(r.campaignId, { campaignId: r.campaignId, campaignName: r.campaignName, terms: [] });
      byCamp.get(r.campaignId).terms.push({ text: r.text, matchType: r.matchType });
    });
    // Apply the per-campaign destination choice ('' = create a new list)
    const campaigns = [...byCamp.values()].map(c => {
      const choice = _negListChoice[c.campaignId];
      return choice
        ? { ...c, sharedSetId: choice }
        : { ...c, createNew: true, listName: `Campaign - ${c.campaignName || 'Campaign'}` };
    });

    const res = await browser.runtime.sendMessage({ action: 'adsAddNegatives', pageUrl: tab.url, campaigns });
    if (!res || res.connected === false) {
      throw new Error(res?.reauthRequired ? 'Google Ads connection expired — reconnect in Settings.' : 'Not connected to Google Ads.');
    }
    if (res.error) throw new Error(adsErrorMessage(res.error, res.detail));
    renderNegativesResult(res.results || [], btn);
    // Clear the cache once terms are successfully applied (no errors in any campaign).
    const anyError = (res.results || []).some(r => r.error);
    if (!anyError) clearNegCache();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Add to Google Ads';
    btn.title = err.message;
    if (exportWrap) {
      exportWrap.classList.remove('hidden');
      exportWrap.replaceChildren();
      const e = document.createElement('div');
      e.className = 'gen-result-text is-error';
      e.textContent = err.message;
      exportWrap.appendChild(e);
    }
  }
}

// Outline format: -List name / --term (broad) / --"term" (phrase) / --[term] (exact)
function buildNegativesOutline(lists) {
  const out = [];
  lists.forEach(list => {
    out.push(`-${list.name}`);
    list.terms.forEach(t => out.push(`--${adsFormatKeyword(t.text, t.matchType)}`));
  });
  return out.join('\n');
}

function renderNegativesResult(results, commitBtn) {
  const lists = [];
  const summaryLines = [];
  let totalAdded = 0, hadError = false;
  results.forEach(r => {
    if (r.error) { hadError = true; summaryLines.push(`${r.campaignName || 'Campaign'}: error — ${r.error}`); return; }
    const added = r.added || [], skipped = r.skipped || [];
    totalAdded += added.length;
    if (added.length) lists.push({ name: r.listName || `Campaign - ${r.campaignName}`, terms: added });
    summaryLines.push(`${r.listName || r.campaignName}: ${added.length} added${skipped.length ? `, ${skipped.length} already present` : ''}`);
  });
  _negResultLists = lists;

  const exportWrap = document.getElementById('neg-export');
  if (exportWrap) {
    exportWrap.classList.remove('hidden');
    exportWrap.replaceChildren();

    const head = document.createElement('div');
    head.className = 'field-label';
    head.textContent = hadError ? 'Done (with errors)' : 'Added to Google Ads';
    exportWrap.appendChild(head);

    summaryLines.forEach(line => {
      const el = document.createElement('div');
      el.className = 'field-hint';
      el.textContent = line;
      exportWrap.appendChild(el);
    });

    if (lists.length) {
      const exportRow = document.createElement('div');
      exportRow.className = 'neg-export-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'save-key-btn';
      copyBtn.textContent = 'Copy list';
      copyBtn.addEventListener('click', () => {
        copyToClipboard(buildNegativesOutline(lists));
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyBtn.textContent = 'Copy list'; }, 1500);
      });
      exportRow.appendChild(copyBtn);

      const docBtn = document.createElement('button');
      docBtn.className = 'save-key-btn';
      docBtn.textContent = 'Create Google Doc';
      docBtn.addEventListener('click', () => exportNegativesToDoc(docBtn));
      exportRow.appendChild(docBtn);

      exportWrap.appendChild(exportRow);
    }
  }

  if (commitBtn) {
    commitBtn.textContent = totalAdded ? 'Added ✓' : (hadError ? 'Add to Google Ads' : 'Nothing new to add');
    commitBtn.disabled = hadError ? false : true;
    setTimeout(() => { commitBtn.textContent = 'Add to Google Ads'; commitBtn.disabled = false; }, 4000);
  }
}

async function exportNegativesToDoc(btn) {
  if (!_negResultLists || !_negResultLists.length) return;
  let pageUrl = '';
  try { pageUrl = (pageData && pageData.canonical) || (await getActiveTab()).url; } catch { /* keep default */ }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Creating…';

  async function attempt() {
    return browser.runtime.sendMessage({ action: 'docsExportNegatives', lists: _negResultLists, pageUrl });
  }
  let res = await attempt();
  if (res && res.notConnected) {
    const auth = await browser.runtime.sendMessage({ action: 'docsConnect' });
    if (!auth || auth.error) { btn.disabled = false; btn.textContent = orig; btn.title = 'Google Docs auth failed — try again'; return; }
    res = await attempt();
  }
  btn.disabled = false;
  if (res && res.url) {
    browser.tabs.create({ url: res.url });
    btn.textContent = 'Opened ✓';
    setTimeout(() => { btn.textContent = orig; }, 3000);
  } else {
    btn.textContent = orig;
    btn.title = `Export failed: ${(res && res.error) || 'unknown error'}`;
  }
}

// ─── Ad-group drill-in: assets, with on-the-fly copy ──────────────────────────
// Clicking an ad-group name opens this panel straight on the creative: each ad's
// RSA headlines/descriptions with Google's per-asset rating (Low/Good/Best) +
// pinning, plus a generator for new on-brand assets to copy (no live mutation).
// Most ad groups have one ad; when there are several, each ad's rows are indented
// under a bold ad header (mirroring the campaign → ad group indent on the Ads tab).

let _adGroupDrillId = null;     // ad group being viewed

const ADS_AD_TYPE_LABELS = {
  RESPONSIVE_SEARCH_AD: 'Responsive search ad',
  EXPANDED_TEXT_AD: 'Expanded text ad',
  RESPONSIVE_DISPLAY_AD: 'Responsive display ad',
  TEXT_AD: 'Text ad',
};
function adsFriendlyType(t) {
  if (!t) return 'Ad';
  return ADS_AD_TYPE_LABELS[t] || t.toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

const ADS_PERF_LABELS = { BEST: 'Best', GOOD: 'Good', LOW: 'Low', LEARNING: 'Learning', PENDING: 'Pending' };
function adsPerfLabel(l) { return ADS_PERF_LABELS[l] || (l ? l.toLowerCase().replace(/^\w/, c => c.toUpperCase()) : ''); }
function adsPerfClass(l) {
  if (l === 'BEST') return 'best';
  if (l === 'GOOD') return 'good';
  if (l === 'LOW')  return 'low';
  return 'other';
}
// HEADLINE_1 → "H1", DESCRIPTION_2 → "D2"; ignore unspecified/unknown
function adsPinLabel(pinned) {
  if (!pinned || /UNSPEC|UNKNOWN/i.test(pinned)) return '';
  const m = String(pinned).match(/(HEADLINE|DESCRIPTION)_(\d+)/i);
  if (!m) return '';
  return `Pinned ${m[1][0].toUpperCase()}${m[2]}`;
}

// Entry point from the ads tree
function drillIntoAdGroup(adGroupId) {
  _adGroupDrillId = adGroupId;
  if (typeof showAdGroupPanel === 'function') showAdGroupPanel();
}

// Called by showAdGroupPanel (popup-nav.js) when the panel opens
function openAdGroupPanel() {
  if (!_adGroupDrillId) return;
  renderAdGroupDetail();
}

function setAdGroupTitle(title, subtitle) {
  const t = document.getElementById('adgroup-title');
  if (t) t.textContent = title || 'AD GROUP';
  const s = document.getElementById('adgroup-subtitle');
  if (s) s.textContent = subtitle || '';
}

function adgroupMessage(msg, isError) {
  const el = document.createElement('div');
  el.className = 'field-section ' + (isError ? 'gen-result-text is-error' : 'field-hint');
  el.textContent = msg;
  return el;
}

async function renderAdGroupDetail() {
  const body = document.getElementById('adgroup-body');
  if (!body) return;
  body.replaceChildren();

  const ads = (_adsData?.ads || []).filter(a => a.adGroupId === _adGroupDrillId);
  setAdGroupTitle(ads[0]?.adGroup || 'Ad group', ads.length ? `${ads.length} ad${ads.length === 1 ? '' : 's'}` : '');

  if (!ads.length) {
    body.appendChild(adgroupMessage('No ads point to this page in this ad group for the selected period.'));
    return;
  }

  body.appendChild(adgroupMessage('Loading ads…'));

  try {
    const tab = await getActiveTab();
    const res = await browser.runtime.sendMessage({ action: 'adsGetAdsDetail', pageUrl: tab.url, adIds: ads.map(a => a.adId) });
    if (!res || res.error) throw new Error(adsErrorMessage(res?.error || 'API_ERROR', res?.detail));
    if (_adGroupDrillId == null) return;   // panel closed mid-load
    body.replaceChildren();

    const multi = ads.length > 1;
    ads.slice().sort((a, b) => b.cost - a.cost).forEach(a => {
      const detail = (res.ads || {})[a.adId] || { headlines: [], descriptions: [], type: a.type, name: a.adName };
      renderOneAd(a, detail, multi, body);
    });
  } catch (err) {
    body.replaceChildren();
    body.appendChild(adgroupMessage(err.message, true));
  }
}

function renderOneAd(ad, detail, multi, body) {
  const type = detail.type || ad.type;

  // With multiple ads, a bold ad header (like a campaign row); rows below indent.
  if (multi) {
    const header = document.createElement('div');
    header.className = 'adgroup-ad-header';
    const name = document.createElement('span');
    name.className = 'adgroup-ad-header-name';
    name.textContent = ad.adName || adsFriendlyType(type);
    header.appendChild(name);
    body.appendChild(header);
  }

  // Type + metrics summary table (header row + data row)
  const summary = document.createElement('div');
  summary.className = 'field-section adgroup-detail-summary' + (multi ? ' adgroup-indent' : '');

  const metricsTable = document.createElement('div');
  metricsTable.className = 'adgroup-metrics-table';

  const headerRow = document.createElement('div');
  headerRow.className = 'adgroup-metrics-row adgroup-metrics-row--header';
  ['Ad type', 'Impr.', 'Clicks', 'Cost', 'Conv.'].forEach((h, i) => {
    const cell = document.createElement('span');
    cell.className = i === 0 ? 'adgroup-metrics-type' : 'adgroup-metrics-num';
    cell.textContent = h;
    headerRow.appendChild(cell);
  });
  metricsTable.appendChild(headerRow);

  const dataRow = document.createElement('div');
  dataRow.className = 'adgroup-metrics-row';
  const currency = _adsData && _adsData.currency;
  [
    [adsFriendlyType(type), 'adgroup-metrics-type'],
    [adsNum(ad.impressions),              'adgroup-metrics-num'],
    [adsNum(ad.clicks),                   'adgroup-metrics-num'],
    [adsCost(ad.cost, currency),          'adgroup-metrics-num'],
    [adsConv(ad.conversions),             'adgroup-metrics-num'],
  ].forEach(([val, cls]) => {
    const cell = document.createElement('span');
    cell.className = cls;
    cell.textContent = val;
    dataRow.appendChild(cell);
  });
  metricsTable.appendChild(dataRow);
  summary.appendChild(metricsTable);
  body.appendChild(summary);

  const hasAssets = (detail.headlines || []).length || (detail.descriptions || []).length;
  if (!hasAssets) {
    body.appendChild(adgroupMessage(`This ${adsFriendlyType(type).toLowerCase()} doesn't expose editable headline/description assets.`));
    return;
  }

  renderAdAssetSection('Headlines', 'headlines', detail.headlines || [], body, multi);
  renderAdAssetSection('Descriptions', 'descriptions', detail.descriptions || [], body, multi);
}

function renderAdAssetSection(label, assetKey, items, body, indent) {
  const asset = ADS_GEN_ASSETS.find(a => a.key === assetKey);
  const section = document.createElement('section');
  section.className = 'field-section adgroup-asset-section' + (indent ? ' adgroup-indent' : '');

  const head = document.createElement('div');
  head.className = 'field-header';
  const lbl = document.createElement('span');
  lbl.className = 'field-label';
  lbl.textContent = `${label} (${items.length})`;
  const gen = document.createElement('button');
  gen.className = 'save-key-btn';
  gen.title = `Generate a new ${asset.one}`;
  gen.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 1l1.4 4.6L14 7l-4.6 1.4L8 13l-1.4-4.6L2 7l4.6-1.4z"/></svg>'));
  gen.appendChild(document.createTextNode(' Generate'));
  head.appendChild(lbl);
  head.appendChild(gen);
  section.appendChild(head);

  const sugg = document.createElement('div');
  sugg.className = 'adgroup-suggestions';

  const existingTexts = () => [
    ...items.map(i => i.text),
    ...[...sugg.querySelectorAll('.adcopy-field')].map(e => e.value.trim()).filter(Boolean)
  ];

  // Existing assets; LOW-rated ones get an inline generate button
  items.forEach(it => section.appendChild(makeAssetRow(
    it, asset.max,
    it.label === 'LOW' ? (btn) => runAssetGenerate(asset, sugg, existingTexts, btn) : null
  )));

  section.appendChild(sugg);
  gen.addEventListener('click', () => runAssetGenerate(asset, sugg, existingTexts, gen));
  body.appendChild(section);
}

// Generate one asset line and append it as an editable suggestion. Works for both
// the section's "Generate *" (text button) and the per-row LOW button (icon).
async function runAssetGenerate(asset, sugg, existingTexts, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  if (orig) btn.textContent = 'Generating…'; else btn.classList.add('is-busy');
  try {
    const text = await generateOneAdLine(asset, existingTexts());
    sugg.appendChild(makeAdSuggestionRow(asset, text, existingTexts));
  } catch (err) {
    btn.title = err.message;
    setTimeout(() => { btn.title = ''; }, 2500);
  } finally {
    btn.disabled = false;
    if (orig) btn.textContent = orig; else btn.classList.remove('is-busy');
  }
}

// An existing live asset: text + rating + pinned + char count. LOW assets also get
// an inline generate button (onGenerate supplied).
function makeAssetRow(item, max, onGenerate) {
  const row = document.createElement('div');
  row.className = 'asset-row' + (item.enabled === false ? ' asset-row--off' : '');

  const text = document.createElement('div');
  text.className = 'asset-text';
  text.textContent = item.text;
  row.appendChild(text);

  const badges = document.createElement('div');
  badges.className = 'asset-badges';
  if (item.label) {
    const b = document.createElement('span');
    b.className = 'asset-perf asset-perf--' + adsPerfClass(item.label);
    b.textContent = adsPerfLabel(item.label);
    badges.appendChild(b);
  }
  const pin = adsPinLabel(item.pinned);
  if (pin) {
    const p = document.createElement('span');
    p.className = 'asset-pin';
    p.textContent = pin;
    badges.appendChild(p);
  }
  const count = document.createElement('span');
  count.className = 'asset-count';
  count.textContent = `${item.text.length}/${max}`;
  badges.appendChild(count);

  if (onGenerate) {
    const gb = document.createElement('button');
    gb.className = 'gen-result-btn asset-gen-low';
    gb.title = 'Generate a replacement';
    gb.appendChild(svgFromString(
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 1l1.4 4.6L14 7l-4.6 1.4L8 13l-1.4-4.6L2 7l4.6-1.4z"/></svg>'));
    gb.addEventListener('click', () => onGenerate(gb));
    badges.appendChild(gb);
  }

  row.appendChild(badges);
  return row;
}

// A generated suggestion: editable field with char count, regen, and copy
function makeAdSuggestionRow(asset, text, getExisting) {
  const row = document.createElement('div');
  row.className = 'adcopy-field-row';
  const useTextarea = asset.max > 30;
  const input = document.createElement(useTextarea ? 'textarea' : 'input');
  input.className = 'adcopy-field';
  input.spellcheck = false;
  if (useTextarea) { input.rows = 2; row.classList.add('adcopy-field-row--multiline'); } else input.type = 'text';
  input.value = text;

  const count = document.createElement('span');
  count.className = adcopyCountClass(text.length, asset.max);
  count.textContent = `${text.length}/${asset.max}`;
  input.addEventListener('input', () => {
    const len = input.value.length;
    count.className = adcopyCountClass(len, asset.max);
    count.textContent = `${len}/${asset.max}`;
  });

  const regen = document.createElement('button');
  regen.className = 'gen-result-btn adcopy-regen-line';
  regen.title = 'Regenerate this line';
  regen.appendChild(svgFromString(
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.5 8A5.5 5.5 0 1 1 8 2.5a5.5 5.5 0 0 1 3.9 1.6L13.5 5.6"/>' +
    '<polyline points="13.5 2 13.5 5.6 9.9 5.6"/></svg>'));
  regen.addEventListener('click', async () => {
    if (regen.disabled) return;
    regen.disabled = true;
    regen.classList.add('is-busy');
    try {
      const sibs = (getExisting() || []).filter(t => t !== input.value.trim());
      const out = await generateOneAdLine(asset, sibs);
      input.value = out;
      count.className = adcopyCountClass(out.length, asset.max);
      count.textContent = `${out.length}/${asset.max}`;
    } catch {
      regen.title = 'Regenerate failed — try again';
      setTimeout(() => { regen.title = 'Regenerate this line'; }, 2500);
    } finally {
      regen.disabled = false;
      regen.classList.remove('is-busy');
    }
  });

  const actions = document.createElement('div');
  actions.className = 'adcopy-field-actions';
  actions.appendChild(count);
  actions.appendChild(regen);
  actions.appendChild(adsGenCopyBtn(() => input.value));

  row.appendChild(input);
  row.appendChild(actions);
  return row;
}

// One grounded asset line (headline/description), distinct from `existing`.
// Re-gathers page grounding each call (cheap; no extra Claude billing).
async function generateOneAdLine(asset, existing) {
  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');
  const { context, insights, brandTerms } = await buildAdCopyGrounding();
  const system = buildAdLineSystem(asset, insights, brandTerms, existing);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': claudeApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: MODEL_MID,
      max_tokens: 120,
      system,
      messages: [{ role: 'user', content: context }]
    })
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message ?? `HTTP ${res.status}`); }
  const data = await res.json();
  let out = sanitizeAdText((data.content?.[0]?.text ?? '').trim().replace(/^["']|["']$/g, ''));
  if (!out) throw new Error('empty');
  if (out.length > asset.max) out = adcopyHardTrim(out, asset.max);
  return out;
}
