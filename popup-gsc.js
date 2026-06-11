// Google Search Console integration: OAuth/connection settings, the
// performance charts, the queries table, and indexing status — everything
// shown in #gsc-panel plus its Settings section.

// Google Search Console state
let gscSelectedRange = 30;
let gscHideBranded = true;
let gscActiveMetrics = { clicks: true, impressions: true, position: true };
let gscQuerySort = { column: 'clicks', direction: 'desc' };
let _gscPageUrl = null;
let _gscSiteUrl = null;
let _gscQueries = [];
let _gscFilled = [];
let _gscOverviewData = null;
let _gscSelectedQuery = null;

const GSC_METRICS = {
  clicks:      { label: 'Clicks',       format: n => Math.round(n).toLocaleString(), invertY: false },
  impressions: { label: 'Impressions',  format: n => Math.round(n).toLocaleString(), invertY: false },
  position:    { label: 'Avg Position', format: n => n.toFixed(1),                    invertY: true  }
};

// Query table columns, in display order (Query column is fixed/first)
const GSC_QUERY_COLUMNS = [
  { key: 'impressions', label: 'Impr.',  format: v => Math.round(v).toLocaleString() },
  { key: 'clicks',      label: 'Clicks', format: v => Math.round(v).toLocaleString() },
  { key: 'position',    label: 'Pos.',   format: v => v.toFixed(1) },
  { key: 'ctr',         label: 'CTR',    format: v => (v * 100).toFixed(1) + '%' }
];

// Lower position is better, so default that column to ascending
const GSC_QUERY_SORT_DEFAULT_DIR = { impressions: 'desc', clicks: 'desc', position: 'asc', ctr: 'desc' };

// ─── Google Search Console: helpers ──────────────────────────────────────────

function formatDateShort(dateStr, withYear = false) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (withYear) opts.year = '2-digit';
  return d.toLocaleDateString('en-US', opts);
}

function formatDateLong(dateStr, withYear = false) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (withYear) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

