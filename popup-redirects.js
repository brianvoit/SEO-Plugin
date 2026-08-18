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
  // Show the FIRST status on the path, not the last. The badge exists to flag
  // that a redirect happened — a 301→200 shown as "200" hides the hop, which is
  // the thing worth knowing. With no redirects the first hop IS the last, so
  // this is identical to the final code.
  const chain = info.chain || [];
  const firstStatus = (chain.length && chain[0].status != null) ? chain[0].status : info.finalStatus;

  let level, code;
  if (info.finalStatus == null && info.error) {
    level = 'server';
    code  = 'ERR';
  } else {
    code = String(firstStatus);
    const base = redirectStatusClass(firstStatus);
    level = (base === 'ok' && redirectCount > 0) ? 'redirect' : base;
  }

  // "{first status}:{redirect count}" — e.g. 301:1, 307:3. A page that didn't
  // redirect shows the bare code (200), since ":0" is noise on the common case.
  codeEl.textContent = code;
  if (redirectCount > 0) {
    countEl.textContent = `:${redirectCount}`;
    countEl.classList.remove('hidden');
  } else {
    countEl.classList.add('hidden');
  }
  badge.className = `status-badge status-badge--${level}`;
  if (typeof activeTab !== 'undefined' && activeTab === 'redirect') {
    badge.classList.add('status-badge--tab-active');
  }
  // The pill shows the first code, so spell out where it ended up.
  badge.title = redirectCount > 0
    ? `${firstStatus} → ${info.finalStatus} · ${redirectCount} redirect${redirectCount !== 1 ? 's' : ''} — click for the trace`
    : `Status ${code} — click for the redirect trace`;
}

