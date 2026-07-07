// Web CEO rank tracking tab: keyword positions for the current domain's WebCEO
// project, plus the Settings connection (API key + base URL) and per-domain
// project picker. WebCEO is a whitelabel-friendly, API-key (no OAuth) service;
// the data layer lives in background.js (webceo* handlers).

let webceoSelectedDepth = 2;          // history_depth (number of recent scans)
let _webceoHost = null;
let _webceoData = null;               // last webceoGetRankings response
let _webceoOnPageOnly = true;         // default: focus on keywords ranking for this page
let _webceoStrikingOnly = false;      // filter to striking-distance (pos 4–20) quick wins
let _webceoIntent = null;             // intent filter (null = All, else one of INTENTS)

const WEBCEO_ERRORS = {
  NO_API_KEY: 'Add your Web CEO API key in Settings.',
  BAD_KEY: 'Web CEO rejected the API key. Check it in Settings (Agency Unlimited only).',
  RATE_LIMITED: 'Web CEO API rate limit reached. Try again in a moment.',
  NETWORK: 'Network error talking to Web CEO.',
  API_ERROR: 'Web CEO API error.',
  NO_PROJECT: 'No Web CEO project matches this domain.'
};
function webceoErrorMessage(error, detail) {
  const base = WEBCEO_ERRORS[error] || `Web CEO error: ${error}`;
  return detail ? `${base} (${detail})` : base;
}

// ─── Cross-tab signal: the project's tracked keyword set ─────────────────────
// Used by the Search and Ads tabs to flag terms already tracked in Web CEO.

let _webceoTrackedSet = null;         // lowercased tracked keywords, or null (unloaded)
let _webceoTrackedLoading = false;

function webceoIsTracked(term) {
  return !!(_webceoTrackedSet && _webceoTrackedSet.has((term || '').toLowerCase().trim()));
}
function markWebceoTracked(term) {
  if (_webceoTrackedSet) _webceoTrackedSet.add((term || '').toLowerCase().trim());
}
async function ensureWebceoTracked(onReady) {
  // Already loaded or in flight → do nothing (the caller's render already has the
  // data, or the in-flight load's callback will re-render). Calling onReady here
  // would recurse with renders that re-invoke this loader.
  if (_webceoTrackedSet || _webceoTrackedLoading) return;
  _webceoTrackedLoading = true;
  try {
    const tab = await getActiveTab();
    const res = await sendMessageWithTimeout({ action: 'webceoGetTrackedKeywords', pageUrl: tab.url });
    _webceoTrackedSet = new Set((res && res.keywords || []).map(k => String(k).toLowerCase().trim()));
  } catch { _webceoTrackedSet = new Set(); }
  _webceoTrackedLoading = false;
  if (onReady) onReady();
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function webceoRanked(p) { return p != null && p > 0; }   // 0/null = not in tracked results
function webceoPos(p) { return webceoRanked(p) ? String(p) : '—'; }
function webceoVol(v) { return v == null ? '—' : Math.round(v).toLocaleString(); }

// Position change cell: lower is better, so previous − current (positive = up)
function webceoChangeEl(current, previous) {
  const el = document.createElement('span');
  el.className = 'ranking-change';
  const c = webceoRanked(current) ? current : null;
  const p = webceoRanked(previous) ? previous : null;
  if (c == null) {                                           // not ranked now
    if (p != null) { el.textContent = 'lost'; el.classList.add('ranking-change--down'); } // was ranked last scan → dropped off
    return el;
  }
  if (p == null) { el.textContent = 'new'; el.classList.add('ranking-change--up'); return el; }
  const delta = p - c;
  if (delta === 0) return el;
  el.textContent = `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}`;
  el.classList.add(delta > 0 ? 'ranking-change--up' : 'ranking-change--down');
  return el;
}

// Engine identity (search engine + device) for the pivoted columns
function webceoEngineKey(r) {
  const se = (r.se || '').trim() || 'SE';
  return r.mobile ? `${se} ${r.mobile === 2 ? 'tablet' : 'mobile'}` : se;
}
function webceoEngineLabel(eng) { return eng.replace(/\b\w/g, c => c.toUpperCase()); }

// ─── Rankings intelligence helpers (scorecard / movers / opportunities) ──────

// Best (lowest) ranked position for a pivoted keyword across its engines, using
// the given field ('position' = current, 'previous' = last scan). null = unranked.
function webceoBestPos(kw, field = 'position') {
  let best = null;
  Object.values(kw.engines || {}).forEach(e => {
    const p = e && e[field];
    if (webceoRanked(p) && (best == null || p < best)) best = p;
  });
  return best;
}

// Rough Google organic CTR-by-position curve, used to weight visibility &
// traffic value. Index 0 unused; 1–10 are page-one, then page-two and beyond
// taper off. Deliberately approximate — it's a relative weighting, not a claim.
const WEBCEO_CTR_CURVE = [0, 0.28, 0.15, 0.11, 0.08, 0.06, 0.045, 0.035, 0.03, 0.025, 0.02];
function webceoCtrForPosition(pos) {
  if (!webceoRanked(pos)) return 0;
  if (pos <= 10) return WEBCEO_CTR_CURVE[pos];
  if (pos <= 20) return 0.01;
  return 0.004;
}

// Striking distance = positions 4–20: page-one-adjacent + page two, where a
// small push yields outsized traffic. (Top 3 are already won.)
function webceoIsStriking(pos) { return webceoRanked(pos) && pos >= 4 && pos <= 20; }

// Normalize a ranking URL to host+path (drop www + trailing slash) so the same
// page under different query strings/protocols counts once.
function webceoNormalizeUrl(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, ''); }
  catch { return null; }
}