function gscRelativeTime(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const GSC_ERROR_MESSAGES = {
  RATE_LIMITED: 'Search Console API rate limit reached. Try again in a moment.',
  API_ERROR: 'Search Console API error.',
  TOKEN_REFRESH_FAILED: 'Could not refresh your Google connection. Try reconnecting in Settings.'
};

function gscErrorMessage(error, detail) {
  const base = GSC_ERROR_MESSAGES[error] || `Search Console error: ${error}`;
  return detail ? `${base} (${detail})` : base;
}

const GSC_CONNECT_ERRORS = {
  NO_CLIENT_ID: 'Enter an OAuth Client ID first.',
  STATE_MISMATCH: 'Authorization response did not match — please try again.',
  NO_CODE: 'Google did not return an authorization code.',
  TOKEN_EXCHANGE_FAILED: 'Could not exchange the authorization code for tokens. Check your Client ID/Secret.'
};

function gscConnectErrorMessage(error) {
  return GSC_CONNECT_ERRORS[error] || `Connection failed: ${error}`;
}

// ─── Google Search Console: chart helper ─────────────────────────────────────

function buildCombinedChart(filled, activeMetrics, { width = 320, height = 130 } = {}) {
  const padL = 6, padR = 6, padT = 10, padB = 16;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const n = filled.length;
  const xFor = i => padL + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);

  // Each metric is normalized to its own min/max so wildly different scales
  // (clicks, impressions, position) can share one chart. Real values live in
  // the toggle headers and the hover tooltip.
  const scales = {};
  Object.keys(GSC_METRICS).forEach(metric => {
    const cfg = GSC_METRICS[metric];
    const points = filled
      .map((d, i) => ({ i, value: metric === 'position' ? (d.impressions > 0 ? d.position : null) : d[metric] }))
      .filter(p => p.value !== null && p.value !== undefined);
    if (!points.length) { scales[metric] = null; return; }
    const values = points.map(p => p.value);
    const min = Math.min(...values), max = Math.max(...values);
    // Always leave ~10% headroom above the data, so the line never touches the top edge
    const headroom = ((max - min) || Math.abs(max) || 1) * 0.1;
    const axisMin = cfg.invertY ? min - headroom : min;
    const axisMax = cfg.invertY ? max : max + headroom;
    const span = (axisMax - axisMin) || 1;
    scales[metric] = {
      points,
      yFor: v => padT + (cfg.invertY ? (v - axisMin) / span : 1 - (v - axisMin) / span) * innerH
    };
  });

  // X-axis ticks: spread ~6 labeled gridlines across the range
  const tickCount = Math.min(n, 6);
  const tickEvery = Math.max(1, Math.round((n - 1) / Math.max(1, tickCount - 1)));
  const tickIndices = [];
  for (let i = 0; i < n; i += tickEvery) tickIndices.push(i);
  if (tickIndices[tickIndices.length - 1] !== n - 1) tickIndices.push(n - 1);

  // Long ranges (12/16 months) span multiple years, so include the year in date labels
  const showYear = n > 90;

  let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`;

  // Horizontal gridlines (visual rhythm only — not tied to a single metric's scale)
  [0, 0.5, 1].forEach(t => {
    const y = padT + t * innerH;
    svg += `<line class="gsc-chart-gridline" x1="${padL}" y1="${y.toFixed(1)}" x2="${(width-padR).toFixed(1)}" y2="${y.toFixed(1)}" />`;
  });

  // Vertical gridlines + date labels
  tickIndices.forEach(i => {
    const x = xFor(i);
    svg += `<line class="gsc-chart-gridline gsc-chart-gridline--v" x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT+innerH).toFixed(1)}" />`;
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    svg += `<text class="gsc-chart-axis-label" x="${x.toFixed(1)}" y="${height-3}" text-anchor="${anchor}">${escapeHtml(formatDateShort(filled[i].date, showYear))}</text>`;
  });

  // Metric lines (position is split into segments to skip no-impression days)
  Object.keys(GSC_METRICS).forEach(metric => {
    if (!activeMetrics[metric] || !scales[metric]) return;
    const { points, yFor } = scales[metric];
    const segments = [];
    let current = [];
    let prevI = null;
    points.forEach(p => {
      if (prevI !== null && p.i !== prevI + 1) { segments.push(current); current = []; }
      current.push(p);
      prevI = p.i;
    });
    if (current.length) segments.push(current);
    segments.forEach(seg => {
      const linePoints = seg.map(p => `${xFor(p.i).toFixed(1)},${yFor(p.value).toFixed(1)}`).join(' ');
      svg += `<polyline class="gsc-chart-line" data-metric="${metric}" points="${linePoints}" />`;
    });
  });

  // Hover line + per-metric dots, hidden until pointermove
  svg += `<line class="gsc-chart-hoverline" id="gsc-chart-hoverline" x1="${padL}" y1="${padT}" x2="${padL}" y2="${(padT+innerH).toFixed(1)}" style="display:none" />`;
  Object.keys(GSC_METRICS).forEach(metric => {
    svg += `<circle class="gsc-chart-hoverdot" id="gsc-chart-hoverdot-${metric}" data-metric="${metric}" r="2.5" style="display:none" />`;
  });

  // Tooltip group, populated on hover
  svg += `<g id="gsc-chart-tooltip" class="gsc-chart-tooltip" style="display:none"></g>`;

  // Transparent overlay to capture pointer events across the full plot area
  svg += `<rect class="gsc-chart-overlay" id="gsc-chart-overlay" x="${padL}" y="0" width="${innerW}" height="${height}" />`;

  svg += `</svg>`;

  return { svg, scales, xFor, dims: { padL, padT, innerW, innerH, width, height, n } };
}

