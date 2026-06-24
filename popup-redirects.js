// Page status & redirect trace: the header status badge and the redirect-chain
// detail panel. Reads the per-tab chain captured by background.js (webRequest)
// plus the page's own meta-refresh (from content.js getPageData).

let _redirectInfo = null;   // { chain:[{url,status}], finalStatus, error, ... } | null
let _redirectMeta = null;   // pageData.metaRefresh | null

function redirectStatusClass(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'error';
  return 'server';   // 5xx (and anything unexpected)
}

function redirectTypeLabel(status) {
  if (status === 301 || status === 308) return 'Permanent';
  if (status === 302 || status === 303 || status === 307) return 'Temporary';
  return '';
}

// Server 3xx hops plus stitched client-side (JS/meta) redirect hops
function countRedirects(chain) {
  return chain.filter(h => (h.status >= 300 && h.status < 400) || h.kind === 'client').length;
}

// ─── SSL summary (Overview dates section) ─────────────────────────────────────

function parseIssuerOrg(issuer) {
  if (!issuer) return null;
  const m = /O=("[^"]+"|[^,]+)/.exec(issuer) || /CN=("[^"]+"|[^,]+)/.exec(issuer);
  return m ? m[1].replace(/^"|"$/g, '') : null;
}

function renderSslSummary() {
  const el = document.getElementById('ssl-summary');
  const tls = _redirectInfo && _redirectInfo.tls;
  if (!tls || !tls.validityEnd) {
    el.textContent = '—';
    el.className = 'dates-value dates-value--none';
    el.title = '';
    return;
  }
  const days = Math.floor((tls.validityEnd - Date.now()) / 86400000);
  const issuer = parseIssuerOrg(tls.issuer);
  el.textContent = `${issuer ? issuer + ' · ' : ''}expires in ${days} days`;
  el.className = 'dates-value ' + (days < 8 ? 'hint-red' : days <= 30 ? 'hint-amber' : 'hint-green');
  el.title = [tls.protocol, tls.cipher, tls.state !== 'secure' ? `state: ${tls.state}` : null]
    .filter(Boolean).join('\n');
}

// ─── Header badge ────────────────────────────────────────────────────────────

function paintRedirectBadge() {
  renderSslSummary();
  if (typeof activeTab !== 'undefined') {
    if (activeTab === 'dns' && typeof renderDnsSecuritySections === 'function') renderDnsSecuritySections();
    if (activeTab === 'redirect') renderRedirectPanel();
  }

  const badge   = document.getElementById('btn-status');
  const codeEl  = document.getElementById('status-code');
  const countEl = document.getElementById('status-count');
  const info    = _redirectInfo;

  if (!info || (info.finalStatus == null && !info.error)) {
    badge.className = 'status-badge hidden';
    return;
  }

  const redirectCount = countRedirects(info.chain || []);
  let level, code;
  if (info.finalStatus == null && info.error) {
    level = 'server';
    code  = 'ERR';
  } else {
    code = String(info.finalStatus);
    const base = redirectStatusClass(info.finalStatus);
    level = (base === 'ok' && redirectCount > 0) ? 'redirect' : base;
  }

  codeEl.textContent = code;
  if (redirectCount > 0) {
    countEl.textContent = `↳${redirectCount}`;
    countEl.classList.remove('hidden');
  } else {
    countEl.classList.add('hidden');
  }
  badge.className = `status-badge status-badge--${level}`;
  if (typeof activeTab !== 'undefined' && activeTab === 'redirect') {
    badge.classList.add('status-badge--tab-active');
  }
  badge.title = redirectCount > 0
    ? `Arrived via ${redirectCount} redirect${redirectCount !== 1 ? 's' : ''} — click for the trace`
    : `Status ${code} — click for the redirect trace`;
}

// Called from loadData with the active tab + its page data
function renderRedirectStatus(tabId, pageData) {
  _redirectMeta = (pageData && pageData.metaRefresh) || null;
  browser.runtime.sendMessage({ action: 'getRedirectInfo', tabId })
    .then(info => { _redirectInfo = info; paintRedirectBadge(); })
    .catch(() => { _redirectInfo = null; paintRedirectBadge(); });
}

// ─── Redirect-trace tab ──────────────────────────────────────────────────────

// Each intermediate hop is a redirect (yellow); the final hop is colored by
// its own status: 2xx green, 4xx red, 5xx gray, a final 3xx stays yellow.
function hopLevel(hop, isFinal) {
  if (!isFinal) return 'redirect';
  return redirectStatusClass(hop.status);
}

function hopExtras(hop) {
  const parts = [];
  if (hop.ms != null) parts.push(`${hop.ms} ms`);
  if (hop.fromCache) parts.push('cached');
  if (hop.cookies && hop.cookies.length) parts.push(`${hop.cookies.length} cookie${hop.cookies.length !== 1 ? 's' : ''}`);
  if (hop.xRobots) parts.push(`X-Robots: ${hop.xRobots}`);
  return parts;
}