// Map of keyword → distinct ranking URLs seen across all scans/engines. ≥2
// distinct = Google is flip-flopping which of your pages ranks = possible
// cannibalization. Built once per render from the flat rows' per-scan history.
function webceoDriftMap() {
  const map = new Map();               // keyword → Map(normalized → original url)
  ((_webceoData && _webceoData.rows) || []).forEach(r => {
    if (!map.has(r.keyword)) map.set(r.keyword, new Map());
    const seen = map.get(r.keyword);
    (r.history || []).forEach(pt => {
      if (!webceoRanked(pt.pos) || !pt.url) return;
      const n = webceoNormalizeUrl(pt.url);
      if (n && !seen.has(n)) seen.set(n, pt.url);
    });
  });
  const out = new Map();
  map.forEach((seen, kw) => { if (seen.size >= 2) out.set(kw, [...seen.values()]); });
  return out;
}

// ─── CPC enrichment (Google Ads Keyword Ideas) for the $ traffic-value stat ──
// Mirrors the Search tab's ensureGscQueryVolume: a flat keyword→CPC(dollars)
// cache topped up with the missing terms, re-rendering once via onReady. CPC is
// account-independent Keyword Plan data, so it works whenever Ads is connected.
let _webceoCpcMap = {};                 // keyword(lower) → cpc dollars | null
let _webceoCpcLoading = false;
let _webceoCpcState = 'unknown';        // 'unknown' | 'available' | 'unavailable'
let _webceoCpcHost = null;              // reset the cache when the domain changes

async function ensureWebceoCpc(keywords, onReady) {
  if (_webceoCpcLoading || _webceoCpcState === 'unavailable') return;
  const need = [];
  const seen = new Set();
  (keywords || []).forEach(k => {
    const lc = (k || '').toLowerCase().trim();
    if (!lc || seen.has(lc) || (lc in _webceoCpcMap)) return;
    seen.add(lc); need.push(k);
  });
  if (!need.length) return;

  _webceoCpcLoading = true;
  try {
    const tab = await getActiveTab();
    const res = await sendMessageWithTimeout({ action: 'adsGetKeywordIdeas', pageUrl: tab.url, keywords: need });
    const NO_ADS = new Set(['NOT_CONNECTED', 'REAUTH_REQUIRED', 'NO_DEV_TOKEN', 'NO_ACCOUNT']);
    if (res && NO_ADS.has(res.error) && !Object.keys(res.byKeyword || {}).length) {
      _webceoCpcState = 'unavailable';
    } else if (res) {
      _webceoCpcState = 'available';
      need.forEach(t => { const lc = (t || '').toLowerCase().trim(); if (!(lc in _webceoCpcMap)) _webceoCpcMap[lc] = null; });
      Object.entries(res.byKeyword || {}).forEach(([lc, v]) => {
        const micros = (typeof gscCpcMicros === 'function') ? gscCpcMicros(v) : 0;
        _webceoCpcMap[lc] = micros > 0 ? micros / 1e6 : null;
      });
    }
  } catch { /* transient — try again next render */ }
  _webceoCpcLoading = false;
  onReady();
}

// ─── Chart: avg position over scans (click a row to focus one keyword) ───────

let _webceoSelectedKeyword = null;

