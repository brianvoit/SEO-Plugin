// PageSpeed Insights / Core Web Vitals (Google PSI API v5). A page-level
// Overview entry (shown on every page) opens a full-screen panel with the
// Lighthouse performance score, the three Core Web Vitals (CrUX real-user
// field data when available, Lighthouse lab data otherwise), secondary lab
// metrics, and the top optimisation opportunities. Requires a free PSI API
// key (Settings); the row prompts to add one when it's missing.
//
// The Overview row only ever reads cache (cacheOnly) so a page view never
// triggers a slow, quota-costing live run — that happens on panel open/refresh.

let _psiStrategy = 'mobile';                 // 'mobile' | 'desktop'
const _psiEntries = { mobile: null, desktop: null };   // last successful entry per strategy
let _psiNoKey = false;
let _psiLoading = false;
let _psiError = null;
let _psiPageUrl = '';
const _psiOpen = new Set();                  // expanded audit ids (opportunities + diagnostics)
let _psiMetricFilter = null;                 // metric acronym: show only audits affecting it

// Good / needs-improvement bounds. Field data also carries CrUX's own
// FAST/AVERAGE/SLOW category, which we prefer for colouring when present.
const PSI_THRESHOLDS = {
  LCP:  { good: 2500, ni: 4000 },
  INP:  { good: 200,  ni: 500 },
  CLS:  { good: 0.1,  ni: 0.25 },
  FCP:  { good: 1800, ni: 3000 },
  TTFB: { good: 800,  ni: 1800 },
  TBT:  { good: 200,  ni: 600 },
  SI:   { good: 3400, ni: 5800 },
  TTI:  { good: 3800, ni: 7300 }
};
const PSI_LABELS = {
  LCP: 'LCP', INP: 'INP', CLS: 'CLS', FCP: 'FCP', TTFB: 'TTFB', TBT: 'TBT', SI: 'Speed Index', TTI: 'TTI'
};
const PSI_FULL = {
  LCP: 'Largest Contentful Paint', INP: 'Interaction to Next Paint', CLS: 'Cumulative Layout Shift',
  FCP: 'First Contentful Paint', TTFB: 'Time to First Byte', TBT: 'Total Blocking Time',
  SI: 'Speed Index', TTI: 'Time to Interactive'
};

function psiRate(metric, value) {
  const t = PSI_THRESHOLDS[metric];
  if (!t || value == null) return null;
  if (value <= t.good) return 'good';
  if (value <= t.ni) return 'ni';
  return 'poor';
}
function psiCategoryRate(category) {
  return category === 'FAST' ? 'good' : category === 'AVERAGE' ? 'ni' : category === 'SLOW' ? 'poor' : null;
}
function psiRateClass(rate) {
  return rate === 'good' ? 'psi-good' : rate === 'ni' ? 'psi-ni' : rate === 'poor' ? 'psi-poor' : '';
}
function psiScoreRate(score) {
  if (score == null) return null;
  return score >= 90 ? 'good' : score >= 50 ? 'ni' : 'poor';
}

// Lab metrics arrive in ms (CLS is unitless). Field CLS percentile is scaled
// ×100 by the API (10 → 0.10), so unscale it before formatting.
function psiFmtValue(metric, value) {
  if (value == null) return '—';
  if (metric === 'CLS') return value.toFixed(2);
  return value >= 1000 ? (value / 1000).toFixed(2) + ' s' : Math.round(value) + ' ms';
}
function psiFieldValue(metric, p) {
  if (p == null) return null;
  return metric === 'CLS' ? p / 100 : p;
}

// True Core Web Vitals pass = LCP, INP and CLS all "good" in field data.
function psiCwvPass(field) {
  if (!field || !field.metrics) return null;
  const core = ['LCP', 'INP', 'CLS'];
  const cats = core.map(m => field.metrics[m] && field.metrics[m].category).filter(Boolean);
  if (cats.length < core.length) return null;         // not enough field data to judge
  return cats.every(c => c === 'FAST');
}