function buildHopRow(hop, isFinal, isFirst) {
  const wrap = document.createElement('div');
  wrap.className = 'redirect-hop';

  const row = document.createElement('div');
  row.className = 'redirect-row';

  const status = document.createElement('span');
  status.className = `redirect-status redirect-status--${hopLevel(hop, isFinal)}`;
  status.textContent = hop.status;
  row.appendChild(status);

  const type = document.createElement('span');
  type.className = 'redirect-type';
  if (hop.kind === 'client') type.textContent = hop.metaDelay != null ? `META ${hop.metaDelay}s` : 'JS / Meta';
  else if (hop.kind === 'internal') type.textContent = 'HSTS';
  else type.textContent = isFinal ? '' : redirectTypeLabel(hop.status);
  row.appendChild(type);

  const url = document.createElement('span');
  url.className = 'redirect-url';
  url.title = hop.url;
  url.textContent = hop.url;
  if (/^https?:/i.test(hop.url || '')) {
    url.classList.add('redirect-url--link');
    url.addEventListener('click', () => browser.tabs.create({ url: hop.url }));
  }
  row.appendChild(url);

  if (isFirst || isFinal) {
    const tag = document.createElement('span');
    tag.className = 'redirect-tag' + (isFinal ? ' redirect-tag--final' : '');
    tag.textContent = isFinal ? 'Final' : 'Initial';
    row.appendChild(tag);
  }

  wrap.appendChild(row);

  const extras = hopExtras(hop);
  if (extras.length) {
    const meta = document.createElement('div');
    meta.className = 'redirect-hop-meta';
    meta.textContent = extras.join(' · ');
    if (hop.cookies && hop.cookies.length) meta.title = 'Cookies: ' + hop.cookies.join(', ');
    wrap.appendChild(meta);
  }

  return wrap;
}

function renderHopChain(chainEl, chain, emptyMsg) {
  chainEl.replaceChildren();
  if (!chain.length) {
    if (emptyMsg) appendIndexRow(chainEl, 'warning', emptyMsg);
    return;
  }
  chain.forEach((hop, i) =>
    chainEl.appendChild(buildHopRow(hop, i === chain.length - 1 && !hop.pending, i === 0)));
}

function renderChainInsights(insightsEl, chain, { totalMs = null, meta = null } = {}) {
  insightsEl.replaceChildren();

  const redirectCount = countRedirects(chain);
  if (redirectCount >= 1) {
    appendIndexRow(insightsEl, redirectCount > 2 ? 'warning' : 'ok',
      `${redirectCount} redirect${redirectCount !== 1 ? 's' : ''} in the chain` +
      (redirectCount > 2 ? ' — long chains waste crawl budget and bleed link equity.' : '.'));
  }

  const urls = chain.map(h => h.url);
  if (new Set(urls).size !== urls.length) {
    appendIndexRow(insightsEl, 'error', 'Redirect loop detected — a URL repeats in the chain.');
  }

  if (chain.some(h => [302, 303, 307].includes(h.status) && h.kind !== 'internal')) {
    appendIndexRow(insightsEl, 'warning', 'Temporary redirect (302/307) in the chain — use 301 to pass SEO equity for permanent moves.');
  }

  if (meta) {
    appendIndexRow(insightsEl, 'warning', `Meta-refresh redirect → ${meta.url}${meta.delay != null ? ` after ${meta.delay}s` : ''} — a server 301 is better for SEO.`);
  }

  if (totalMs != null) {
    appendIndexRow(insightsEl, totalMs > 1500 ? 'warning' : 'ok', `Total redirect+load time: ${totalMs} ms.`);
  }
}

// The passive chain (what the browser actually did to arrive here), including a
// pending meta-refresh the page itself will perform (content.js reports it).
function tracedChain() {
  const chain = ((_redirectInfo && _redirectInfo.chain) || []).map(h => ({ ...h }));
  if (_redirectMeta && _redirectMeta.url) {
    chain.push({ url: _redirectMeta.url, status: chain.length ? chain[chain.length - 1].status : 200, kind: 'client', metaDelay: _redirectMeta.delay, pending: true });
  }
  return chain;
}

// The actively-traced chain (re-requested by the background, follows every hop)
function activeChain() {
  return (_activeTrace && _activeTrace.hops) ? _activeTrace.hops.map(h => ({ ...h })) : [];
}

// What export / the export filename use: prefer the richer active trace
function displayChain() {
  const a = activeChain();
  return a.length ? a : tracedChain();
}

// ─── Active trace lifecycle ──────────────────────────────────────────────────

let _activeTrace = null;        // { startUrl, hops, finalUrl, error } | null
let _activeTraceUrl = null;     // page URL the active trace was run for
let _activeTraceLoading = false;