const RANKING_METRICS = {
  position: { label: 'Avg position', invertY: true, format: v => (Math.round(v * 10) / 10).toString() }
};

// Average ranked position per scan date across the rows in scope
function webceoChartSeries(selectedKeyword) {
  const byDate = {};
  ((_webceoData && _webceoData.rows) || []).forEach(r => {
    if (selectedKeyword && r.keyword !== selectedKeyword) return;
    if (!selectedKeyword && _webceoIntent && intentOf(r.keyword) !== _webceoIntent) return;
    (r.history || []).forEach(pt => {
      if (!webceoRanked(pt.pos)) return;
      if (!byDate[pt.date]) byDate[pt.date] = { date: pt.date, sum: 0, n: 0 };
      byDate[pt.date].sum += pt.pos; byDate[pt.date].n++;
    });
  });
  return Object.keys(byDate).sort().map(d => ({ date: d, position: byDate[d].sum / byDate[d].n }));
}

function renderRankingChart() {
  const container = document.getElementById('ranking-chart');
  if (!container) return;
  document.getElementById('ranking-chart-label').textContent =
    _webceoSelectedKeyword ? `“${_webceoSelectedKeyword}”` : (_webceoIntent ? `${_webceoIntent.toUpperCase()} · AVG POSITION` : 'AVERAGE POSITION');
  document.getElementById('btn-ranking-chart-clear').classList.toggle('hidden', !_webceoSelectedKeyword);

  const series = webceoChartSeries(_webceoSelectedKeyword);
  if (series.length < 2) {
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = series.length === 1
      ? 'Only one scan so far — the trend appears after the next scan.'
      : 'No ranked positions to chart yet.';
    container.replaceChildren(hint);
    return;
  }
  const width = container.clientWidth || 320;
  const built = buildCombinedChart(series, { position: true }, { width, metrics: RANKING_METRICS });
  container.replaceChildren(svgFromString(built.svg));
  attachChartHover(container.querySelector('svg'), series, { position: true }, built);
}

if (window.ResizeObserver) {
  let raf = null;
  new ResizeObserver(() => { if (raf) return; raf = requestAnimationFrame(() => { raf = null; renderRankingChart(); }); })
    .observe(document.getElementById('ranking-chart'));
}

document.getElementById('btn-ranking-chart-clear').addEventListener('click', () => {
  _webceoSelectedKeyword = null;
  renderRankingChart();
  renderRankingTable();
});

// ─── Tab: rankings table (pivoted — one column per search engine) ────────────

function setWebceoDepthUI(depth) {
  document.querySelectorAll('#ranking-depth-group .mode-option').forEach(btn =>
    btn.classList.toggle('is-active', parseInt(btn.dataset.depth, 10) === depth));
}

// Does a ranking URL point at the currently inspected page?
function webceoUrlIsThisPage(url) {
  if (!url) return false;
  try {
    const a = new URL(url);
    const b = new URL(_webceoData && _webceoData.pageUrl || location.href);
    return a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '') &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch { return false; }
}

// Group flat rows (keyword × engine) into one row per keyword, engines as columns
function webceoPivot(rows) {
  const map = new Map();
  const engineSet = new Set();
  rows.forEach(r => {
    const eng = webceoEngineKey(r);
    engineSet.add(eng);
    if (!map.has(r.keyword)) map.set(r.keyword, { keyword: r.keyword, volume: null, starred: false, engines: {} });
    const g = map.get(r.keyword);
    if (r.volume != null) g.volume = Math.max(g.volume == null ? 0 : g.volume, r.volume);
    if (r.starred) g.starred = true;
    g.engines[eng] = { position: r.position, previous: r.previous, url: r.url };
  });
  return { keywords: [...map.values()], engines: [...engineSet].sort() };
}

function webceoKeywordOnPage(kw) {
  return Object.values(kw.engines).some(e => webceoUrlIsThisPage(e.url));
}

// Chips for a ranking keyword: on-page locations (Title/Desc/H1–H5) + an "Ad"
// chip when we're bidding on it — same styling as the Search tab.
function rankingTermChips(text) {
  const wrap = document.createElement('span');
  wrap.className = 'gsc-query-chips';
  if (typeof adsIsBidKeyword === 'function' && adsIsBidKeyword(text)) {
    const ad = document.createElement('span');
    ad.className = 'gsc-chip gsc-ad-chip';
    ad.textContent = 'Ad';
    ad.title = 'You are bidding on this keyword in Google Ads';
    wrap.appendChild(ad);
  }
  (typeof gscQueryLocations === 'function' && typeof pageData !== 'undefined' ? gscQueryLocations(text, pageData) : []).forEach(loc => {
    const chip = document.createElement('span');
    chip.className = 'gsc-chip';
    chip.textContent = loc;
    wrap.appendChild(chip);
  });
  return wrap.childNodes.length ? wrap : null;
}