function attachChartHover(svgEl, filled, activeMetrics, built) {
  const { scales, xFor, dims } = built;
  const { padL, padT, innerW, innerH, width, n } = dims;
  const overlay   = svgEl.querySelector('#gsc-chart-overlay');
  const hoverLine = svgEl.querySelector('#gsc-chart-hoverline');
  const tooltip   = svgEl.querySelector('#gsc-chart-tooltip');
  const stepX = innerW / (n - 1 || 1);
  const showYear = n > 90;

  overlay.addEventListener('pointermove', e => {
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const idx = Math.max(0, Math.min(n - 1, Math.round((svgPt.x - padL) / stepX)));

    const x = xFor(idx);
    hoverLine.setAttribute('x1', x.toFixed(1));
    hoverLine.setAttribute('x2', x.toFixed(1));
    hoverLine.style.display = '';

    const rows = [];
    Object.keys(GSC_METRICS).forEach(metric => {
      const dot = svgEl.querySelector(`#gsc-chart-hoverdot-${metric}`);
      if (!activeMetrics[metric] || !scales[metric]) { dot.style.display = 'none'; return; }
      const cfg = GSC_METRICS[metric];
      const point = scales[metric].points.find(p => p.i === idx);
      if (point) {
        dot.setAttribute('cx', x.toFixed(1));
        dot.setAttribute('cy', scales[metric].yFor(point.value).toFixed(1));
        dot.style.display = '';
        rows.push({ metric, label: cfg.label, value: cfg.format(point.value) });
      } else {
        dot.style.display = 'none';
        rows.push({ metric, label: cfg.label, value: '—' });
      }
    });

    const rowH = 12;
    const tw = showYear ? 112 : 96;
    const th = 14 + rows.length * rowH + 5;
    let tx = x + 6;
    if (tx + tw > width) tx = x - tw - 6;
    if (tx < 0) tx = 0;

    let html = `<rect class="gsc-tooltip-bg" x="0" y="0" width="${tw}" height="${th}" rx="3" />`;
    html += `<text class="gsc-tooltip-date" x="6" y="13">${escapeHtml(formatDateLong(filled[idx].date, showYear))}</text>`;
    rows.forEach((r, i) => {
      const rowY = 13 + (i + 1) * rowH;
      html += `<circle class="gsc-tooltip-dot" data-metric="${r.metric}" cx="9" cy="${(rowY-3.5).toFixed(1)}" r="3" />`;
      html += `<text class="gsc-tooltip-text" x="16" y="${rowY}">${escapeHtml(r.label)}: ${escapeHtml(r.value)}</text>`;
    });
    tooltip.innerHTML = html;
    tooltip.setAttribute('transform', `translate(${tx.toFixed(1)},${padT})`);
    tooltip.style.display = '';
  });

  overlay.addEventListener('pointerleave', () => {
    hoverLine.style.display = 'none';
    Object.keys(GSC_METRICS).forEach(metric => {
      svgEl.querySelector(`#gsc-chart-hoverdot-${metric}`).style.display = 'none';
    });
    tooltip.style.display = 'none';
  });
}

function renderGscChange(elId, current, previous, { lowerIsBetter = false } = {}) {
  const el = document.getElementById(elId);
  if (!previous) { el.textContent = current ? 'New' : ''; el.className = 'gsc-chart-change'; return; }
  const pct = ((current - previous) / previous) * 100;
  const improved = lowerIsBetter ? pct < 0 : pct > 0;
  const arrow = pct >= 0 ? '▲' : '▼';
  el.textContent = `${arrow} ${Math.abs(pct).toFixed(0)}%`;
  el.className = `gsc-chart-change ${pct === 0 ? '' : improved ? 'gsc-chart-change--up' : 'gsc-chart-change--down'}`;
}

function gscFillTimeseries(timeseries, range) {
  const map = new Map(timeseries.map(d => [d.date, d]));
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const result = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    result.push(map.get(dateStr) || { date: dateStr, clicks: 0, impressions: 0, ctr: 0, position: 0 });
  }
  return result;
}

function renderCombinedChart() {
  const container = document.getElementById('gsc-chart-combined');
  if (!_gscFilled.length) { container.innerHTML = ''; return; }
  // viewBox width = container's actual pixel width, so the SVG renders at a
  // 1:1 user-unit-to-pixel scale and font/line sizes stay constant as the
  // popup or sidebar is resized (instead of stretching with the SVG).
  const width = container.clientWidth || 320;
  const built = buildCombinedChart(_gscFilled, gscActiveMetrics, { width });
  container.innerHTML = built.svg;
  attachChartHover(container.querySelector('svg'), _gscFilled, gscActiveMetrics, built);
}

