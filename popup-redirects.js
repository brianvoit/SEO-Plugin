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

// ─── Header badge ────────────────────────────────────────────────────────────

function paintRedirectBadge() {
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
  badge.title = redirectCount > 0
    ? `Arrived via ${redirectCount} redirect${redirectCount !== 1 ? 's' : ''} — click for the chain`
    : `Status ${code} — click for details`;
}

// Called from loadData with the active tab + its page data
function renderRedirectStatus(tabId, pageData) {
  _redirectMeta = (pageData && pageData.metaRefresh) || null;
  browser.runtime.sendMessage({ action: 'getRedirectInfo', tabId })
    .then(info => { _redirectInfo = info; paintRedirectBadge(); })
    .catch(() => { _redirectInfo = null; paintRedirectBadge(); });
}

// ─── Detail panel ────────────────────────────────────────────────────────────

function buildHopRow(hop, isFinal) {
  const row = document.createElement('div');
  row.className = 'redirect-row';

  const level = redirectStatusClass(hop.status);
  const status = document.createElement('span');
  status.className = `redirect-status redirect-status--${level}`;
  status.textContent = hop.status;
  row.appendChild(status);

  const typeText = hop.kind === 'client' ? 'JS / Meta' : (isFinal ? '' : redirectTypeLabel(hop.status));
  const type = document.createElement('span');
  type.className = 'redirect-type';
  type.textContent = typeText;
  row.appendChild(type);

  const url = document.createElement('span');
  url.className = 'redirect-url';
  url.title = hop.url;
  url.textContent = hop.url;
  row.appendChild(url);

  return row;
}

function renderRedirectPanel() {
  const chainEl    = document.getElementById('redirect-chain');
  const insightsEl = document.getElementById('redirect-insights');
  chainEl.replaceChildren();
  insightsEl.replaceChildren();

  const info  = _redirectInfo;
  const chain = (info && info.chain) || [];

  if (!chain.length) {
    appendIndexRow(chainEl, 'warning', 'No status information for this page (it may have loaded before the extension started).');
  } else {
    chain.forEach((hop, i) => chainEl.appendChild(buildHopRow(hop, i === chain.length - 1)));
  }

  // Insight rows
  const redirectCount = countRedirects(chain);
  if (redirectCount > 2) {
    appendIndexRow(insightsEl, 'warning', `Long redirect chain (${redirectCount} hops) — wastes crawl budget and slows loads.`);
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
    appendIndexRow(insightsEl, 'warning', `Meta-refresh redirect → ${_redirectMeta.url} — server redirects (301) are better for SEO.`);
  }
}

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
