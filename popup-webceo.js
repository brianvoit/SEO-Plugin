// Web CEO rank tracking tab: keyword positions for the current domain's WebCEO
// project, plus the Settings connection (API key + base URL) and per-domain
// project picker. WebCEO is a whitelabel-friendly, API-key (no OAuth) service;
// the data layer lives in background.js (webceo* handlers).

let webceoSelectedDepth = 2;          // history_depth (number of recent scans)
let _webceoHost = null;
let _webceoData = null;               // last webceoGetRankings response
let _webceoOnPageOnly = false;        // filter to keywords ranking for this page
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
    const res = await browser.runtime.sendMessage({ action: 'webceoGetTrackedKeywords', pageUrl: tab.url });
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
  if (c == null) return el;                                  // not ranked → blank
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
  const onPageVisible = keywords.filter(k => !_webceoOnPageOnly || webceoKeywordOnPage(k));
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
        cell.textContent = '—';
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

  _webceoData = response;
  _webceoSelectedKeyword = null;
  _webceoIntent = null;
  setWebceoDepthUI(webceoSelectedDepth);
  document.getElementById('ranking-onpage-only').checked = _webceoOnPageOnly;
  const kwCount = new Set((response.rows || []).map(r => r.keyword)).size;
  document.getElementById('ranking-meta').textContent =
    `${response.projectName || response.domain || ''} · ${kwCount} keywords · Updated ${gscRelativeTime(response.fetchedAt)}`;
  renderRankingChart();
  renderRankingTable();
  // "Ad" chips appear once the page's ad-keyword set has loaded
  if (typeof ensureAdsKeywordSet === 'function') ensureAdsKeywordSet(() => renderRankingTable());
  document.getElementById('ranking-data').classList.remove('hidden');
}

async function loadWebceoData(forceRefresh = false) {
  const tab = await getActiveTab();
  try { _webceoHost = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { _webceoHost = null; }
  const response = await browser.runtime.sendMessage({ action: 'webceoGetRankings', pageUrl: tab.url, historyDepth: webceoSelectedDepth, forceRefresh });
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
        await browser.runtime.sendMessage({ action: 'webceoSetProject', host: _webceoHost, project: p.project });
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
  const res = await browser.runtime.sendMessage({ action: 'webceoResolveProject', pageUrl: tab.url });
  if (!res || !res.connected || res.error || !res.projects || !res.projects.length) return;
  _webceoHost = res.host;
  renderWebceoProjectOptions(container, res.projects, res.project, () => loadWebceoData(true));
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function refreshWebceoSettingsStatus() {
  const status = await browser.runtime.sendMessage({ action: 'webceoGetStatus' });
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
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setWebceoKeyState(false);
    setWebceoConfigCollapsed(false);
    box.classList.add('hidden');
  }
  return status;
}

function setWebceoConfigCollapsed(collapsed) {
  document.getElementById('webceo-config-fields').classList.toggle('hidden', collapsed);
  document.getElementById('webceo-config-collapsed').classList.toggle('hidden', !collapsed);
}

document.getElementById('btn-webceo-edit-config').addEventListener('click', () => setWebceoConfigCollapsed(false));

async function refreshWebceoProjectInfo() {
  const matchEl = document.getElementById('webceo-project-match');
  const allEl = document.getElementById('webceo-project-all');
  matchEl.className = 'gsc-property-match hidden';
  allEl.replaceChildren();

  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'webceoResolveProject', pageUrl: tab.url });
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
        await browser.runtime.sendMessage({ action: 'webceoSetProject', host: _webceoHost, project: null });
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
  await browser.runtime.sendMessage({ action: 'webceoDisconnect' });
  setWebceoKeyState(false);
  refreshWebceoSettingsStatus();
});

// The "Connected" chip doubles as the disconnect control
document.getElementById('webceo-status-badge').addEventListener('click', async (e) => {
  if (!e.currentTarget.classList.contains('gsc-status-badge--connected')) return;
  await browser.runtime.sendMessage({ action: 'webceoDisconnect' });
  setWebceoKeyState(false);
  await refreshWebceoSettingsStatus();
});

document.getElementById('btn-webceo-save-config').addEventListener('click', async () => {
  const keyInput = document.getElementById('webceo-api-key');
  const baseUrl = document.getElementById('webceo-base-url').value.trim();
  const update = { baseUrl };
  if (!keyInput.readOnly) update.apiKey = keyInput.value.trim();
  await browser.runtime.sendMessage({ action: 'webceoSaveConfig', ...update });
  if (!keyInput.readOnly && update.apiKey) setWebceoKeyState(true);
  refreshWebceoSettingsStatus();
});

// Called from the Search tab's "+ Track" chip: add a GSC query as a tracked
// keyword in this domain's Web CEO project.
async function trackQueryInWebceo(keyword, chip) {
  if (chip) { chip.disabled = true; chip.textContent = '…'; }
  let res;
  try {
    const tab = await getActiveTab();
    res = await browser.runtime.sendMessage({ action: 'webceoAddKeywords', pageUrl: tab.url, keywords: [keyword] });
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