// Re-render the chart whenever its container is resized (e.g. the sidebar
// being widened/narrowed), so the 1:1 scale above stays accurate.
let _gscChartResizeRAF = null;
new ResizeObserver(() => {
  if (_gscChartResizeRAF) return;
  _gscChartResizeRAF = requestAnimationFrame(() => {
    _gscChartResizeRAF = null;
    renderCombinedChart();
  });
}).observe(document.getElementById('gsc-chart-combined'));

function renderGscCharts(timeseries, totals, previousTotals, range) {
  _gscFilled = gscFillTimeseries(timeseries, range);

  document.getElementById('gsc-total-clicks').textContent = totals.clicks.toLocaleString();
  document.getElementById('gsc-total-impressions').textContent = totals.impressions.toLocaleString();
  document.getElementById('gsc-total-position').textContent = totals.position ? totals.position.toFixed(1) : '—';

  renderGscChange('gsc-change-clicks', totals.clicks, previousTotals.clicks);
  renderGscChange('gsc-change-impressions', totals.impressions, previousTotals.impressions);
  renderGscChange('gsc-change-position', totals.position, previousTotals.position, { lowerIsBetter: true });

  renderCombinedChart();
}

// ─── Google Search Console: queries table ────────────────────────────────────

function isQueryBranded(query, pattern) {
  if (!pattern) return false;
  try { return new RegExp(pattern, 'i').test(query); } catch { return false; }
}

// Returns chip labels (Title, Desc, H1-H5) for places the query exactly appears on the page
function gscQueryLocations(query, data) {
  if (!data || !query) return [];
  const norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const q = norm(query);
  if (!q) return [];

  const locations = [];
  if (data.title?.text && norm(data.title.text).includes(q)) locations.push('Title');
  if (data.metaDescription?.text && norm(data.metaDescription.text).includes(q)) locations.push('Desc');
  ['h1', 'h2', 'h3', 'h4', 'h5'].forEach(tag => {
    const inHeading = (data.headings || []).some(h => h.tag === tag && norm(h.text).includes(q));
    if (inHeading) locations.push(tag.toUpperCase());
  });
  return locations;
}

function sortGscQueries(queries, sort) {
  const sorted = [...queries];
  sorted.sort((a, b) => {
    const diff = a[sort.column] - b[sort.column];
    return sort.direction === 'asc' ? diff : -diff;
  });
  return sorted;
}

function buildQueryHeaderRow(sort) {
  const row = document.createElement('div');
  row.className = 'gsc-query-row gsc-query-row--header';

  let html = '<div class="gsc-query-main"><span>Query</span>';
  GSC_QUERY_COLUMNS.forEach(col => {
    const active = sort.column === col.key;
    const arrow = active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
    html += `<span class="gsc-query-sort${active ? ' gsc-query-sort--active' : ''}" data-sort="${col.key}">${escapeHtml(col.label)}${arrow}</span>`;
  });
  html += '</div>';
  row.innerHTML = html;
  return row;
}

function buildQueryDataRow(q, locations, branded, selected) {
  const row = document.createElement('div');
  row.className = 'gsc-query-row gsc-query-row--clickable'
    + (branded ? ' gsc-query-row--branded' : '')
    + (selected ? ' gsc-query-row--selected' : '');
  row.dataset.query = q.query;

  let chips = branded ? '<span class="gsc-branded-pill">Brand</span>' : '';
  chips += locations.map(l => `<span class="gsc-chip">${escapeHtml(l)}</span>`).join('');

  let html = '<div class="gsc-query-main">';
  html += '<span class="gsc-query-text-wrap">';
  html += `<span class="gsc-query-text" title="${escapeHtml(q.query)}">${escapeHtml(q.query)}</span>`;
  if (chips) html += `<span class="gsc-query-chips">${chips}</span>`;
  html += '</span>';
  GSC_QUERY_COLUMNS.forEach(col => {
    html += `<span class="gsc-query-num">${escapeHtml(col.format(q[col.key]))}</span>`;
  });
  html += '</div>';

  row.innerHTML = html;

  row.querySelector('.gsc-query-text').addEventListener('click', (e) => {
    e.stopPropagation();
    browser.tabs.create({ url: 'https://www.google.com/search?q=' + encodeURIComponent(q.query) });
  });

  return row;
}