let _rankSort = { column: 'volume', dir: 'desc' };

function renderRankingTable() {
  const container = document.getElementById('ranking-table');
  container.replaceChildren();
  const { keywords, engines } = webceoPivot((_webceoData && _webceoData.rows) || []);
  const grid = `1fr ${engines.map(() => '58px').join(' ')} 52px`;

  const header = document.createElement('div');
  header.className = 'ranking-row ranking-row--header';
  header.style.gridTemplateColumns = grid;
  const cols = [{ key: 'keyword', label: 'Keyword', term: true }]
    .concat(engines.map(e => ({ key: 'eng:' + e, label: webceoEngineLabel(e) })))
    .concat([{ key: 'volume', label: 'Vol' }]);
  cols.forEach(c => {
    const cell = document.createElement('span');
    cell.className = (c.term ? 'ranking-cell-term' : 'ranking-cell-num') + ' ads-sort';
    const active = _rankSort.column === c.key;
    cell.textContent = c.label + (active ? (_rankSort.dir === 'asc' ? ' ▲' : ' ▼') : '');
    cell.addEventListener('click', () => {
      if (_rankSort.column === c.key) _rankSort.dir = _rankSort.dir === 'asc' ? 'desc' : 'asc';
      else { _rankSort.column = c.key; _rankSort.dir = c.key === 'keyword' ? 'asc' : (c.key.startsWith('eng:') ? 'asc' : 'desc'); }
      renderRankingTable();
    });
    header.appendChild(cell);
  });
  container.appendChild(header);

  const engPos = (k, eng) => { const e = k.engines[eng]; return (e && webceoRanked(e.position)) ? e.position : null; };
  const driftMap = webceoDriftMap();
  let onPageVisible = keywords.filter(k => !_webceoOnPageOnly || webceoKeywordOnPage(k));
  if (_webceoStrikingOnly) onPageVisible = onPageVisible.filter(k => webceoIsStriking(webceoBestPos(k, 'position')));
  // Intent chips count over the on-page-filtered set, then narrow the rows
  renderIntentChips(document.getElementById('ranking-intent-filters'), onPageVisible, k => k.keyword, _webceoIntent, (intent) => {
    _webceoIntent = intent;
    renderRankingTable();
    renderRankingChart();
  });
  const visible = onPageVisible.filter(k => !_webceoIntent || intentOf(k.keyword) === _webceoIntent);
  visible.sort((a, b) => {
    if (_rankSort.column === 'keyword') {
      const r = (a.keyword || '').toLowerCase().localeCompare((b.keyword || '').toLowerCase());
      return _rankSort.dir === 'asc' ? r : -r;
    }
    const val = k => {
      if (_rankSort.column === 'volume') return k.volume == null ? -Infinity : k.volume;
      const p = engPos(k, _rankSort.column.slice(4));
      return p == null ? Infinity : p;          // unranked sorts last when asc by position
    };
    const av = val(a), bv = val(b);
    return _rankSort.dir === 'asc' ? av - bv : bv - av;
  });

  if (!visible.length) { document.getElementById('ranking-empty').classList.remove('hidden'); return; }
  document.getElementById('ranking-empty').classList.add('hidden');

  visible.forEach(k => {
    const row = document.createElement('div');
    row.className = 'ranking-row ranking-row--click';
    row.style.gridTemplateColumns = grid;
    if (webceoKeywordOnPage(k)) row.classList.add('ranking-row--onpage');
    if (_webceoSelectedKeyword === k.keyword) row.classList.add('ranking-row--selected');

    // keyword (text opens a Google search; the row selects the chart)
    const term = document.createElement('span');
    term.className = 'ranking-cell-term';
    const kw = document.createElement('span');
    kw.className = 'ranking-keyword ads-term-link';
    kw.textContent = k.keyword;
    kw.title = `Search Google for “${k.keyword}”`;
    kw.addEventListener('click', (e) => { e.stopPropagation(); browser.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(k.keyword)}` }); });
    term.appendChild(kw);
    if (k.starred) { const s = document.createElement('span'); s.className = 'ranking-star'; s.textContent = '★'; term.appendChild(s); }
    const chips = rankingTermChips(k.keyword);
    if (chips) term.appendChild(chips);
    const drift = driftMap.get(k.keyword);
    if (drift) {
      const dc = document.createElement('span');
      dc.className = 'gsc-chip ranking-drift-chip';
      dc.textContent = '⚠ URL drift';
      dc.title = 'Google has ranked more than one of your pages for this term (possible cannibalization):\n' + drift.join('\n');
      term.appendChild(dc);
    }
    row.appendChild(term);

    engines.forEach(eng => {
      const cell = document.createElement('span');
      cell.className = 'ranking-cell-num ranking-engine-cell';
      const e = k.engines[eng];
      if (e && webceoRanked(e.position)) {
        const pos = document.createElement('span');
        pos.className = 'ranking-pos';
        pos.textContent = e.position;
        cell.appendChild(pos);
        const ch = webceoChangeEl(e.position, e.previous);
        if (ch.textContent) cell.appendChild(ch);
      } else {
        const dash = document.createElement('span');
        dash.textContent = '—';
        cell.appendChild(dash);
        // Dropped off since last scan → show a "lost" chip beside the dash
        const ch = webceoChangeEl(e ? e.position : null, e ? e.previous : null);
        if (ch.textContent) cell.appendChild(ch);
      }
      row.appendChild(cell);
    });

    const vol = document.createElement('span');
    vol.className = 'ranking-cell-num';
    vol.textContent = webceoVol(k.volume);
    row.appendChild(vol);

    row.addEventListener('click', () => selectRankingKeyword(k.keyword));
    container.appendChild(row);
  });

  // Classify keywords by intent (shared Haiku cache); re-renders once when ready
  ensureIntents(((_webceoData && _webceoData.rows) || []).map(r => r.keyword), () => renderRankingTable());
}

function selectRankingKeyword(keyword) {
  _webceoSelectedKeyword = (_webceoSelectedKeyword === keyword) ? null : keyword;
  renderRankingTable();
  renderRankingChart();
}

// ─── Scorecard: distribution buckets + Visibility % + est. traffic value ─────

function renderRankingScorecard() {
  const el = document.getElementById('ranking-scorecard');
  if (!el) return;
  const { keywords } = webceoPivot((_webceoData && _webceoData.rows) || []);
  if (!keywords.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  // Best current/previous position per keyword
  const stats = keywords.map(k => ({
    vol: k.volume == null ? 0 : k.volume,
    now: webceoBestPos(k, 'position'),
    prev: webceoBestPos(k, 'previous'),
    kw: k.keyword
  }));

  // Distribution buckets by best current position
  const buckets = { top3: 0, top10: 0, top20: 0, rest: 0, unranked: 0 };
  stats.forEach(s => {
    if (!webceoRanked(s.now)) buckets.unranked++;
    else if (s.now <= 3) buckets.top3++;
    else if (s.now <= 10) buckets.top10++;
    else if (s.now <= 20) buckets.top20++;
    else buckets.rest++;
  });

  // SEO Visibility %: Σ(vol·CTR(pos)) / Σ(vol·CTR(1)) — share of the clicks a
  // set of all-#1 rankings would earn. WoW delta uses each keyword's prev pos.
  let earned = 0, earnedPrev = 0, ideal = 0;
  stats.forEach(s => {
    const w = s.vol || 0;
    ideal += w * webceoCtrForPosition(1);
    earned += w * webceoCtrForPosition(s.now);
    earnedPrev += w * webceoCtrForPosition(s.prev);
  });
  const vis = ideal > 0 ? (earned / ideal) * 100 : null;
  const visPrev = ideal > 0 ? (earnedPrev / ideal) * 100 : null;
  const visDelta = (vis != null && visPrev != null) ? vis - visPrev : null;

  // Est. monthly traffic value: Σ(vol·CTR(pos)·CPC). Needs Ads CPC — kick off
  // enrichment and re-render this card once it lands.
  let value = 0, haveCpc = false;
  stats.forEach(s => {
    const cpc = _webceoCpcMap[(s.kw || '').toLowerCase().trim()];
    if (cpc == null || !webceoRanked(s.now)) return;
    haveCpc = true;
    value += (s.vol || 0) * webceoCtrForPosition(s.now) * cpc;
  });

  const stat = (label, value, sub, cls) => {
    const box = document.createElement('div');
    box.className = 'ranking-stat' + (cls ? ' ' + cls : '');
    const v = document.createElement('div'); v.className = 'ranking-stat-val'; v.textContent = value;
    const l = document.createElement('div'); l.className = 'ranking-stat-label'; l.textContent = label;
    box.append(v, l);
    if (sub) { const s = document.createElement('div'); s.className = 'ranking-stat-sub'; s.append(sub); box.appendChild(s); }
    return box;
  };

  el.replaceChildren();

  // Visibility % with WoW delta chip
  let visSub = null;
  if (visDelta != null && Math.abs(visDelta) >= 0.05) {
    visSub = document.createElement('span');
    visSub.className = 'ranking-change ' + (visDelta > 0 ? 'ranking-change--up' : 'ranking-change--down');
    visSub.textContent = `${visDelta > 0 ? '▲' : '▼'}${Math.abs(visDelta).toFixed(1)}pt`;
  }
  el.appendChild(stat('Visibility', vis == null ? '—' : `${vis.toFixed(vis < 10 ? 1 : 0)}%`, visSub, 'ranking-stat--primary'));

  // Distribution as a single stat with a mini breakdown
  const distSub = document.createElement('span');
  distSub.className = 'ranking-dist';
  [['Top 3', buckets.top3, 'g'], ['4–10', buckets.top10, 'a'], ['11–20', buckets.top20, 'o'], ['20+', buckets.rest + buckets.unranked, 'm']]
    .forEach(([lbl, n, c]) => {
      const seg = document.createElement('span');
      seg.className = 'ranking-dist-seg ranking-dist-seg--' + c;
      seg.textContent = n;
      seg.title = `${n} keyword${n === 1 ? '' : 's'} · ${lbl}`;
      distSub.appendChild(seg);
    });
  el.appendChild(stat('Positions', String(stats.length), distSub));

  // Traffic value (only when Ads CPC is available)
  if (haveCpc) {
    const currency = (typeof _adsData !== 'undefined' && _adsData) ? _adsData.currency : null;
    const money = (typeof adsCost === 'function') ? adsCost(value, currency) : ('$' + Math.round(value).toLocaleString());
    const vBox = stat('Traffic value', money + '/mo', null, 'ranking-stat--value');
    vBox.title = 'Estimated monthly value of these rankings in equivalent Google Ads spend (volume × CTR-by-position × CPC)';
    el.appendChild(vBox);
  }

  // Enrich CPC in the background; re-render the card when it arrives.
  ensureWebceoCpc(keywords.map(k => k.keyword), () => renderRankingScorecard());
}

function renderWebceoPanel(response) {
  const ids = ['ranking-no-key', 'ranking-no-project', 'ranking-error', 'ranking-data'];
  ids.forEach(id => document.getElementById(id).classList.add('hidden'));

  if (!response || !response.connected) { document.getElementById('ranking-no-key').classList.remove('hidden'); return; }
  if (response.error === 'NO_PROJECT') {
    if (response.host) _webceoHost = response.host;
    loadWebceoProjectPicker(document.getElementById('ranking-project-picker'));
    document.getElementById('ranking-no-project').classList.remove('hidden');
    return;
  }
  if (response.error) {
    document.getElementById('ranking-error-text').textContent = webceoErrorMessage(response.error, response.detail);
    document.getElementById('ranking-error').classList.remove('hidden');
    return;
  }

  // Reset the Ads-CPC cache when the domain changes (keyword set differs)
  if (response.host !== _webceoCpcHost) { _webceoCpcMap = {}; _webceoCpcState = 'unknown'; _webceoCpcHost = response.host; }

  _webceoData = response;
  _webceoSelectedKeyword = null;
  _webceoIntent = null;
  setWebceoDepthUI(webceoSelectedDepth);
  document.getElementById('ranking-onpage-only').checked = _webceoOnPageOnly;
  const striking = document.getElementById('ranking-striking-only');
  if (striking) striking.checked = _webceoStrikingOnly;
  const kwCount = new Set((response.rows || []).map(r => r.keyword)).size;
  document.getElementById('ranking-meta').textContent =
    `${response.projectName || response.domain || ''} · ${kwCount} keywords · Updated ${gscRelativeTime(response.fetchedAt)}`;
  renderRankingScorecard();
  renderRankingChart();
  renderRankingTable();
  // "Ad" chips appear once the page's ad-keyword set has loaded
  if (typeof ensureAdsKeywordSet === 'function') ensureAdsKeywordSet(() => renderRankingTable());
  document.getElementById('ranking-data').classList.remove('hidden');
}

async function loadWebceoData(forceRefresh = false) {
  const tab = await getActiveTab();
  try { _webceoHost = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { _webceoHost = null; }
  const response = await sendMessageWithTimeout({ action: 'webceoGetRankings', pageUrl: tab.url, historyDepth: webceoSelectedDepth, forceRefresh });
  if (response) response.pageUrl = tab.url;
  renderWebceoPanel(response);
}

document.querySelectorAll('#ranking-depth-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const depth = parseInt(btn.dataset.depth, 10);
    if (depth === webceoSelectedDepth) return;
    webceoSelectedDepth = depth;
    setWebceoDepthUI(depth);
    browser.storage.local.set({ webceoSelectedDepth: depth });
    loadWebceoData(false);
  });
});

document.getElementById('ranking-onpage-only').addEventListener('change', (e) => {
  _webceoOnPageOnly = e.target.checked;
  if (_webceoData) renderRankingTable();
});

document.getElementById('ranking-striking-only').addEventListener('change', (e) => {
  _webceoStrikingOnly = e.target.checked;
  if (_webceoData) renderRankingTable();
});

document.getElementById('btn-ranking-goto-settings').addEventListener('click', () => showSettings());

// ─── Project picker (per-domain, mirrors the GA/Ads pickers) ─────────────────

function renderWebceoProjectOptions(container, projects, selected, onSelect) {
  container.replaceChildren();

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ga-property-search';
  search.placeholder = 'Search projects…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  container.appendChild(search);

  projects
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
    .forEach(p => {
      const opt = document.createElement('button');
      opt.className = 'gsc-property-option' + (p.project === selected ? ' gsc-property-option--active' : '');
      opt.dataset.search = `${p.name} ${p.domain}`.toLowerCase();
      const radio = document.createElement('span');
      radio.className = 'gsc-property-radio';
      const text = document.createElement('span');
      text.className = 'gsc-property-option-text';
      text.textContent = p.name;
      opt.append(radio, text);
      const idEl = document.createElement('span');
      idEl.className = 'gsc-property-id';
      idEl.textContent = p.domain;
      opt.appendChild(idEl);
      opt.addEventListener('click', async () => {
        container.querySelectorAll('.gsc-property-option').forEach(el =>
          el.classList.toggle('gsc-property-option--active', el === opt));
        await sendMessageWithTimeout({ action: 'webceoSetProject', host: _webceoHost, project: p.project });
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

// Used by the tab's no-project state: pick a project, then reload the tab
async function loadWebceoProjectPicker(container) {
  container.replaceChildren();
  const tab = await getActiveTab();
  const res = await sendMessageWithTimeout({ action: 'webceoResolveProject', pageUrl: tab.url });
  if (!res || !res.connected || res.error || !res.projects || !res.projects.length) return;
  _webceoHost = res.host;
  renderWebceoProjectOptions(container, res.projects, res.project, () => loadWebceoData(true));
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function refreshWebceoSettingsStatus() {
  const status = await sendMessageWithTimeout({ action: 'webceoGetStatus' });
  const badge = document.getElementById('webceo-status-badge');
  const box = document.getElementById('webceo-project-box');

  document.getElementById('webceo-base-url').value = status.baseUrl || '';
  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setWebceoKeyState(true);
    // Once the key is stored, collapse the inputs out of the way (like Google Ads)
    setWebceoConfigCollapsed(true);
    box.classList.remove('hidden');
    refreshWebceoProjectInfo();
  } else {
    badge.textContent = 'Connect';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setWebceoKeyState(false);
    setWebceoConfigCollapsed(false);
    box.classList.add('hidden');
  }
  return status;
}

function setWebceoConfigCollapsed(collapsed) {
  document.getElementById('webceo-config-fields').classList.toggle('hidden', collapsed);
  // The "Edit" link (now in the section header) shows only while collapsed.
  document.getElementById('btn-webceo-edit-config').classList.toggle('hidden', !collapsed);
}

document.getElementById('btn-webceo-edit-config').addEventListener('click', () => setWebceoConfigCollapsed(false));

async function refreshWebceoProjectInfo() {
  const matchEl = document.getElementById('webceo-project-match');
  const allEl = document.getElementById('webceo-project-all');
  matchEl.className = 'gsc-property-match hidden';
  allEl.replaceChildren();

  const tab = await getActiveTab();
  const res = await sendMessageWithTimeout({ action: 'webceoResolveProject', pageUrl: tab.url });
  if (!res || !res.connected) return;
  if (res.error) {
    matchEl.textContent = webceoErrorMessage(res.error, res.detail);
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  _webceoHost = res.host;
  if (!res.projects.length) {
    matchEl.textContent = 'No projects on this Web CEO account';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  const sel = res.project && res.projects.find(p => p.project === res.project);
  if (sel) {
    renderSelectedRow(allEl, sel.name,
      async () => {
        await sendMessageWithTimeout({ action: 'webceoSetProject', host: _webceoHost, project: null });
        renderWebceoProjectOptions(allEl, res.projects, null, () => refreshWebceoProjectInfo());
      }, sel.domain);
    return;
  }
  renderWebceoProjectOptions(allEl, res.projects, res.project, () => refreshWebceoProjectInfo());
}

// API-key field: masked once stored, editable + reveal eye when empty
function setWebceoKeyState(hasKey) {
  const input = document.getElementById('webceo-api-key');
  document.getElementById('btn-webceo-key-vis').classList.toggle('hidden', hasKey);
  document.getElementById('btn-webceo-key-clear').classList.toggle('hidden', !hasKey);
  input.type = 'password';
  input.value = '';
  input.readOnly = hasKey;
  input.placeholder = hasKey ? '••••••••••••' : 'Web CEO API key';
  document.getElementById('webceo-eye-open').classList.remove('hidden');
  document.getElementById('webceo-eye-closed').classList.add('hidden');
}

document.getElementById('btn-webceo-key-vis').addEventListener('click', () => {
  const input = document.getElementById('webceo-api-key');
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  document.getElementById('webceo-eye-open').classList.toggle('hidden', isHidden);
  document.getElementById('webceo-eye-closed').classList.toggle('hidden', !isHidden);
});

document.getElementById('btn-webceo-key-clear').addEventListener('click', async () => {
  await sendMessageWithTimeout({ action: 'webceoDisconnect' });
  setWebceoKeyState(false);
  refreshWebceoSettingsStatus();
});

// The chip is a 3-state control: "Connect" when disconnected (Web CEO has no
// OAuth, so this just focuses the API-key field), "Connected" otherwise
// (hover → red "Disconnect", click → disconnect).
document.getElementById('webceo-status-badge').addEventListener('click', async (e) => {
  if (e.currentTarget.classList.contains('gsc-status-badge--disconnected')) {
    document.getElementById('webceo-api-key').focus();
    return;
  }
  await sendMessageWithTimeout({ action: 'webceoDisconnect' });
  setWebceoKeyState(false);
  await refreshWebceoSettingsStatus();
});

document.getElementById('btn-webceo-save-config').addEventListener('click', async () => {
  const keyInput = document.getElementById('webceo-api-key');
  const baseUrl = document.getElementById('webceo-base-url').value.trim();
  const update = { baseUrl };
  if (!keyInput.readOnly) update.apiKey = keyInput.value.trim();
  await sendMessageWithTimeout({ action: 'webceoSaveConfig', ...update });
  if (!keyInput.readOnly && update.apiKey) setWebceoKeyState(true);
  refreshWebceoSettingsStatus();
});

// Called from the Search tab's "+ Track" chip: add a GSC query as a tracked
// keyword in this domain's Web CEO project.
async function trackQueryInWebceo(keyword, chip, intent) {
  if (chip) { chip.disabled = true; chip.textContent = '…'; }
  let res;
  try {
    const tab = await getActiveTab();
    const tags = intent ? [intent] : [];
    res = await sendMessageWithTimeout({ action: 'webceoAddKeywords', pageUrl: tab.url, keywords: [keyword], tags });
  } catch { res = { error: 'NETWORK' }; }
  if (!chip) return;
  if (res && res.ok) {
    chip.textContent = 'Tracked';
    chip.disabled = true;
    chip.classList.add('gsc-track-chip--done');
    markWebceoTracked(keyword);
  } else {
    chip.textContent = '+ Track';
    chip.disabled = false;
    chip.title = (!res || !res.connected) ? 'Add a Web CEO API key in Settings' : webceoErrorMessage(res.error, res.detail);
    chip.classList.add('gsc-track-chip--err');
    setTimeout(() => chip.classList.remove('gsc-track-chip--err'), 2500);
  }
}

function loadWebceoPrefs() {
  return browser.storage.local.get(['webceoSelectedDepth']).then(({ webceoSelectedDepth: stored }) => {
    webceoSelectedDepth = stored || 2;
    setWebceoDepthUI(webceoSelectedDepth);
  });
}