// Called from loadData with the active tab + its page data
function renderRedirectStatus(tabId, pageData) {
  _redirectMeta = (pageData && pageData.metaRefresh) || null;
  sendMessageWithTimeout({ action: 'getRedirectInfo', tabId })
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

// Everything about a hop, for the export — which is plain text and has no row
// to inline anything into.
function hopExtras(hop) {
  const parts = [];
  if (hop.ms != null) parts.push(`${hop.ms} ms`);
  if (hop.fromCache) parts.push('cached');
  if (hop.cookies && hop.cookies.length) parts.push(`${hop.cookies.length} cookie${hop.cookies.length !== 1 ? 's' : ''}`);
  if (hop.xRobots) parts.push(`X-Robots: ${hop.xRobots}`);
  return parts;
}

// The subset that still needs a line of its own on screen. Timing and the
// cache flag are rendered inline in the row, so only the wordy ones remain —
// and a hop with neither gets no second line at all.
function hopExtrasBelow(hop) {
  const parts = [];
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

  if (hop.ms != null) {
    const ms = document.createElement('span');
    ms.className = 'redirect-ms';
    ms.textContent = `${hop.ms} ms`;
    row.appendChild(ms);
  }

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

  if (hop.fromCache) {
    const cached = document.createElement('span');
    cached.className = 'redirect-tag redirect-tag--cached';
    cached.textContent = 'Cached';
    cached.title = 'Served from the browser cache, not refetched';
    row.appendChild(cached);
  }

  if (isFirst || isFinal) {
    const tag = document.createElement('span');
    tag.className = 'redirect-tag' + (isFinal ? ' redirect-tag--final' : '');
    tag.textContent = isFinal ? 'Final' : 'Initial';
    row.appendChild(tag);
  }

  wrap.appendChild(row);

  const extras = hopExtrasBelow(hop);
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

  if (totalMs != null && redirectCount >= 1) {
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

// What the export FILENAME uses. The export body itself emits both chains —
// see buildRedirectExportText — because picking one silently was the bug this
// replaced: on any page reached by clicking a link, the active chain is a
// single hop on the destination, and exporting only that dropped the very
// redirect the user opened the panel to see.
function displayChain() {
  const a = activeChain();
  return a.length ? a : tracedChain();
}

// The URL the active trace should re-request.
//
// Tracing tab.url is wrong whenever the browser followed a redirect to get
// here: tab.url is the DESTINATION, which by definition has no redirects, so
// the trace reported "0 redirects" for a link the Link Health overlay had
// just flagged — the overlay probes the href as written on the linking page,
// which is the URL that actually redirects. Two panels, two different
// questions, contradictory-looking answers.
//
// Seeding from the passive chain's first hop makes both answer the same
// question: what happens when you request the URL that was linked.
// Identity of a chain for comparison: its hops' URLs and statuses. Trailing
// slashes and fragments are normalised the same way sameUrl does, so a chain
// is never called "different" over punctuation.
function chainSignature(chain) {
  return (chain || [])
    .map(h => `${String(h.url || '').replace(/#.*$/, '').replace(/\/$/, '')}|${h.status}`)
    .join(' > ');
}

// Do the live trace and the session record tell different stories? An empty
// live trace (still loading, or it failed) is not a disagreement — there is
// nothing yet to disagree with.
function chainsDiffer(active, passive) {
  if (!active.length || !passive.length) return false;
  return chainSignature(active) !== chainSignature(passive);
}

// Remembers which comparison the auto-open decision was made for, so a manual
// collapse is not undone by the next render.
let _passiveAutoOpenKey = null;

// The URL the browser was originally asked for this session, if a redirect
// brought us here. Null when the navigation went straight through.
function passiveStartUrl() {
  const passive = tracedChain();
  const start = passive.length ? passive[0].url : null;
  return (start && /^https?:/i.test(start)) ? start : null;
}

// The page currently in the tab, as the panel last saw it.
function currentTabUrl() { return _activeTraceUrl; }

// Compares URLs the way a reader would — a trailing slash is not a redirect.
function sameUrl(a, b) {
  const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/$/, '');
  return norm(a) === norm(b);
}

function activeTraceSeedUrl(tabUrl) {
  const passive = tracedChain();
  const start = passive.length ? passive[0].url : null;
  return (start && /^https?:/i.test(start)) ? start : tabUrl;
}

// ─── Active trace lifecycle ──────────────────────────────────────────────────

let _activeTrace = null;        // { startUrl, hops, finalUrl, error } | null
let _activeTraceUrl = null;     // page URL the active trace was run for
// Identity of the last trace: tab URL AND the seed it resolved to. The passive
// chain arrives from the background asynchronously, so the seed can change
// after a first render — keying on the tab URL alone would leave the panel
// showing a trace of the destination forever.
let _activeTraceKey = null;
let _activeTraceLoading = false;

async function ensureActiveTrace(force = false) {
  let tab;
  try { tab = await getActiveTab(); } catch { return; }
  const url = tab && tab.url;

  if (!url || !/^https?:/i.test(url)) {
    if (_activeTrace || _activeTraceUrl) {
      _activeTrace = null; _activeTraceUrl = null; _activeTraceKey = null; _activeTraceLoading = false;
      renderRedirectPanel();
    }
    return;
  }

  const seed = activeTraceSeedUrl(url);
  const key = `${url}::${seed}`;
  if (!force && _activeTraceKey === key) return;   // already traced / in flight

  _activeTraceUrl = url;
  _activeTraceKey = key;
  _activeTrace = null;
  _activeTraceLoading = true;
  renderRedirectPanel();

  let res;
  try { res = await sendMessageWithTimeout({ action: 'traceUrl', pageUrl: seed }); }
  catch { res = { error: 'TRACE_FAILED', hops: [] }; }
  if (_activeTraceKey !== key) return;              // navigated away while tracing

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
    // The trace may have started somewhere other than the page you're looking
    // at. Without saying so, a chain that opens on a different host reads as a
    // bug rather than as the answer to "what does that link do".
    const arrivedFrom = passiveStartUrl();
    if (arrivedFrom && !sameUrl(arrivedFrom, currentTabUrl())) {
      appendIndexRow(insightsEl, 'ok',
        `You arrived here via a redirect from ${arrivedFrom} — this trace starts there, not at the page you're on.`);
    }
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

    // Open it on its own when it disagrees with the live trace — that is the
    // case worth reading, and leaving it folded away is what hid the missing
    // redirect in the first place. When the two agree it stays collapsed,
    // since expanding it would just show the same chain twice.
    //
    // Only applied when the comparison itself changes, so a manual collapse
    // survives the re-renders that arrive as the trace and the tab update.
    const key = `${chainSignature(activeChain())}||${chainSignature(pChain)}`;
    if (_passiveAutoOpenKey !== key) {
      _passiveAutoOpenKey = key;
      passive.open = chainsDiffer(activeChain(), pChain);
    }
  } else {
    passive.classList.add('hidden');
    _passiveAutoOpenKey = null;
  }

  // Kick off (or refresh) the active trace for the current page
  ensureActiveTrace();
}

document.getElementById('btn-redirect-retrace').addEventListener('click', () => ensureActiveTrace(true));

// ─── Export ───────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

// One chain, rendered as the summary + numbered path the export has always
// used. Pulled out so both chains can be written with identical formatting.
function exportChainLines(chain, { totalMs } = {}) {
  const lines = [];
  if (chain.length) {
    lines.push(`Start URL: ${chain[0].url}`);
    lines.push(`Final URL: ${chain[chain.length - 1].url}`);
    lines.push(`Final Status: ${chain[chain.length - 1].status}`);
    lines.push(`Redirects: ${countRedirects(chain)}`);
  } else {
    lines.push('(nothing recorded)');
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
  if (totalMs != null) { lines.push(''); lines.push(`Total time: ${totalMs} ms`); }
  return lines;
}

// Both chains, always, whenever both exist — never a silent pick between them.
//
// The export used to emit displayChain() alone, which prefers the active
// trace. On any page reached by clicking a link that meant exporting a
// single-hop trace of the DESTINATION and dropping the passively-recorded
// chain that held the actual redirect. The file then read "Redirects: 0" for a
// link that had just been flagged as a redirect, with no way to tell why.
function buildRedirectExportText() {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const active = activeChain();
  const passive = tracedChain();

  const lines = [];
  lines.push('Redirect Inspector — Redirect Trace');
  lines.push(`Date: ${stamp}`);
  if (_activeTraceUrl) lines.push(`Page: ${_activeTraceUrl}`);
  const arrivedFrom = passiveStartUrl();
  if (arrivedFrom && !sameUrl(arrivedFrom, _activeTraceUrl)) {
    lines.push(`Arrived via a redirect from: ${arrivedFrom}`);
  }

  if (active.length) {
    lines.push('');
    lines.push('=== LIVE TRACE (re-requested now) ===');
    lines.push(...exportChainLines(active, { totalMs: active.reduce((t, h) => t + (h.ms || 0), 0) || null }));
  }

  if (passive.length) {
    lines.push('');
    lines.push('=== THIS SESSION (what the browser actually did) ===');
    lines.push(...exportChainLines(passive, { totalMs: _redirectInfo && _redirectInfo.totalMs }));
  }

  if (!active.length && !passive.length) {
    lines.push('');
    lines.push('No redirect data for this page.');
  }
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
  a.download = `Redirect-Trace-${fileStamp}-${host}.txt`;
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
        sendMessageWithTimeout({ action: 'getRedirectInfo', tabId: tab.id })
          .then(info => { _redirectInfo = info; paintRedirectBadge(); })
          .catch(() => {});
      }
    }).catch(() => {});
  }
});