function renderGscQueries(queries, pageUrl) {
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  const pattern = allBrandedTerms[host] || '';
  const container = document.getElementById('gsc-queries-table');
  container.innerHTML = '';

  if (!queries.length) {
    document.getElementById('gsc-queries-empty').classList.remove('hidden');
    return;
  }

  const headerRow = buildQueryHeaderRow(gscQuerySort);
  container.appendChild(headerRow);
  headerRow.querySelectorAll('.gsc-query-sort').forEach(el => {
    el.addEventListener('click', () => {
      const column = el.dataset.sort;
      gscQuerySort = gscQuerySort.column === column
        ? { column, direction: gscQuerySort.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: GSC_QUERY_SORT_DEFAULT_DIR[column] };
      browser.storage.local.set({ gscQuerySort });
      renderGscQueries(_gscQueries, _gscPageUrl);
    });
  });

  const sorted = sortGscQueries(queries, gscQuerySort);
  let shown = 0;
  sorted.forEach(q => {
    const branded = isQueryBranded(q.query, pattern);
    if (gscHideBranded && branded) return;
    shown++;
    const locations = gscQueryLocations(q.query, pageData);
    const row = buildQueryDataRow(q, locations, branded, q.query === _gscSelectedQuery);
    row.addEventListener('click', () => selectGscQuery(q.query));
    container.appendChild(row);
  });
  document.getElementById('gsc-queries-empty').classList.toggle('hidden', shown > 0);
}

// ─── Google Search Console: click-to-filter chart by query ──────────────────

function showGscQueryFilterBar(query) {
  document.getElementById('gsc-query-filter-text').textContent = query;
  document.getElementById('gsc-query-filter-bar').classList.remove('hidden');
}

function hideGscQueryFilterBar() {
  document.getElementById('gsc-query-filter-bar').classList.add('hidden');
}

async function applyGscQueryFilter(query) {
  showGscQueryFilterBar(query);
  const response = await browser.runtime.sendMessage({ action: 'gscGetQueryData', pageUrl: _gscPageUrl, range: gscSelectedRange, query });
  if (_gscSelectedQuery !== query) return;
  if (!response.connected || response.error) return;
  renderGscCharts(response.timeseries, response.totals, response.previousTotals, gscSelectedRange);
}

function selectGscQuery(query) {
  if (_gscSelectedQuery === query) {
    _gscSelectedQuery = null;
    hideGscQueryFilterBar();
    renderGscQueries(_gscQueries, _gscPageUrl);
    if (_gscOverviewData) renderGscCharts(_gscOverviewData.timeseries, _gscOverviewData.totals, _gscOverviewData.previousTotals, gscSelectedRange);
    return;
  }
  _gscSelectedQuery = query;
  renderGscQueries(_gscQueries, _gscPageUrl);
  applyGscQueryFilter(query);
}

// ─── Google Search Console: indexing status ──────────────────────────────────

function renderGscInspection(inspection, error) {
  const list = document.getElementById('gsc-inspection-list');
  list.innerHTML = '';

  if (!inspection) {
    appendIndexRow(list, 'warning', error ? `Could not check indexing status (${error})` : 'Indexing status unavailable');
    return;
  }

  const { verdict, coverageState, indexingState, lastCrawlTime, googleCanonical, userCanonical } = inspection;

  let level = 'ok';
  if (verdict === 'FAIL') level = 'error';
  else if (verdict !== 'PASS') level = 'warning';
  appendIndexRow(list, level, coverageState || 'Unknown coverage status');

  if (lastCrawlTime) {
    appendIndexRow(list, 'ok', `Last crawled ${formatDate(lastCrawlTime)}`);
  } else {
    appendIndexRow(list, 'warning', 'Not yet crawled by Google');
  }

  if (googleCanonical && userCanonical && googleCanonical !== userCanonical) {
    appendIndexRow(list, 'warning', `Google's canonical: ${googleCanonical}`);
  }

  if (indexingState && indexingState !== 'INDEXING_ALLOWED') {
    appendIndexRow(list, 'error', `Indexing blocked: ${indexingState.replace(/_/g, ' ').toLowerCase()}`);
  }
}