// ─── Data loading ────────────────────────────────────────────────────────────

// Overview row: cache-only, cheap, never fires a live run.
async function loadPageSpeedData() {
  let url = '';
  try { url = (await getActiveTab()).url; } catch { return; }
  _psiPageUrl = url;
  let res = null;
  try {
    res = await sendMessageWithTimeout({ action: 'psiGetPageSpeed', url, strategy: 'mobile', cacheOnly: true });
  } catch { res = null; }

  if (res && res.error === 'NO_PSI_KEY') { _psiNoKey = true; }
  else if (res && !res.error) { _psiNoKey = false; if (!res.notCached) _psiEntries.mobile = res; }
  renderPageSpeedEntry();
  if (!document.getElementById('pagespeed-panel').classList.contains('hidden')) renderPageSpeedPanel();
}

// Panel open: render current state, then run cache-first for the active
// strategy unless we already have it (or there's no key).
function openPageSpeedPanel() {
  renderPageSpeedPanel();
  if (!_psiNoKey && !_psiEntries[_psiStrategy] && !_psiLoading) runPageSpeed(false);
}

// Live (or cache-first) run for the active strategy. PSI can take 10–20s, so
// use a longer timeout than the default.
async function runPageSpeed(forceRefresh = false) {
  if (_psiLoading) return;
  const strat = _psiStrategy;
  _psiLoading = true;
  _psiError = null;
  renderPageSpeedPanel();

  let url = '';
  try { url = (await getActiveTab()).url; } catch { url = _psiPageUrl; }
  _psiPageUrl = url;

  let res = null;
  try {
    res = await sendMessageWithTimeout({ action: 'psiGetPageSpeed', url, strategy: strat, forceRefresh }, 60000);
  } catch { res = { error: 'TIMEOUT' }; }
  _psiLoading = false;

  if (res && res.error === 'NO_PSI_KEY') { _psiNoKey = true; }
  else if (res && res.error) { _psiError = res.error; }
  else if (res) { _psiNoKey = false; _psiEntries[strat] = res; }

  renderPageSpeedPanel();
  renderPageSpeedEntry();
}

// ─── Overview entry row ──────────────────────────────────────────────────────

