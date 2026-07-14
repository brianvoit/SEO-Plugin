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

function psiMetricRow(metric, value, rate, note) {
  const row = document.createElement('div');
  row.className = 'psi-metric-row';

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
      el.appendChild(psiMetricRow(metric, psiFmtValue(metric, raw), psiCategoryRate(fm.category), 'field'));
    } else {
      const lab = d.lab[metric];
      const v = lab ? lab.value : null;
      el.appendChild(psiMetricRow(metric, lab && lab.display ? lab.display : psiFmtValue(metric, v), psiRate(metric, v), 'lab'));
    }
  });

  // ── Secondary lab metrics ──
  el.appendChild(psiSectionTitle('Lab metrics (Lighthouse)'));
  ['FCP', 'TBT', 'SI', 'TTI'].forEach(metric => {
    const lab = d.lab[metric];
    const v = lab ? lab.value : null;
    el.appendChild(psiMetricRow(metric, lab && lab.display ? lab.display : psiFmtValue(metric, v), psiRate(metric, v), null));
  });

  // ── Top opportunities ──
  if (d.opportunities && d.opportunities.length) {
    el.appendChild(psiSectionTitle('Top opportunities'));
    d.opportunities.forEach(o => {
      const row = document.createElement('div');
      row.className = 'psi-opp-row';
      const t = document.createElement('span');
      t.className = 'psi-opp-title';
      t.textContent = o.title;
      row.appendChild(t);
      const s = document.createElement('span');
      s.className = 'psi-opp-savings';
      s.textContent = o.display || (o.ms >= 1000 ? (o.ms / 1000).toFixed(1) + ' s' : o.ms + ' ms');
      row.appendChild(s);
      el.appendChild(row);
    });
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