// ─── Google Search Console: detail panel ─────────────────────────────────────

function setGscRangeUI(range) {
  document.querySelectorAll('#gsc-range-group .mode-option').forEach(btn => {
    btn.classList.toggle('is-active', parseInt(btn.dataset.range, 10) === range);
  });
}

function renderGscPanel(response, pageUrl) {
  const notConnected = document.getElementById('gsc-not-connected');
  const noProperty   = document.getElementById('gsc-no-property');
  const errorBox     = document.getElementById('gsc-error');
  const dataBox      = document.getElementById('gsc-data');

  notConnected.classList.add('hidden');
  noProperty.classList.add('hidden');
  errorBox.classList.add('hidden');
  dataBox.classList.add('hidden');

  if (!response.connected) {
    document.getElementById('gsc-not-connected-text').textContent = response.reauthRequired
      ? 'Your Google connection expired — reconnect Search Console in Settings.'
      : 'Connect Google Search Console in Settings to see performance data for this page.';
    notConnected.classList.remove('hidden');
    document.getElementById('gsc-inspection-list').innerHTML = '';
    return;
  }

  if (response.error === 'NO_PROPERTY') {
    let host = pageUrl;
    try { host = new URL(pageUrl).hostname; } catch { /* keep raw */ }
    document.getElementById('gsc-no-property-host').textContent = host;
    document.getElementById('gsc-no-property-detail').textContent = response.detail || '';
    noProperty.classList.remove('hidden');
    document.getElementById('gsc-inspection-list').innerHTML = '';
    return;
  }

  if (response.error) {
    document.getElementById('gsc-error-text').textContent = gscErrorMessage(response.error, response.detail);
    errorBox.classList.remove('hidden');
    document.getElementById('gsc-inspection-list').innerHTML = '';
    return;
  }

  _gscSiteUrl = response.siteUrl;
  _gscQueries = response.queries || [];
  _gscPageUrl = pageUrl;
  _gscOverviewData = response.overview;

  if (_gscSelectedQuery && !_gscQueries.some(q => q.query === _gscSelectedQuery)) {
    _gscSelectedQuery = null;
  }

  setGscRangeUI(gscSelectedRange);
  renderGscCharts(_gscOverviewData.timeseries, _gscOverviewData.totals, _gscOverviewData.previousTotals, gscSelectedRange);
  renderGscQueries(_gscQueries, pageUrl);
  renderGscInspection(response.inspection, response.inspectionError);

  if (_gscSelectedQuery) {
    applyGscQueryFilter(_gscSelectedQuery);
  } else {
    hideGscQueryFilterBar();
  }

  document.getElementById('gsc-fetched-meta').textContent =
    `Updated ${gscRelativeTime(response.fetchedAt)} · Recent days may be revised by Google`;

  dataBox.classList.remove('hidden');
}

async function loadGscData(forceRefresh = false) {
  const tab = await getActiveTab();
  let pageUrl = tab.url;
  try {
    const data = await browser.tabs.sendMessage(tab.id, { action: 'getPageData' });
    if (data?.canonical) pageUrl = data.canonical;
  } catch { /* fall back to tab.url */ }

  const response = await browser.runtime.sendMessage({ action: 'gscGetPageData', pageUrl, range: gscSelectedRange, forceRefresh });
  renderGscPanel(response, pageUrl);
}

document.getElementById('btn-gsc-goto-settings').addEventListener('click', () => showSettings());

document.getElementById('btn-gsc-open-external').addEventListener('click', () => {
  if (!_gscSiteUrl || !_gscPageUrl) return;
  browser.tabs.create({ url: 'https://search.google.com/search-console/inspect?resource_id=' + encodeURIComponent(_gscSiteUrl) + '&id=' + encodeURIComponent(_gscPageUrl) });
});

document.querySelectorAll('#gsc-range-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = parseInt(btn.dataset.range, 10);
    if (range === gscSelectedRange) return;
    gscSelectedRange = range;
    setGscRangeUI(range);
    browser.storage.local.set({ gscSelectedRange: range });
    loadGscData(false);
  });
});

