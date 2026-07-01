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
let _gscQueriesExhausted = false;   // no more pages to request
let _gscFilled = [];
let _gscOverviewData = null;
let _gscSelectedQuery = null;

// Query-intent classification lives in popup-intent.js (shared with Ranking/Ads).
let _gscIntentFilter = null;       // null = All, else one of INTENTS
let _gscQuerySearch = '';          // regex string for query text filter
let _gscQuerySearchExclude = false; // false = match (include), true = exclude

// Chart metrics config. The chart helpers below are generic — popup-ga.js
// passes its own config of the same shape. Optional per-metric fields:
//   invertY    zero-at-top axis (lower is better, e.g. SERP position)
//   axisRight  prefer the right-hand Y axis when shown with other metrics
//   axisFormat tick label formatter (defaults to compact k/M)
//   getValue   accessor for a day's value (defaults to d[key]; null = skip day)
const GSC_METRICS = {
  impressions: { label: 'Impressions',  format: n => Math.round(n).toLocaleString() },
  clicks:      { label: 'Clicks',       format: n => Math.round(n).toLocaleString() },
  position:    {
    label: 'Avg Position',
    format: n => n.toFixed(1),
    invertY: true,
    axisRight: true,
    axisFormat: v => v.toFixed(1),
    getValue: d => (d.impressions > 0 ? d.position : null)
  }
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

// Compact axis labels: 12,345 → 12.3k, 1,200,000 → 1.2M (or cfg.axisFormat)
function chartAxisNum(v, cfg) {
  if (cfg && cfg.axisFormat) return cfg.axisFormat(v);
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(v).toString();
}

// Round up to a clean axis maximum: 1/2/5 × 10^n (e.g. 12.3 → 20, 4.2 → 5)
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function buildCombinedChart(filled, activeMetrics, { width = 320, height = 130, metrics = GSC_METRICS } = {}) {
  const padT = 10, padB = 16;
  const n = filled.length;

  // Active metrics in the config's declared order
  const order = Object.keys(metrics);
  const active = order.filter(m => activeMetrics[m]);

  // ── Axis placement ────────────────────────────────────────────────────────
  // Each metric is on its own scale, so each gets its own Y axis, balanced with
  // at most two axes per side:
  //   1 → L · 2 → 1L/1R · 3 → 2L/1R · 4 → 2L/2R
  let leftMetrics = [], rightMetrics = [];
  if (active.length <= 1) {
    leftMetrics = active.slice();
  } else {
    const leftCount = Math.min(2, Math.ceil(active.length / 2));
    leftMetrics = active.slice(0, leftCount);
    rightMetrics = active.slice(leftCount, leftCount + 2);
  }

  const AXIS_W = 26;
  const padL = leftMetrics.length ? leftMetrics.length * AXIS_W + 4 : 8;
  const padR = rightMetrics.length ? rightMetrics.length * AXIS_W + 6 : 8;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const xFor = i => padL + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);

  // ── Per-metric scales ───────────────────────────────────────────────────────
  // invertY metrics (e.g. position): 0 at the top (best), niceCeil(worst) at
  // the bottom — lower values sit higher, since lower is better. Counts:
  // zoomed to their own data range with a little top headroom.
  const scales = {};
  order.forEach(metric => {
    if (!activeMetrics[metric]) { scales[metric] = null; return; }
    const cfg = metrics[metric];
    const points = filled
      .map((d, i) => ({ i, value: cfg.getValue ? cfg.getValue(d) : d[metric] }))
      .filter(p => p.value !== null && p.value !== undefined);
    if (!points.length) { scales[metric] = null; return; }
    const values = points.map(p => p.value);
    const dataMin = Math.min(...values), dataMax = Math.max(...values);

    let yFor, ticks;
    if (cfg.invertY) {
      const axisMax = niceCeil(dataMax);
      const span = axisMax || 1;
      yFor = v => padT + (v / span) * innerH;                  // 0 → top
      ticks = [0, axisMax / 2, axisMax];
    } else {
      const headroom = ((dataMax - dataMin) || Math.abs(dataMax) || 1) * 0.1;
      const top = dataMax + headroom, bottom = dataMin;
      const span = (top - bottom) || 1;
      yFor = v => padT + (1 - (v - bottom) / span) * innerH;   // max → top
      ticks = [dataMax, (dataMax + dataMin) / 2, dataMin];
    }
    scales[metric] = { points, yFor, ticks };
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

  // Horizontal gridlines every 25% of the plot height (the mid tick sits on one)
  [0, 0.25, 0.5, 0.75, 1].forEach(t => {
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

  // ── Y-axis tick labels, per metric, on its assigned side ────────────────────
  function drawYAxis(metric, x, anchor) {
    const s = scales[metric];
    if (!s) return;
    s.ticks.forEach(value => {
      const y = Math.max(padT + 6, Math.min(padT + innerH, s.yFor(value)));
      svg += `<text class="gsc-chart-yaxis" data-metric="${metric}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle">${escapeHtml(chartAxisNum(value, metrics[metric]))}</text>`;
    });
  }
  // Left axes: inner one nearest the plot, extra one further out
  leftMetrics.forEach((metric, slot) => drawYAxis(metric, padL - 4 - slot * AXIS_W, 'end'));
  rightMetrics.forEach((metric, slot) => drawYAxis(metric, width - padR + 4 + slot * AXIS_W, 'start'));

  // Metric lines (a metric whose getValue returns null skips those days)
  order.forEach(metric => {
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
  order.forEach(metric => {
    svg += `<circle class="gsc-chart-hoverdot" id="gsc-chart-hoverdot-${metric}" data-metric="${metric}" r="2.5" style="display:none" />`;
  });

  // Tooltip group, populated on hover
  svg += `<g id="gsc-chart-tooltip" class="gsc-chart-tooltip" style="display:none"></g>`;

  // Transparent overlay to capture pointer events across the full plot area
  svg += `<rect class="gsc-chart-overlay" id="gsc-chart-overlay" x="${padL}" y="0" width="${innerW}" height="${height}" />`;

  svg += `</svg>`;

  return { svg, scales, xFor, metrics, dims: { padL, padT, innerW, innerH, width, height, n } };
}

function attachChartHover(svg, filled, activeMetrics, built) {
  const { scales, xFor, dims } = built;
  const metricsCfg = built.metrics || GSC_METRICS;
  const { padL, padT, innerW, innerH, width, n } = dims;
  const overlay   = svg.querySelector('#gsc-chart-overlay');
  const hoverLine = svg.querySelector('#gsc-chart-hoverline');
  const tooltip   = svg.querySelector('#gsc-chart-tooltip');
  const stepX = innerW / (n - 1 || 1);
  const showYear = n > 90;

  overlay.addEventListener('pointermove', e => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const idx = Math.max(0, Math.min(n - 1, Math.round((svgPt.x - padL) / stepX)));

    const x = xFor(idx);
    hoverLine.setAttribute('x1', x.toFixed(1));
    hoverLine.setAttribute('x2', x.toFixed(1));
    hoverLine.style.display = '';

    const rows = [];
    Object.keys(metricsCfg).forEach(metric => {
      const dot = svg.querySelector(`#gsc-chart-hoverdot-${metric}`);
      if (!activeMetrics[metric] || !scales[metric]) { dot.style.display = 'none'; return; }
      const cfg = metricsCfg[metric];
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

    tooltip.replaceChildren();
    tooltip.appendChild(svgEl('rect', { class: 'gsc-tooltip-bg', x: 0, y: 0, width: tw, height: th, rx: 3 }));
    tooltip.appendChild(svgEl('text', { class: 'gsc-tooltip-date', x: 6, y: 13 }, formatDateLong(filled[idx].date, showYear)));
    rows.forEach((r, i) => {
      const rowY = 13 + (i + 1) * rowH;
      tooltip.appendChild(svgEl('circle', { class: 'gsc-tooltip-dot', 'data-metric': r.metric, cx: 9, cy: (rowY - 3.5).toFixed(1), r: 3 }));
      tooltip.appendChild(svgEl('text', { class: 'gsc-tooltip-text', x: 16, y: rowY }, `${r.label}: ${r.value}`));
    });
    tooltip.setAttribute('transform', `translate(${tx.toFixed(1)},${padT})`);
    tooltip.style.display = '';
  });

  overlay.addEventListener('pointerleave', () => {
    hoverLine.style.display = 'none';
    Object.keys(metricsCfg).forEach(metric => {
      svg.querySelector(`#gsc-chart-hoverdot-${metric}`).style.display = 'none';
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

// lagDays: how far behind "today" the data source runs (GSC ~3 days, GA ~1).
// emptyDay: factory for a zero-filled day (defaults to the GSC shape).
function gscFillTimeseries(timeseries, range, lagDays = 3, emptyDay = null) {
  const map = new Map(timeseries.map(d => [d.date, d]));
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - lagDays);
  const result = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    result.push(map.get(dateStr) || (emptyDay
      ? { date: dateStr, ...emptyDay() }
      : { date: dateStr, clicks: 0, impressions: 0, ctr: 0, position: 0 }));
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
  container.replaceChildren(svgFromString(built.svg));
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

  const main = document.createElement('div');
  main.className = 'gsc-query-main';
  main.appendChild(document.createElement('span'));   // empty cell over the + button column
  const qh = document.createElement('span');
  qh.textContent = 'Query';
  main.appendChild(qh);

  GSC_QUERY_COLUMNS.forEach(col => {
    const active = sort.column === col.key;
    const arrow = active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
    const span = document.createElement('span');
    span.className = `gsc-query-sort${active ? ' gsc-query-sort--active' : ''}`;
    span.dataset.sort = col.key;
    span.textContent = `${col.label}${arrow}`;
    main.appendChild(span);
  });

  row.appendChild(main);
  return row;
}

function buildQueryDataRow(q, locations, branded, selected) {
  const row = document.createElement('div');
  row.className = 'gsc-query-row gsc-query-row--clickable'
    + (branded ? ' gsc-query-row--branded' : '')
    + (selected ? ' gsc-query-row--selected' : '');
  row.dataset.query = q.query;

  const main = document.createElement('div');
  main.className = 'gsc-query-main';

  // Add-to-branded button (left of the query). Already-branded terms show no
  // button — just an empty cell to keep the grid aligned.
  if (branded) {
    main.appendChild(document.createElement('span'));
  } else {
    const addBtn = document.createElement('button');
    addBtn.className = 'gsc-query-add';
    addBtn.title = 'Mark as brand';
    addBtn.setAttribute('aria-label', 'Mark as brand');
    addBtn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.4"/><line x1="8" y1="5.2" x2="8" y2="10.8"/><line x1="5.2" y1="8" x2="10.8" y2="8"/></svg>'));
    main.appendChild(addBtn);
  }

  const wrap = document.createElement('span');
  wrap.className = 'gsc-query-text-wrap';
  const textEl = document.createElement('span');
  textEl.className = 'gsc-query-text';
  textEl.title = q.query;
  textEl.textContent = q.query;
  wrap.appendChild(textEl);

  // Track chip, immediately after the query word. Already-tracked terms show a
  // static "Tracked" pill (always visible); the rest show "+ Track" on hover.
  const tracked = typeof webceoIsTracked === 'function' && webceoIsTracked(q.query);
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
    trackChip.addEventListener('click', (e) => {
      e.stopPropagation();
      const intent = typeof intentOf === 'function' ? intentOf(q.query) : null;
      if (typeof trackQueryInWebceo === 'function') trackQueryInWebceo(q.query, trackChip, intent);
    });
  }
  wrap.appendChild(trackChip);

  // Right-aligned chips: Brand / Title / Desc / H1–H5, plus an "Ad" chip when
  // we're bidding on this query in Google Ads.
  const bidding = typeof adsIsBidKeyword === 'function' && adsIsBidKeyword(q.query);
  if (branded || locations.length || bidding) {
    const chipsEl = document.createElement('span');
    chipsEl.className = 'gsc-query-chips';
    if (branded) {
      const pill = document.createElement('span');
      pill.className = 'gsc-branded-pill';
      pill.textContent = 'Brand';
      chipsEl.appendChild(pill);
    }
    if (bidding) {
      const ad = document.createElement('span');
      ad.className = 'gsc-chip gsc-ad-chip';
      ad.textContent = 'Ad';
      ad.title = 'You are bidding on this query in Google Ads';
      chipsEl.appendChild(ad);
    }
    locations.forEach(l => {
      const chip = document.createElement('span');
      chip.className = 'gsc-chip';
      chip.textContent = l;
      chipsEl.appendChild(chip);
    });
    wrap.appendChild(chipsEl);
  }

  main.appendChild(wrap);

  GSC_QUERY_COLUMNS.forEach(col => {
    const num = document.createElement('span');
    num.className = 'gsc-query-num';
    num.textContent = col.format(q[col.key]);
    main.appendChild(num);
  });

  row.appendChild(main);

  row.querySelector('.gsc-query-text').addEventListener('click', (e) => {
    e.stopPropagation();
    browser.tabs.create({ url: 'https://www.google.com/search?q=' + encodeURIComponent(q.query) });
  });

  const addBtn = row.querySelector('.gsc-query-add');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addQueryToBranded(q.query);
    });
  }

  return row;
}

// Escape regex metacharacters so a literal query can be added to a branded pattern
function gscEscapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Append a query term to the current domain's branded-terms regex
function addQueryToBranded(query) {
  let host = '';
  try { host = new URL(_gscPageUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { return; }
  if (!host) return;

  const term = query.trim();
  if (!term) return;

  const existing = allBrandedTerms[host] || '';
  if (existing && isQueryBranded(term, existing)) return;   // already covered

  allBrandedTerms[host] = existing ? `${existing}|${gscEscapeRegex(term)}` : gscEscapeRegex(term);
  browser.storage.local.set({ brandedTerms: allBrandedTerms }).then(() => {
    renderGscQueries(_gscQueries, _gscPageUrl);
    if (typeof renderBrandDomains === 'function') renderBrandDomains();
    // Newly branded query drops out of the table — backfill to keep ~25 visible,
    // and (if hiding branded) take it out of the chart too.
    topUpGscQueries(25);
    refreshGscChartForBranded();
  });
}

// Branded regex for the current page's domain
function gscBrandedPattern() {
  let host = '';
  try { host = new URL(_gscPageUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
  return allBrandedTerms[host] || '';
}

// Count queries that would be visible right now (respecting Hide branded)
function gscVisibleCount() {
  const pattern = gscBrandedPattern();
  return _gscQueries.filter(q => !(gscHideBranded && isQueryBranded(q.query, pattern))).length;
}

// Fetch the next page of queries and append (dedup by query); returns # added
async function fetchMoreGscQueries() {
  if (_gscQueriesExhausted || !_gscPageUrl) return 0;
  const res = await sendMessageWithTimeout({
    action: 'gscGetMoreQueries', pageUrl: _gscPageUrl, range: gscSelectedRange, startRow: _gscQueries.length
  });
  if (!res || !res.connected || res.error) return 0;
  const batch = res.queries || [];
  const seen = new Set(_gscQueries.map(q => q.query));
  const added = batch.filter(q => !seen.has(q.query));
  _gscQueries = _gscQueries.concat(added);
  if (batch.length < 50) _gscQueriesExhausted = true;
  return added.length;
}

// Pull more pages until `target` non-branded queries are visible (used after a
// branded term is added so the table doesn't shrink)
async function topUpGscQueries(target = 25) {
  let guard = 0;
  while (gscVisibleCount() < target && !_gscQueriesExhausted && guard < 12) {
    const added = await fetchMoreGscQueries();
    guard++;
    if (!added) break;
  }
  renderGscQueries(_gscQueries, _gscPageUrl);
}

// Repaint the chart with branded queries excluded when Hide branded is on
// (a specific query filter, if active, owns the chart instead)
async function refreshGscChartForBranded() {
  if (_gscSelectedQuery) return;
  const pattern = gscBrandedPattern();
  if (gscHideBranded && pattern) {
    const res = await sendMessageWithTimeout({
      action: 'gscGetChartData', pageUrl: _gscPageUrl, range: gscSelectedRange, excludeRegex: pattern
    });
    if (res && res.connected && !res.error) {
      renderGscCharts(res.timeseries, res.totals, res.previousTotals, gscSelectedRange);
    }
  } else if (_gscOverviewData) {
    renderGscCharts(_gscOverviewData.timeseries, _gscOverviewData.totals, _gscOverviewData.previousTotals, gscSelectedRange);
  }
}

function renderGscQueries(queries, pageUrl) {
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  const pattern = allBrandedTerms[host] || '';
  const container = document.getElementById('gsc-queries-table');
  const moreBtn = document.getElementById('btn-gsc-more-queries');
  container.innerHTML = '';

  if (!queries.length) {
    document.getElementById('gsc-queries-empty').classList.remove('hidden');
    document.getElementById('gsc-intent-filters').classList.add('hidden');
    moreBtn.classList.add('hidden');
    return;
  }
  // "Request more" shows whenever the property may have more queries to page in
  moreBtn.classList.toggle('hidden', _gscQueriesExhausted);

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
  // Branded filter first
  let visible = sorted.filter(q => !(gscHideBranded && isQueryBranded(q.query, pattern)));
  // Regex text search filter — applied before intent chip counting so counts reflect the filtered set
  if (_gscQuerySearch) {
    try {
      const re = new RegExp(_gscQuerySearch, 'i');
      visible = _gscQuerySearchExclude
        ? visible.filter(q => !re.test(q.query))
        : visible.filter(q =>  re.test(q.query));
    } catch { /* invalid regex — leave visible unchanged */ }
  }
  renderIntentChips(document.getElementById('gsc-intent-filters'), visible, q => q.query, _gscIntentFilter, (intent) => {
    _gscIntentFilter = intent;
    _gscSelectedQuery = null;                 // intent change supersedes a single-query selection
    renderGscQueries(_gscQueries, _gscPageUrl);
    refreshGscChartForState();
  });

  let shown = 0;
  visible.forEach(q => {
    if (_gscIntentFilter && intentOf(q.query) !== _gscIntentFilter) return;
    shown++;
    const locations = gscQueryLocations(q.query, pageData);
    const row = buildQueryDataRow(q, locations, isQueryBranded(q.query, pattern), q.query === _gscSelectedQuery);
    row.addEventListener('click', () => selectGscQuery(q.query));
    container.appendChild(row);
  });
  document.getElementById('gsc-queries-empty').classList.toggle('hidden', shown > 0);

  // Cross-tab chips load lazily, then re-render once: Web CEO "Tracked" + Ads "Ad"
  if (typeof ensureWebceoTracked === 'function') ensureWebceoTracked(() => renderGscQueries(queries, pageUrl));
  if (typeof ensureAdsKeywordSet === 'function') ensureAdsKeywordSet(() => renderGscQueries(queries, pageUrl));
  // Intent classification (Haiku, shared cache): re-renders once when ready
  ensureIntents(queries.map(q => q.query), () => renderGscQueries(_gscQueries, _gscPageUrl));
}

// ─── Google Search Console: click-to-filter chart by query ──────────────────

function showGscFilterBar(kind, value) {
  const bar = document.getElementById('gsc-query-filter-bar');
  const label = bar.querySelector('.gsc-query-filter-label');
  if (label) label.textContent = kind === 'intent' ? 'Filtered to intent:' : 'Filtered to query:';
  document.getElementById('gsc-query-filter-text').textContent = value;
  bar.classList.remove('hidden');
}

function showGscQueryFilterBar(query) { showGscFilterBar('query', query); }

function hideGscQueryFilterBar() {
  document.getElementById('gsc-query-filter-bar').classList.add('hidden');
}

async function applyGscQueryFilter(query) {
  showGscQueryFilterBar(query);
  const response = await sendMessageWithTimeout({ action: 'gscGetQueryData', pageUrl: _gscPageUrl, range: gscSelectedRange, query });
  if (_gscSelectedQuery !== query) return;
  if (!response.connected || response.error) return;
  renderGscCharts(response.timeseries, response.totals, response.previousTotals, gscSelectedRange);
}

// Chart for an intent: aggregate the visible (branded-filtered) queries of that
// intent via one GSC call, then render. The set is always ≥1 (zero chips disabled).
async function applyGscIntentChartFilter(intent) {
  showGscFilterBar('intent', intent);
  const pattern = gscBrandedPattern();
  const list = _gscQueries
    .filter(q => !(gscHideBranded && isQueryBranded(q.query, pattern)))
    .filter(q => intentOf(q.query) === intent)
    .map(q => q.query);
  if (!list.length) return;
  const res = await sendMessageWithTimeout({ action: 'gscGetQueriesData', pageUrl: _gscPageUrl, range: gscSelectedRange, queries: list });
  // Bail if the user moved on (cleared the intent or picked a single query) mid-fetch
  if (_gscIntentFilter !== intent || _gscSelectedQuery) return;
  if (!res || !res.connected || res.error) return;
  renderGscCharts(res.timeseries, res.totals, res.previousTotals, gscSelectedRange);
}

// Single source of truth for what the top chart should show, by current state:
// a selected query > an active intent filter > the page overview (branded-aware).
function refreshGscChartForState() {
  if (_gscSelectedQuery) { applyGscQueryFilter(_gscSelectedQuery); return; }
  if (_gscIntentFilter) { applyGscIntentChartFilter(_gscIntentFilter); return; }
  hideGscQueryFilterBar();
  refreshGscChartForBranded();
}

function selectGscQuery(query) {
  if (_gscSelectedQuery === query) {
    _gscSelectedQuery = null;
    renderGscQueries(_gscQueries, _gscPageUrl);
    // Restore the chart: intent chart if a filter is active, else overview
    refreshGscChartForState();
    return;
  }
  _gscSelectedQuery = query;
  renderGscQueries(_gscQueries, _gscPageUrl);
  applyGscQueryFilter(query);
}

// ─── Google Search Console: indexing status ──────────────────────────────────

const GSC_CRAWL_FRESH_MS = 30 * 24 * 60 * 60 * 1000;

// Discovery section (Overview): the sitemaps this URL appears in and a page
// Google followed a link from, per Search Console's URL Inspection.
function fillDiscoveryList(listId, groupId, urls) {
  const list = document.getElementById(listId);
  list.replaceChildren();
  document.getElementById(groupId).classList.toggle('hidden', !urls.length);
  urls.forEach(u => {
    const row = document.createElement('span');
    row.className = 'gsc-discovery-url';
    row.textContent = u;
    row.title = u;
    row.addEventListener('click', () => browser.tabs.create({ url: u }));
    list.appendChild(row);
  });
}

function renderGscDiscovery(inspection) {
  const section   = document.getElementById('gsc-discovery');
  const sitemaps  = (inspection && inspection.sitemaps) || [];
  const referrers = (inspection && inspection.referringUrls) || [];

  if (!sitemaps.length && !referrers.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  fillDiscoveryList('gsc-discovery-sitemaps', 'gsc-discovery-sitemaps-group', sitemaps);
  fillDiscoveryList('gsc-discovery-referrers', 'gsc-discovery-referrers-group', referrers);
}

function renderGscInspection(inspection) {
  renderGscDiscovery(inspection);

  if (!inspection) {
    _idxGsc = null;
    renderIndexabilitySection();
    return;
  }

  const { verdict, coverageState, indexingState, lastCrawlTime } = inspection;

  // Coverage segment for row 1: short "Indexed" when Google passes, otherwise
  // the more descriptive coverage state (or a blocked-indexing message).
  const blocked = indexingState && indexingState !== 'INDEXING_ALLOWED';
  let coverageLevel = 'ok';
  if (verdict === 'FAIL' || blocked) coverageLevel = 'error';
  else if (verdict !== 'PASS') coverageLevel = 'warning';

  const coverageText = blocked
    ? `Indexing blocked: ${indexingState.replace(/_/g, ' ').toLowerCase()}`
    : (verdict === 'PASS' ? 'Indexed' : (coverageState || 'Not indexed'));

  // Crawl segment for row 2: green within 30 days, amber otherwise
  let crawl;
  if (lastCrawlTime) {
    const fresh = (Date.now() - new Date(lastCrawlTime).getTime()) <= GSC_CRAWL_FRESH_MS;
    crawl = { level: fresh ? 'ok' : 'warning', text: `Last crawled ${formatDate(lastCrawlTime)}` };
  } else {
    crawl = { level: 'warning', text: 'Not yet crawled by Google' };
  }

  _idxGsc = { coverage: { level: coverageLevel, text: coverageText }, crawl };
  renderIndexabilitySection();
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
    renderGscInspection(null);
    return;
  }

  if (response.error === 'NO_PROPERTY') {
    let host = pageUrl;
    try { host = new URL(pageUrl).hostname; } catch { /* keep raw */ }
    document.getElementById('gsc-no-property-host').textContent = host;
    document.getElementById('gsc-no-property-detail').textContent = response.detail || '';
    noProperty.classList.remove('hidden');
    renderGscInspection(null);
    return;
  }

  if (response.error) {
    document.getElementById('gsc-error-text').textContent = gscErrorMessage(response.error, response.detail);
    errorBox.classList.remove('hidden');
    renderGscInspection(null);
    return;
  }

  _gscSiteUrl = response.siteUrl;
  _gscQueries = response.queries || [];
  _gscQueriesExhausted = _gscQueries.length < 25;   // first page is 25
  if (_gscPageUrl !== pageUrl) _gscIntentFilter = null;   // new page → reset intent filter
  _gscPageUrl = pageUrl;
  _gscOverviewData = response.overview;

  if (_gscSelectedQuery && !_gscQueries.some(q => q.query === _gscSelectedQuery)) {
    _gscSelectedQuery = null;
  }

  setGscRangeUI(gscSelectedRange);
  renderGscCharts(_gscOverviewData.timeseries, _gscOverviewData.totals, _gscOverviewData.previousTotals, gscSelectedRange);
  renderGscQueries(_gscQueries, pageUrl);
  renderGscInspection(response.inspection);

  if (_gscSelectedQuery) {
    applyGscQueryFilter(_gscSelectedQuery);
  } else if (_gscIntentFilter) {
    // Intent persists across range changes; classifications are cached for the page
    refreshGscChartForState();
    if (gscHideBranded && gscBrandedPattern()) topUpGscQueries(25);
  } else {
    hideGscQueryFilterBar();
    // Honor a persisted Hide-branded: drop branded from the chart + backfill table
    if (gscHideBranded && gscBrandedPattern()) {
      refreshGscChartForBranded();
      topUpGscQueries(25);
    }
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

  const response = await sendMessageWithTimeout({ action: 'gscGetPageData', pageUrl, range: gscSelectedRange, forceRefresh });
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

function isValidRegex(s) { try { new RegExp(s); return true; } catch { return false; } }

document.getElementById('gsc-query-search').addEventListener('input', e => {
  _gscQuerySearch = e.target.value;
  e.target.classList.toggle('is-invalid', !!_gscQuerySearch && !isValidRegex(_gscQuerySearch));
  renderGscQueries(_gscQueries, _gscPageUrl);
});
document.getElementById('btn-gsc-query-search-mode').addEventListener('click', () => {
  _gscQuerySearchExclude = !_gscQuerySearchExclude;
  document.getElementById('btn-gsc-query-search-mode').textContent =
    _gscQuerySearchExclude ? 'Excl.' : 'Match';
  renderGscQueries(_gscQueries, _gscPageUrl);
});

document.getElementById('btn-gsc-branded-toggle').addEventListener('click', () => {
  gscHideBranded = !gscHideBranded;
  document.getElementById('btn-gsc-branded-toggle').setAttribute('aria-pressed', String(gscHideBranded));
  browser.storage.local.set({ gscHideBranded });
  if (_gscPageUrl) {
    renderGscQueries(_gscQueries, _gscPageUrl);
    refreshGscChartForState();                 // chart follows selection/intent/branded
    if (gscHideBranded) topUpGscQueries(25);  // backfill the table to ~25 visible
  }
});

document.getElementById('btn-gsc-more-queries').addEventListener('click', async () => {
  const btn = document.getElementById('btn-gsc-more-queries');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Loading…';
  await fetchMoreGscQueries();
  renderGscQueries(_gscQueries, _gscPageUrl);
  btn.disabled = false;
  btn.textContent = label;
});

document.getElementById('btn-gsc-clear-query-filter').addEventListener('click', () => {
  if (_gscSelectedQuery) { selectGscQuery(_gscSelectedQuery); return; }
  if (_gscIntentFilter) {
    _gscIntentFilter = null;
    renderGscQueries(_gscQueries, _gscPageUrl);
    refreshGscChartForState();
  }
});

document.querySelectorAll('#gsc-metric-toggles .gsc-metric-toggle').forEach(btn => {
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
  const status = await sendMessageWithTimeout({ action: 'gscGetStatus' });
  document.getElementById('gsc-redirect-uri').value = status.redirectUri;

  const badge         = document.getElementById('gsc-status-badge');
  const setupForm     = document.getElementById('gsc-setup-form');
  const connectedInfo = document.getElementById('gsc-connected-info');
  const connectedTip  = document.getElementById('gsc-connected-tip');

  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setupForm.classList.add('hidden');
    connectedInfo.classList.remove('hidden');
    setAccountEmail('gsc-account-email', status.email);
    if (status.connectedAt) {
      connectedTip.title = `Connected since ${formatDate(new Date(status.connectedAt))}`;
      connectedTip.classList.remove('hidden');
    } else {
      connectedTip.classList.add('hidden');
    }
  } else {
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setupForm.classList.remove('hidden');
    connectedInfo.classList.add('hidden');
    connectedTip.classList.add('hidden');
    setAccountEmail('gsc-account-email', null);
  }

  return status;
}

// Show the verified properties that cover the current page's domain and let
// the user pick which one to use; the choice is remembered per domain.
let _gscPropHost = null;

async function refreshGscPropertyInfo() {
  const matchEl = document.getElementById('gsc-property-match');
  const allEl   = document.getElementById('gsc-property-all');
  matchEl.textContent = '';
  matchEl.className = 'gsc-property-match hidden';
  matchEl.title = '';
  allEl.replaceChildren();

  const tab = await getActiveTab();
  let pageUrl = tab.url;
  try {
    const data = await browser.tabs.sendMessage(tab.id, { action: 'getPageData' });
    if (data?.canonical) pageUrl = data.canonical;
  } catch { /* fall back to tab.url */ }

  const res = await sendMessageWithTimeout({ action: 'gscResolveProperty', pageUrl });
  if (!res || !res.connected) {
    matchEl.textContent = 'Not connected';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  if (res.error) {
    matchEl.textContent = 'Could not load properties';
    matchEl.title = res.detail || res.error;
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }

  _gscPropHost = res.host;
  const matching = res.matching || [];

  if (!matching.length) {
    matchEl.textContent = 'No verified property matches this domain';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }

  matching.forEach(siteUrl => {
    // Use res.override (explicit user choice) — NOT res.siteUrl (which is auto-resolved
    // and still returns a best-match even after the override is cleared).
    const isActive = res.override != null && siteUrl === res.override;
    const opt = document.createElement('button');
    opt.className = 'gsc-property-option' + (isActive ? ' gsc-property-option--active' : '');
    opt.dataset.site = siteUrl;
    const radio = document.createElement('span');
    radio.className = 'gsc-property-radio';
    const text = document.createElement('span');
    text.className = 'gsc-property-option-text';
    text.textContent = siteUrl;
    opt.append(radio, text);
    opt.addEventListener('click', () => selectGscProperty(siteUrl));

    // The linked (active) property gets a trash to unlink this domain
    if (isActive) {
      const row = document.createElement('div');
      row.className = 'gsc-property-row';
      row.appendChild(opt);
      row.appendChild(propertyTrashButton('Unlink this domain from this property', async () => {
        await sendMessageWithTimeout({ action: 'gscSetProperty', host: _gscPropHost, siteUrl: null });
        refreshGscPropertyInfo();
      }));
      allEl.appendChild(row);
    } else {
      allEl.appendChild(opt);
    }
  });
}

async function selectGscProperty(siteUrl) {
  if (!_gscPropHost) return;
  document.querySelectorAll('#gsc-property-all .gsc-property-option').forEach(el => {
    el.classList.toggle('gsc-property-option--active', el.dataset.site === siteUrl);
  });
  await sendMessageWithTimeout({ action: 'gscSetProperty', host: _gscPropHost, siteUrl });
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
    const result = await sendMessageWithTimeout({ action: 'gscConnect' });
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

// The "Connected" chip doubles as the disconnect control (hover → red Disconnect)
document.getElementById('gsc-status-badge').addEventListener('click', async (e) => {
  if (!e.currentTarget.classList.contains('gsc-status-badge--connected')) return;
  await sendMessageWithTimeout({ action: 'gscDisconnect' });
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
    document.querySelectorAll('#gsc-metric-toggles .gsc-metric-toggle').forEach(btn => {
      btn.setAttribute('aria-pressed', String(gscActiveMetrics[btn.dataset.metric] !== false));
    });
  });
}
