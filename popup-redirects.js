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

function buildHopRow(hop, isFinal) {
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
  if (hop.kind === 'client') {
    type.textContent = hop.metaDelay != null ? `META ${hop.metaDelay}s` : 'JS / Meta';
  } else {
    type.textContent = isFinal ? '' : redirectTypeLabel(hop.status);
  }
  row.appendChild(type);

  const url = document.createElement('span');
  url.className = 'redirect-url';
  url.title = hop.url;
  url.textContent = hop.url;
  row.appendChild(url);

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

// The chain as displayed, including a pending meta-refresh hop the current
// page will perform (server hops can't see meta refresh — content.js reports it)
function tracedChain() {
  const chain = ((_redirectInfo && _redirectInfo.chain) || []).map(h => ({ ...h }));
  if (_redirectMeta && _redirectMeta.url) {
    chain.push({ url: _redirectMeta.url, status: chain.length ? chain[chain.length - 1].status : 200, kind: 'client', metaDelay: _redirectMeta.delay, pending: true });
  }
  return chain;
}

function renderRedirectPanel() {
  const chainEl    = document.getElementById('redirect-chain');
  const insightsEl = document.getElementById('redirect-insights');
  chainEl.replaceChildren();
  insightsEl.replaceChildren();

  const chain = tracedChain();

  if (!chain.length) {
    appendIndexRow(chainEl, 'warning', 'No status information for this page (it may have loaded before the extension started). Reload the page to trace it.');
  } else {
    chain.forEach((hop, i) => chainEl.appendChild(buildHopRow(hop, i === chain.length - 1 && !hop.pending)));
  }

  // Insight rows
  const redirectCount = countRedirects(chain);
  if (redirectCount >= 1) {
    appendIndexRow(insightsEl, redirectCount > 2 ? 'warning' : 'ok',
      `Arrived via ${redirectCount} redirect${redirectCount !== 1 ? 's' : ''}` +
      (redirectCount > 2 ? ' — long chains waste crawl budget and bleed link equity.' : '.'));
  }

  const urls = chain.map(h => h.url);
  if (new Set(urls).size !== urls.length) {
    appendIndexRow(insightsEl, 'error', 'Redirect loop detected — a URL repeats in the chain.');
  }

  const hasTemporary = chain.some(h => [302, 303, 307].includes(h.status));
  if (hasTemporary) {
    appendIndexRow(insightsEl, 'warning', 'Temporary redirect (302/307) in the chain — use 301 to pass SEO equity for permanent moves.');
  }

  if (_redirectMeta) {
    appendIndexRow(insightsEl, 'warning', `Meta-refresh redirect → ${_redirectMeta.url}${_redirectMeta.delay != null ? ` after ${_redirectMeta.delay}s` : ''} — a server 301 is better for SEO.`);
  }

  const total = _redirectInfo && _redirectInfo.totalMs;
  if (total != null) {
    appendIndexRow(insightsEl, total > 1500 ? 'warning' : 'ok', `Total redirect+load time: ${total} ms.`);
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function buildRedirectExportText() {
  const chain = tracedChain();
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
    const kind = hop.kind === 'client' ? (hop.metaDelay != null ? `META REFRESH ${hop.metaDelay}s` : 'JS/META') : (isFinal ? 'FINAL' : redirectTypeLabel(hop.status) || 'REDIRECT');
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
  const chain = tracedChain();
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