document.getElementById('btn-gsc-branded-toggle').addEventListener('click', () => {
  gscHideBranded = !gscHideBranded;
  document.getElementById('btn-gsc-branded-toggle').setAttribute('aria-pressed', String(gscHideBranded));
  browser.storage.local.set({ gscHideBranded });
  if (_gscPageUrl) renderGscQueries(_gscQueries, _gscPageUrl);
});

document.getElementById('btn-gsc-clear-query-filter').addEventListener('click', () => {
  if (_gscSelectedQuery) selectGscQuery(_gscSelectedQuery);
});

document.querySelectorAll('.gsc-metric-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const metric = btn.dataset.metric;
    const next = !gscActiveMetrics[metric];
    if (!next && Object.values(gscActiveMetrics).filter(Boolean).length <= 1) return;
    gscActiveMetrics[metric] = next;
    btn.setAttribute('aria-pressed', String(next));
    browser.storage.local.set({ gscActiveMetrics });
    renderCombinedChart();
  });
});

// ─── Google Search Console: settings connection ──────────────────────────────

async function refreshGscSettingsStatus() {
  const status = await browser.runtime.sendMessage({ action: 'gscGetStatus' });
  document.getElementById('gsc-redirect-uri').value = status.redirectUri;

  const badge         = document.getElementById('gsc-status-badge');
  const setupForm     = document.getElementById('gsc-setup-form');
  const connectedInfo = document.getElementById('gsc-connected-info');

  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setupForm.classList.add('hidden');
    connectedInfo.classList.remove('hidden');
    document.getElementById('gsc-connected-since').textContent = status.connectedAt
      ? `Connected since ${formatDate(new Date(status.connectedAt))}`
      : '';
  } else {
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setupForm.classList.remove('hidden');
    connectedInfo.classList.add('hidden');
  }

  return status;
}

document.getElementById('btn-copy-redirect-uri').addEventListener('click', async (e) => {
  await copyToClipboard(document.getElementById('gsc-redirect-uri').value);
  flashCopyBtn(e.currentTarget);
});

document.getElementById('btn-gsc-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-gsc-connect');
  const errorEl = document.getElementById('gsc-connect-error');
  errorEl.classList.add('hidden');

  const clientId     = document.getElementById('gsc-client-id').value.trim();
  const clientSecret = document.getElementById('gsc-client-secret').value.trim();

  if (!clientId) {
    errorEl.textContent = gscConnectErrorMessage('NO_CLIENT_ID');
    errorEl.classList.remove('hidden');
    return;
  }

  await browser.storage.local.set({ gscClientId: clientId, gscClientSecret: clientSecret });

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const result = await browser.runtime.sendMessage({ action: 'gscConnect' });
    if (result.error) {
      if (result.error !== 'FLOW_CANCELLED') {
        errorEl.textContent = gscConnectErrorMessage(result.error);
        errorEl.classList.remove('hidden');
      }
    } else {
      await refreshGscSettingsStatus();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Google Search Console';
  }
});

document.getElementById('btn-gsc-disconnect').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ action: 'gscDisconnect' });
  await refreshGscSettingsStatus();
});

// ─── Google Search Console: preferences ──────────────────────────────────────

function loadGscPrefs() {
  return browser.storage.local.get(['gscSelectedRange', 'gscHideBranded', 'brandedTerms', 'gscActiveMetrics', 'gscQuerySort']).then(({ gscSelectedRange: storedRange, gscHideBranded: storedHide, brandedTerms, gscActiveMetrics: storedMetrics, gscQuerySort: storedSort }) => {
    gscSelectedRange = storedRange || 30;
    gscHideBranded = storedHide !== undefined ? storedHide : true;
    allBrandedTerms = brandedTerms ?? {};
    gscActiveMetrics = storedMetrics || { clicks: true, impressions: true, position: true };
    gscQuerySort = storedSort || { column: 'clicks', direction: 'desc' };
    setGscRangeUI(gscSelectedRange);
    document.getElementById('btn-gsc-branded-toggle').setAttribute('aria-pressed', String(gscHideBranded));
    document.querySelectorAll('.gsc-metric-toggle').forEach(btn => {
      btn.setAttribute('aria-pressed', String(gscActiveMetrics[btn.dataset.metric] !== false));
    });
  });
}