function renderPageSpeedEntry() {
  const summary = document.getElementById('pagespeed-summary');
  if (!summary) return;
  summary.replaceChildren();
  summary.classList.remove('field-nav-summary--muted');

  if (_psiNoKey) {
    summary.textContent = 'Add key in Settings →';
    summary.classList.add('field-nav-summary--muted');
    return;
  }
  const d = _psiEntries.mobile;
  if (!d) {
    summary.textContent = 'Not checked yet';
    summary.classList.add('field-nav-summary--muted');
    return;
  }
  if (d.performanceScore != null) {
    const score = document.createElement('span');
    score.className = 'psi-summary-score ' + psiRateClass(psiScoreRate(d.performanceScore));
    score.textContent = d.performanceScore;
    summary.appendChild(score);
  }
  const pass = psiCwvPass(d.field);
  const verdict = document.createElement('span');
  verdict.textContent = ' · ' + (pass === true ? 'CWV pass' : pass === false ? 'CWV fail' : 'lab only');
  summary.appendChild(verdict);
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function psiStatTile(label, value, rate) {
  const box = document.createElement('div');
  box.className = 'ranking-stat';
  const v = document.createElement('div');
  v.className = 'ranking-stat-val ' + psiRateClass(rate);
  v.textContent = value;
  const l = document.createElement('div');
  l.className = 'ranking-stat-label';
  l.textContent = label;
  box.append(v, l);
  return box;
}

// opts: { clickable, active, onClick } — a metric is only clickable when
// Lighthouse actually attributes audits to it (TTI/INP often have none).
function psiMetricRow(metric, value, rate, note, opts = {}) {
  const row = document.createElement('div');
  row.className = 'psi-metric-row'
    + (opts.clickable ? ' psi-metric-row--click' : '')
    + (opts.active ? ' is-active' : '');

  if (opts.clickable) {
    row.title = opts.active
      ? `Showing only audits affecting ${metric} — click to show all`
      : `Show only the audits affecting ${metric}`;
    row.addEventListener('click', opts.onClick);
  }

  const dot = document.createElement('span');
  dot.className = 'psi-dot ' + psiRateClass(rate);
  row.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'psi-metric-name';
  name.textContent = PSI_LABELS[metric] || metric;
  name.title = PSI_FULL[metric] || '';
  row.appendChild(name);

  if (note) {
    const n = document.createElement('span');
    n.className = 'psi-metric-note';
    n.textContent = note;
    row.appendChild(n);
  }

  const val = document.createElement('span');
  val.className = 'psi-metric-val ' + psiRateClass(rate);
  val.textContent = value;
  row.appendChild(val);
  return row;
}

function psiSectionTitle(text) {
  const h = document.createElement('div');
  h.className = 'psi-section-title';
  h.textContent = text;
  return h;
}

// ─── Breakdown: per-audit detail (what's actually causing the problem) ───────

function psiBytesFmt(b) {
  if (b == null || b <= 0) return null;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function psiMsFmt(ms) {
  if (ms == null || ms <= 0) return null;
  return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
}
// Cache lifetimes span 0 → months, so they need their own scale.
function psiTtlFmt(ms) {
  if (ms == null) return null;
  if (ms <= 0) return 'no cache';
  const h = ms / 3600000;
  if (h >= 24) return Math.round(h / 24) + 'd cache';
  if (h >= 1) return Math.round(h) + 'h cache';
  return Math.round(ms / 60000) + 'm cache';
}

// One offending resource / element inside an expanded audit.
function psiItemRow(it) {
  const row = document.createElement('div');
  row.className = 'psi-item';

  const main = document.createElement('div');
  main.className = 'psi-item-main';

  const label = document.createElement('span');
  label.className = 'psi-item-label';
  label.textContent = it.label || it.snippet || '—';
  if (it.label) label.title = it.label;
  main.appendChild(label);

  // A DOM snippet is the useful part for element-based audits; only show it
  // when it adds something beyond the label.
  if (it.snippet && it.snippet !== it.label) {
    const code = document.createElement('code');
    code.className = 'psi-snippet';
    code.textContent = it.snippet;
    main.appendChild(code);
  }
  if (it.selector) {
    const sel = document.createElement('span');
    sel.className = 'psi-item-sel';
    sel.textContent = it.selector;
    main.appendChild(sel);
  }
  row.appendChild(main);

  const facts = [];
  const b = psiBytesFmt(it.bytes); if (b) facts.push(b);
  const m = psiMsFmt(it.ms);       if (m) facts.push(m);
  if (it.cacheMs != null) facts.push(psiTtlFmt(it.cacheMs));
  if (it.score != null)   facts.push(it.score.toFixed(3));
  if (it.value != null)   facts.push(String(it.value));
  if (facts.length) {
    const f = document.createElement('span');
    f.className = 'psi-item-facts';
    f.textContent = facts.join(' · ');
    row.appendChild(f);
  }
  return row;
}

// Expandable audit: headline + savings, opening to Lighthouse's explanation
// and the specific resources responsible.
function psiAuditBlock(a, metric) {
  const open = _psiOpen.has(a.id);
  const wrap = document.createElement('div');
  wrap.className = 'psi-audit';

  const head = document.createElement('button');
  head.className = 'psi-audit-head' + (open ? ' is-open' : '');
  head.setAttribute('aria-expanded', String(open));

  const caret = document.createElement('span');
  caret.className = 'psi-audit-caret';
  caret.textContent = open ? '▾' : '▸';
  head.appendChild(caret);

  const title = document.createElement('span');
  title.className = 'psi-audit-title';
  title.textContent = a.title;
  head.appendChild(title);

  if (a.items && a.items.length) {
    const count = document.createElement('span');
    count.className = 'psi-audit-count';
    count.textContent = a.items.length;
    count.title = `${a.items.length} item${a.items.length === 1 ? '' : 's'}`;
    head.appendChild(count);
  }

  // While filtered to a metric, show what this fix is worth to THAT metric
  // (Lighthouse's own per-metric estimate) rather than the generic headline.
  const metricSaving = (metric && a.savings && typeof a.savings[metric] === 'number') ? a.savings[metric] : 0;
  const savings = document.createElement('span');
  savings.className = 'psi-audit-savings';
  savings.textContent = metricSaving > 0
    ? `${metric} −${psiMsFmt(metricSaving)}`
    : (a.display || psiMsFmt(a.ms) || '');
  head.appendChild(savings);

  head.addEventListener('click', () => {
    if (open) _psiOpen.delete(a.id); else _psiOpen.add(a.id);
    renderPageSpeedPanel();
  });
  wrap.appendChild(head);

  if (open) {
    const body = document.createElement('div');
    body.className = 'psi-audit-body';
    if (a.description) {
      const d = document.createElement('p');
      d.className = 'psi-audit-desc';
      d.textContent = a.description;
      body.appendChild(d);
    }
    if (a.items && a.items.length) a.items.forEach(it => body.appendChild(psiItemRow(it)));
    else {
      const none = document.createElement('p');
      none.className = 'psi-audit-desc psi-audit-desc--muted';
      none.textContent = 'No specific resources listed for this check.';
      body.appendChild(none);
    }
    wrap.appendChild(body);
  }
  return wrap;
}

// "LCP element" / "shifting elements" callout — the single most useful pointer
// for the two hardest CWV metrics to chase down.
function psiElementCallout(label, node) {
  const box = document.createElement('div');
  box.className = 'psi-callout';
  const l = document.createElement('span');
  l.className = 'psi-callout-label';
  l.textContent = label;
  box.appendChild(l);
  if (node.label) {
    const n = document.createElement('span');
    n.className = 'psi-callout-node';
    n.textContent = node.label;
    box.appendChild(n);
  }
  if (node.snippet) {
    const code = document.createElement('code');
    code.className = 'psi-snippet';
    code.textContent = node.snippet;
    box.appendChild(code);
  }
  if (node.selector) {
    const s = document.createElement('span');
    s.className = 'psi-item-sel';
    s.textContent = node.selector;
    box.appendChild(s);
  }
  return box;
}

function psiConnectState(el) {
  const wrap = document.createElement('div');
  wrap.className = 'psi-empty';
  const p = document.createElement('p');
  p.className = 'field-hint';
  p.textContent = 'PageSpeed Insights needs a free Google API key. Add one in Settings to see Core Web Vitals for this page.';
  wrap.appendChild(p);
  const btn = document.createElement('button');
  btn.className = 'save-key-btn';
  btn.textContent = 'Open Settings';
  btn.style.marginTop = '8px';
  btn.addEventListener('click', () => { if (typeof showSettings === 'function') showSettings(); });
  wrap.appendChild(btn);
  el.appendChild(wrap);
}

function renderPageSpeedPanel() {
  const el = document.getElementById('pagespeed-content');
  if (!el) return;
  el.replaceChildren();

  // Header meta: current page URL
  const meta = document.getElementById('pagespeed-header-meta');
  if (meta) { try { meta.textContent = new URL(_psiPageUrl).pathname || '/'; } catch { meta.textContent = ''; } }

  // Strategy toggle reflects state
  document.querySelectorAll('#pagespeed-strategy-group .mode-option').forEach(b => {
    b.classList.toggle('is-active', b.dataset.strategy === _psiStrategy);
  });

  if (_psiNoKey) { psiConnectState(el); return; }

  if (_psiLoading) {
    const p = document.createElement('p');
    p.className = 'field-hint psi-loading';
    p.textContent = `Running PageSpeed Insights (${_psiStrategy})… this can take up to ~20 seconds.`;
    el.appendChild(p);
    return;
  }

  if (_psiError) {
    const p = document.createElement('p');
    p.className = 'field-hint hint-amber';
    p.textContent = _psiError === 'BAD_KEY'
      ? 'PageSpeed rejected the API key — check it in Settings.'
      : _psiError === 'RATE_LIMITED' ? 'PageSpeed rate limit reached — try again shortly.'
      : _psiError === 'TIMEOUT' ? 'PageSpeed took too long to respond — try Refresh.'
      : 'Could not reach PageSpeed Insights — try Refresh.';
    el.appendChild(p);
    return;
  }

  const d = _psiEntries[_psiStrategy];
  if (!d) {
    const p = document.createElement('p');
    p.className = 'field-hint';
    p.textContent = 'Tap Refresh to run a PageSpeed check for this page.';
    el.appendChild(p);
    return;
  }

  // Metric → audits attributed to it. A metric with no attributed audits
  // (Lighthouse gives TTI/INP none) isn't clickable, and a stale filter from
  // another strategy is dropped rather than hiding everything.
  const metricAudits = d.metricAudits || {};
  const metricHasAudits = (m) => !!(metricAudits[m] && metricAudits[m].length);
  if (_psiMetricFilter && !metricHasAudits(_psiMetricFilter)) _psiMetricFilter = null;
  const toggleMetric = (m) => {
    _psiMetricFilter = (_psiMetricFilter === m) ? null : m;
    renderPageSpeedPanel();
  };
  const metricOpts = (m) => ({
    clickable: metricHasAudits(m),
    active: _psiMetricFilter === m,
    onClick: () => toggleMetric(m)
  });

  // ── Scorecard: performance score + the 3 Core Web Vitals as heroes ──
  const field = d.field;
  const useField = !!(field && field.metrics);
  const heroVal = (metric) => {
    if (useField && field.metrics[metric]) {
      const raw = psiFieldValue(metric, field.metrics[metric].p);
      return { text: psiFmtValue(metric, raw), rate: psiCategoryRate(field.metrics[metric].category) };
    }
    const lab = d.lab[metric];
    const v = lab ? lab.value : null;
    return { text: psiFmtValue(metric, v), rate: psiRate(metric, v) };
  };

  const scorecard = document.createElement('div');
  scorecard.className = 'ranking-scorecard';
  scorecard.appendChild(psiStatTile('Performance', d.performanceScore != null ? String(d.performanceScore) : '—', psiScoreRate(d.performanceScore)));
  ['LCP', 'INP', 'CLS'].forEach(m => { const h = heroVal(m); scorecard.appendChild(psiStatTile(m, h.text, h.rate)); });
  el.appendChild(scorecard);

  // ── Core Web Vitals section ──
  el.appendChild(psiSectionTitle('Core Web Vitals'));
  const cwvNote = document.createElement('p');
  cwvNote.className = 'field-hint psi-source-note';
  if (useField) {
    const pass = psiCwvPass(field);
    cwvNote.textContent = (field.origin
      ? 'Real-user data (CrUX, 28-day) — origin-level, this URL lacks enough traffic. '
      : 'Real-user data (CrUX, 28-day) for this URL. ')
      + (pass === true ? 'Passing.' : pass === false ? 'Not passing.' : '');
  } else {
    cwvNote.textContent = 'No real-user (field) data for this page — showing Lighthouse lab estimates instead.';
  }
  el.appendChild(cwvNote);

  ['LCP', 'INP', 'CLS'].forEach(metric => {
    if (useField && field.metrics[metric]) {
      const fm = field.metrics[metric];
      const raw = psiFieldValue(metric, fm.p);
      el.appendChild(psiMetricRow(metric, psiFmtValue(metric, raw), psiCategoryRate(fm.category), 'field', metricOpts(metric)));
    } else {
      const lab = d.lab[metric];
      const v = lab ? lab.value : null;
      el.appendChild(psiMetricRow(metric, lab && lab.display ? lab.display : psiFmtValue(metric, v), psiRate(metric, v), 'lab', metricOpts(metric)));
    }
    // Point at the actual element behind the metric, right under its row.
    if (metric === 'LCP' && d.lcpElement) el.appendChild(psiElementCallout('LCP element', d.lcpElement));
    if (metric === 'CLS' && d.clsElements && d.clsElements.length) {
      d.clsElements.forEach(n => el.appendChild(psiElementCallout('Shifted', n)));
    }
  });

  // ── Secondary lab metrics ──
  el.appendChild(psiSectionTitle('Lab metrics (Lighthouse)'));
  ['FCP', 'TBT', 'SI', 'TTI'].forEach(metric => {
    const lab = d.lab[metric];
    const v = lab ? lab.value : null;
    el.appendChild(psiMetricRow(metric, lab && lab.display ? lab.display : psiFmtValue(metric, v), psiRate(metric, v), null, metricOpts(metric)));
  });

  // ── Breakdown, optionally narrowed to one metric ──
  const ids = _psiMetricFilter ? metricAudits[_psiMetricFilter] : null;
  const inFilter = (a) => !ids || ids.includes(a.id);
  const opps  = (d.opportunities || []).filter(inFilter);
  const diags = (d.diagnostics || []).filter(inFilter);

  if (_psiMetricFilter) {
    const bar = document.createElement('div');
    bar.className = 'psi-filter-bar';
    const label = document.createElement('span');
    label.className = 'psi-filter-label';
    label.textContent = `Showing what affects ${_psiMetricFilter}`;
    bar.appendChild(label);
    const clear = document.createElement('button');
    clear.className = 'psi-filter-clear';
    clear.textContent = 'Show all';
    clear.addEventListener('click', () => { _psiMetricFilter = null; renderPageSpeedPanel(); });
    bar.appendChild(clear);
    el.appendChild(bar);
  }

  if (opps.length) {
    el.appendChild(psiSectionTitle(_psiMetricFilter ? `Opportunities · ${_psiMetricFilter}` : 'Opportunities — tap to see what’s responsible'));
    opps.forEach(o => el.appendChild(psiAuditBlock(o, _psiMetricFilter)));
  }

  if (diags.length) {
    el.appendChild(psiSectionTitle(_psiMetricFilter ? `Diagnostics · ${_psiMetricFilter}` : 'Diagnostics'));
    diags.forEach(a => el.appendChild(psiAuditBlock(a, _psiMetricFilter)));
  }

  if (_psiMetricFilter && !opps.length && !diags.length) {
    const p = document.createElement('p');
    p.className = 'field-hint';
    p.textContent = `Lighthouse doesn’t attribute any of this page’s findings to ${_psiMetricFilter}.`;
    el.appendChild(p);
  }

  // ── Open full report ──
  const foot = document.createElement('div');
  foot.className = 'psi-foot';
  const link = document.createElement('button');
  link.className = 'save-key-btn';
  link.textContent = 'Open full report ↗';
  link.title = 'Open this page on pagespeed.web.dev';
  link.addEventListener('click', () => {
    const u = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(d.url)}&form_factor=${_psiStrategy}`;
    browser.tabs.create({ url: u });
  });
  foot.appendChild(link);
  const stamp = document.createElement('span');
  stamp.className = 'psi-stamp';
  if (d.fetchedAt && typeof gscRelativeTime === 'function') stamp.textContent = 'Checked ' + gscRelativeTime(d.fetchedAt);
  foot.appendChild(stamp);
  el.appendChild(foot);
}

// ─── Controls ────────────────────────────────────────────────────────────────

document.querySelectorAll('#pagespeed-strategy-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const strat = btn.dataset.strategy;
    if (strat === _psiStrategy) return;
    _psiStrategy = strat;
    // Show cached result for this strategy instantly if we have it, else run.
    if (_psiEntries[_psiStrategy]) renderPageSpeedPanel();
    else runPageSpeed(false);
  });
});

document.getElementById('btn-pagespeed-refresh').addEventListener('click', () => runPageSpeed(true));