async function ensureActiveTrace(force = false) {
  let tab;
  try { tab = await getActiveTab(); } catch { return; }
  const url = tab && tab.url;

  if (!url || !/^https?:/i.test(url)) {
    if (_activeTrace || _activeTraceUrl) { _activeTrace = null; _activeTraceUrl = null; _activeTraceLoading = false; renderRedirectPanel(); }
    return;
  }
  if (!force && _activeTraceUrl === url) return;   // already traced / in flight

  _activeTraceUrl = url;
  _activeTrace = null;
  _activeTraceLoading = true;
  renderRedirectPanel();

  let res;
  try { res = await browser.runtime.sendMessage({ action: 'traceUrl', pageUrl: url }); }
  catch { res = { error: 'TRACE_FAILED', hops: [] }; }
  if (_activeTraceUrl !== url) return;              // navigated away while tracing

  _activeTrace = res;
  _activeTraceLoading = false;
  renderRedirectPanel();
}

function renderRedirectPanel() {
  // ── Active trace (primary) ──
  const chainEl    = document.getElementById('redirect-chain');
  const insightsEl = document.getElementById('redirect-insights');
  const bar        = document.getElementById('redirect-trace-bar');

  if (_activeTraceLoading) {
    bar.classList.add('hidden');
    insightsEl.replaceChildren();
    chainEl.replaceChildren();
    appendIndexRow(chainEl, 'ok', 'Tracing the redirect chain…');
  } else if (_activeTrace) {
    if (_activeTrace.startUrl) {
      document.getElementById('redirect-trace-from-url').textContent = _activeTrace.startUrl;
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }
    const chain = activeChain();
    renderHopChain(chainEl, chain, 'Could not trace this URL.' + (_activeTrace.error ? ` (${_activeTrace.error})` : ''));
    renderChainInsights(insightsEl, chain, { totalMs: chain.length ? chain.reduce((s, h) => s + (h.ms || 0), 0) : null });
  } else {
    bar.classList.add('hidden');
    insightsEl.replaceChildren();
    chainEl.replaceChildren();
    appendIndexRow(chainEl, 'warning', 'Open this tab on a web page to trace its redirects.');
  }

  // ── Passive trace (how you actually arrived this session) ──
  const passive = document.getElementById('redirect-passive');
  const pChain  = tracedChain();
  if (pChain.length) {
    passive.classList.remove('hidden');
    renderHopChain(document.getElementById('redirect-passive-chain'), pChain, '');
    renderChainInsights(document.getElementById('redirect-passive-insights'), pChain,
      { totalMs: _redirectInfo && _redirectInfo.totalMs, meta: _redirectMeta });
  } else {
    passive.classList.add('hidden');
  }

  // Kick off (or refresh) the active trace for the current page
  ensureActiveTrace();
}

document.getElementById('btn-redirect-retrace').addEventListener('click', () => ensureActiveTrace(true));

// ─── Export ───────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function buildRedirectExportText() {
  const chain = displayChain();
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const lines = [];
  lines.push('SEO Inspector — Redirect Trace');
  lines.push(`Date: ${stamp}`);
  if (chain.length) {
    lines.push(`Start URL: ${chain[0].url}`);
    lines.push(`Final URL: ${chain[chain.length - 1].url}`);
    lines.push(`Final Status: ${chain[chain.length - 1].status}`);
    lines.push(`Redirects: ${countRedirects(chain)}`);
  }
  lines.push('');
  lines.push('Redirect Path:');
  chain.forEach((hop, i) => {
    const isFinal = i === chain.length - 1 && !hop.pending;
    let kind;
    if (hop.kind === 'client')        kind = hop.metaDelay != null ? `META REFRESH ${hop.metaDelay}s` : 'JS/META';
    else if (hop.kind === 'internal') kind = 'HSTS';
    else if (isFinal)                 kind = 'FINAL';
    else                              kind = redirectTypeLabel(hop.status) || (i === 0 ? 'INITIAL' : 'REDIRECT');
    lines.push(`${i + 1}. [${hop.status}] ${kind} ${hop.url}`);
    const extras = hopExtras(hop);
    if (extras.length) lines.push(`     ${extras.join(' · ')}`);
    if (hop.cookies && hop.cookies.length) lines.push(`     Cookies: ${hop.cookies.join(', ')}`);
  });
  const total = _redirectInfo && _redirectInfo.totalMs;
  if (total != null) { lines.push(''); lines.push(`Total time: ${total} ms`); }
  return lines.join('\n') + '\n';
}

async function exportRedirectTrace() {
  const chain = displayChain();
  let host = 'page';
  try { host = new URL(chain.length ? chain[chain.length - 1].url : (await getActiveTab()).url).hostname.replace(/\./g, '_'); } catch { /* keep default */ }
  const now = new Date();
  const fileStamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const blob = new Blob([buildRedirectExportText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `SEO-Inspector-Redirect-Trace-${fileStamp}-${host}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('btn-redirect-export').addEventListener('click', exportRedirectTrace);

// ─── Live refresh (sidebar) ──────────────────────────────────────────────────

browser.runtime.onMessage.addListener(msg => {
  if (msg && msg.action === 'redirectUpdated') {
    getActiveTab().then(tab => {
      if (tab && tab.id === msg.tabId) {
        browser.runtime.sendMessage({ action: 'getRedirectInfo', tabId: tab.id })
          .then(info => { _redirectInfo = info; paintRedirectBadge(); })
          .catch(() => {});
      }
    }).catch(() => {});
  }
});
