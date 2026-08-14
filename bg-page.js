// Part of the extension background — see bg-core.js for how these files load.
// Per-page lookups that belong to no single vendor: domain age (RDAP), DNS over
// HTTPS, PageSpeed Insights, favicon reachability, and the link-health checker.

// ─── Domain age (RDAP) ────────────────────────────────────────────────────────
// rdap.org bootstraps to the registry's RDAP server — free, structured JSON,
// no key. Cached 30 days; registration dates don't move.

const DOMAIN_AGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function getDomainAge({ host }) {
  if (!host) return { error: 'NO_HOST' };
  const clean = host.replace(/^www\./, '').toLowerCase();

  const { domainAgeCache } = await browser.storage.local.get('domainAgeCache');
  const cache = domainAgeCache || {};
  const cached = cache[clean];
  if (cached && (Date.now() - cached.fetchedAt < DOMAIN_AGE_TTL_MS)) return cached;

  // Try the full host, then strip subdomain labels until RDAP recognizes it
  // (api.shop.example.com → shop.example.com → example.com)
  const labels = clean.split('.');
  let result = null;
  for (let i = 0; i <= labels.length - 2 && i < 3; i++) {
    const candidate = labels.slice(i).join('.');
    try {
      const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(candidate)}`, {
        headers: { Accept: 'application/rdap+json, application/json' }
      });
      if (res.status === 404) continue;
      if (!res.ok) break;
      const data = await res.json();
      const reg = (data.events || []).find(e => e.eventAction === 'registration');
      const exp = (data.events || []).find(e => e.eventAction === 'expiration');
      const registrar = (data.entities || []).find(e => (e.roles || []).includes('registrar'));
      result = {
        domain: candidate,
        registered: reg ? reg.eventDate : null,
        expires: exp ? exp.eventDate : null,
        registrar: registrar?.vcardArray?.[1]?.find(f => f[0] === 'fn')?.[3] || null
      };
      break;
    } catch { break; }
  }

  if (!result || !result.registered) return { error: 'NOT_FOUND', domain: clean };

  const entry = { ...result, fetchedAt: Date.now() };
  cache[clean] = entry;
  const keys = Object.keys(cache);
  if (keys.length > 30) {
    keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
    keys.slice(0, keys.length - 30).forEach(k => delete cache[k]);
  }
  await browser.storage.local.set({ domainAgeCache: cache });
  return entry;
}

// ─── DNS records (Google Public DNS over HTTPS) ───────────────────────────────

const DNS_TYPE_CODES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, NS: 2, TXT: 16 };
const DNS_TTL_MS = 60 * 60 * 1000;

async function dnsResolve({ host }) {
  if (!host) return { error: 'NO_HOST' };
  const clean = host.toLowerCase();

  const { dnsCache } = await browser.storage.local.get('dnsCache');
  const cache = dnsCache || {};
  const cached = cache[clean];
  if (cached && (Date.now() - cached.fetchedAt < DNS_TTL_MS)) return cached;

  const records = {};
  try {
    await Promise.all(Object.keys(DNS_TYPE_CODES).map(async type => {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(clean)}&type=${type}`, {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) { records[type] = []; return; }
      const data = await res.json();
      records[type] = (data.Answer || [])
        .filter(a => a.type === DNS_TYPE_CODES[type])
        .map(a => ({ data: a.data, ttl: a.TTL }));
    }));
  } catch {
    return { error: 'NETWORK' };
  }

  const entry = { host: clean, records, fetchedAt: Date.now() };
  cache[clean] = entry;
  const keys = Object.keys(cache);
  if (keys.length > 20) {
    keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
    keys.slice(0, keys.length - 20).forEach(k => delete cache[k]);
  }
  await browser.storage.local.set({ dnsCache: cache });
  return entry;
}

// ─── PageSpeed Insights / Core Web Vitals (PSI API v5) ───────────────────────
// Per-URL Lighthouse lab results + CrUX real-user field data. Requires a free
// PSI API key (Settings). Cached per url::strategy for 6h since perf changes
// with deploys, not by the minute.

const PSI_TTL_MS = 6 * 60 * 60 * 1000;

// CrUX field-metric key → our short name
const PSI_FIELD_KEYS = {
  LARGEST_CONTENTFUL_PAINT_MS: 'LCP',
  INTERACTION_TO_NEXT_PAINT: 'INP',
  CUMULATIVE_LAYOUT_SHIFT_SCORE: 'CLS',
  FIRST_CONTENTFUL_PAINT_MS: 'FCP',
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: 'TTFB'
};

// Lighthouse lab audit id → our short name
const PSI_LAB_AUDITS = {
  'largest-contentful-paint': 'LCP',
  'cumulative-layout-shift': 'CLS',
  'first-contentful-paint': 'FCP',
  'total-blocking-time': 'TBT',
  'speed-index': 'SI',
  'interactive': 'TTI'
};

function psiLabMetric(audit) {
  if (!audit) return null;
  return { value: audit.numericValue != null ? audit.numericValue : null, display: audit.displayValue || null };
}

// Diagnostics worth surfacing: audits that explain WHY the metrics are slow.
// Opportunities (details.type === 'opportunity') are picked up separately, so
// anything that turns out to be one is skipped here to avoid duplicates.
const PSI_DIAGNOSTIC_IDS = [
  'server-response-time', 'uses-long-cache-ttl', 'total-byte-weight', 'dom-size',
  'mainthread-work-breakdown', 'bootup-time', 'third-party-summary', 'font-display',
  'critical-request-chains', 'long-tasks', 'unsized-images', 'non-composited-animations',
  'duplicated-javascript', 'legacy-javascript', 'resource-summary', 'network-rtt',
  'network-server-latency', 'uses-passive-event-listeners', 'no-document-write'
];

// Lighthouse detail values are wildly polymorphic (strings, {text,url} links,
// node objects, numbers) and the shapes drift between Lighthouse versions, so
// every extractor below is deliberately defensive and returns null rather than
// assuming a shape.
function psiText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return v.text || v.url || v.name || null;
  return null;
}
function psiNodeOf(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.node && typeof item.node === 'object') return item.node;
  return null;
}
function psiClip(s, n) { return s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n); }

// Lighthouse descriptions are markdown with links — strip to plain prose.
function psiDesc(d) {
  if (!d) return null;
  return psiClip(String(d).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, ''), 400);
}

// Collapse one detail row into { label, snippet, selector, bytes, ms, ... }.
function psiNormItem(item) {
  if (!item || typeof item !== 'object') return null;
  const node = psiNodeOf(item);
  const label = psiText(item.url)
    || (node && (node.nodeLabel || node.snippet))
    || psiText(item.entity) || psiText(item.groupLabel) || psiText(item.statistic)
    || psiText(item.label) || (item.source ? psiText(item.source) : null);

  const out = {};
  if (label) out.label = psiClip(label, 240);
  if (node && node.snippet) out.snippet = psiClip(node.snippet, 240);
  if (node && node.selector) out.selector = psiClip(node.selector, 160);

  const bytes = item.wastedBytes != null ? item.wastedBytes
    : item.totalBytes != null ? item.totalBytes : item.transferSize;
  if (typeof bytes === 'number' && bytes > 0) out.bytes = Math.round(bytes);

  const ms = item.wastedMs != null ? item.wastedMs
    : item.blockingTime != null ? item.blockingTime
    : item.mainThreadTime != null ? item.mainThreadTime
    : item.duration != null ? item.duration : item.total;
  if (typeof ms === 'number' && ms > 0) out.ms = Math.round(ms);

  if (typeof item.cacheLifetimeMs === 'number') out.cacheMs = item.cacheLifetimeMs;
  if (typeof item.score === 'number') out.score = item.score;
  if (item.value != null && typeof item.value !== 'object') out.value = psiClip(item.value, 60);

  return (out.label || out.snippet) ? out : null;
}

// details.items, flattened — 'list' details (e.g. the LCP-element audit) nest
// their real rows inside child tables one level down.
function psiItemsOf(details, cap = 8) {
  if (!details || !Array.isArray(details.items)) return [];
  const flat = [];
  details.items.forEach(it => {
    if (it && Array.isArray(it.items)) flat.push(...it.items);
    else flat.push(it);
  });
  return flat.map(psiNormItem).filter(Boolean).slice(0, cap);
}

function psiTrimAudit(audit, itemCap = 8) {
  if (!audit) return null;
  return {
    id: audit.id,
    title: audit.title,
    description: psiDesc(audit.description),
    display: audit.displayValue || null,
    score: audit.score != null ? audit.score : null,
    // Per-metric savings estimate (Lighthouse 10+), e.g. { LCP: 1200, FCP: 300 }
    savings: (audit.metricSavings && typeof audit.metricSavings === 'object') ? audit.metricSavings : null,
    items: psiItemsOf(audit.details, itemCap)
  };
}

// Which audits are attributed to which metric — the same mapping the PSI site
// uses for its "Show audits relevant to…" filter. Built from two sources so it
// survives version drift: the category's auditRefs[].relevantAudits (keyed by
// metric acronym), plus each audit's own metricSavings keys (LH 10+).
function psiMetricAudits(perf, audits) {
  const map = {};
  const add = (metric, id) => {
    if (!metric || !id) return;
    if (!map[metric]) map[metric] = [];
    if (!map[metric].includes(id)) map[metric].push(id);
  };

  ((perf && perf.auditRefs) || []).forEach(ref => {
    if (ref && ref.acronym && Array.isArray(ref.relevantAudits)) {
      ref.relevantAudits.forEach(id => add(ref.acronym, id));
    }
  });

  Object.values(audits || {}).forEach(a => {
    if (!a || !a.metricSavings || typeof a.metricSavings !== 'object') return;
    Object.keys(a.metricSavings).forEach(m => {
      if (typeof a.metricSavings[m] === 'number' && a.metricSavings[m] > 0) add(m, a.id);
    });
  });

  return map;
}

// The first node found in an audit's details, at either nesting level — used
// for the LCP element, whose details shape has moved around across versions.
function psiFirstNode(audit) {
  if (!audit || !audit.details || !Array.isArray(audit.details.items)) return null;
  const scan = (rows) => {
    for (const r of rows || []) {
      const n = psiNodeOf(r);
      if (n) return n;
      if (r && Array.isArray(r.items)) { const inner = scan(r.items); if (inner) return inner; }
    }
    return null;
  };
  const node = scan(audit.details.items);
  if (!node) return null;
  return {
    snippet: psiClip(node.snippet, 300),
    selector: psiClip(node.selector, 200),
    label: psiClip(node.nodeLabel, 200)
  };
}

async function psiGetPageSpeed({ url, strategy = 'mobile', cacheOnly = false, forceRefresh = false }) {
  if (!url) return { error: 'BAD_URL' };
  const strat = strategy === 'desktop' ? 'desktop' : 'mobile';

  const { psiApiKey } = await browser.storage.local.get('psiApiKey');
  if (!psiApiKey) return { error: 'NO_PSI_KEY' };

  const key = `${strat}::${url}`;
  const { psiCache } = await browser.storage.local.get('psiCache');
  const cache = psiCache || {};
  const cached = cache[key];
  if (cached && !forceRefresh && (Date.now() - cached.fetchedAt < PSI_TTL_MS)) return { ...cached, fromCache: true };
  // Overview loads pass cacheOnly so a page view never triggers a live (slow,
  // quota-costing) PSI run — that happens only when the panel opens / refreshes.
  if (cacheOnly) return { notCached: true };

  const endpoint = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    + `?url=${encodeURIComponent(url)}&strategy=${strat}&category=performance&key=${encodeURIComponent(psiApiKey)}`;

  let data;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = body && body.error && body.error.message;
      if (res.status === 400 || res.status === 403) return { error: 'BAD_KEY', detail };
      if (res.status === 429) return { error: 'RATE_LIMITED', detail };
      return { error: 'API_ERROR', detail };
    }
    data = await res.json();
  } catch {
    return { error: 'NETWORK' };
  }

  // Lighthouse lab
  const lh = data.lighthouseResult || {};
  const audits = lh.audits || {};
  const perf = lh.categories && lh.categories.performance;
  const performanceScore = (perf && perf.score != null) ? Math.round(perf.score * 100) : null;

  const lab = {};
  Object.keys(PSI_LAB_AUDITS).forEach(id => { lab[PSI_LAB_AUDITS[id]] = psiLabMetric(audits[id]); });

  // CrUX field data (page-level, falling back to origin). category = FAST/AVERAGE/SLOW.
  const le = data.loadingExperience || {};
  let field = null;
  if (le.metrics && Object.keys(le.metrics).length) {
    const metrics = {};
    Object.keys(PSI_FIELD_KEYS).forEach(cruxKey => {
      const m = le.metrics[cruxKey];
      if (m) metrics[PSI_FIELD_KEYS[cruxKey]] = { p: m.percentile != null ? m.percentile : null, category: m.category || null };
    });
    field = {
      overall: le.overall_category || null,
      origin: !!le.origin_fallback,
      metrics
    };
  }

  // Opportunities: audits with a savings estimate, biggest first. Each keeps
  // its own item list — the actual offending resources, which is the part that
  // makes the score actionable.
  const oppAudits = Object.values(audits)
    .filter(a => a && a.details && a.details.type === 'opportunity'
      && (a.details.overallSavingsMs > 0 || a.details.overallSavingsBytes > 0))
    .sort((a, b) => (b.details.overallSavingsMs || 0) - (a.details.overallSavingsMs || 0))
    .slice(0, 8);
  const oppIds = new Set(oppAudits.map(a => a.id));
  const opportunities = oppAudits.map(a => ({
    ...psiTrimAudit(a),
    ms: Math.round(a.details.overallSavingsMs || 0),
    bytes: Math.round(a.details.overallSavingsBytes || 0)
  }));

  // Diagnostics: the "why", for audits that aren't framed as savings. Skip
  // anything already listed as an opportunity, and anything fully passing with
  // nothing to show.
  const diagnostics = PSI_DIAGNOSTIC_IDS
    .filter(id => !oppIds.has(id))
    .map(id => audits[id])
    .filter(a => a && (a.score == null || a.score < 1 || (a.details && a.details.items && a.details.items.length)))
    .map(a => psiTrimAudit(a, 6))
    .filter(a => a && (a.items.length || a.display));

  // The specific element Google measured as the LCP, and the elements that
  // actually shifted — the two most useful "what do I fix" pointers.
  const lcpElement = psiFirstNode(audits['largest-contentful-paint-element']);
  const clsElements = psiItemsOf((audits['layout-shift-elements'] || {}).details, 5);

  // Metric → relevant audit ids, so the panel can filter the breakdown down to
  // just what's hurting a given metric.
  const metricAudits = psiMetricAudits(perf, audits);

  const entry = {
    url, strategy: strat, finalUrl: lh.finalUrl || url,
    performanceScore, field, lab,
    opportunities, diagnostics, lcpElement, clsElements, metricAudits,
    fetchedAt: Date.now()
  };

  cache[key] = entry;
  const keys = Object.keys(cache);
  if (keys.length > 30) {
    keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
    keys.slice(0, keys.length - 30).forEach(k => delete cache[k]);
  }
  await browser.storage.local.set({ psiCache: cache });
  return entry;
}

// ─── Favicon: live reachability check + site-scoped cache "torch" ─────────────

const FAVICON_FETCH_TIMEOUT_MS = 8000;

// Read the intrinsic width/height out of raw SVG markup (width/height attrs, or
// the viewBox as a fallback). Returns null when the SVG is purely scalable.
function faviconSvgDimensions(text) {
  const tag = (text || '').match(/<svg[^>]*>/i);
  if (!tag) return null;
  const s = tag[0];
  const w = s.match(/\bwidth\s*=\s*["']?\s*([\d.]+)/i);
  const h = s.match(/\bheight\s*=\s*["']?\s*([\d.]+)/i);
  if (w && h) return { width: Math.round(+w[1]), height: Math.round(+h[1]) };
  const vb = s.match(/viewBox\s*=\s*["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/i);
  if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]) };
  return null;
}

// Parse a raw .ico file's ICONDIR to list every embedded image's pixel size.
// ICO is a simple binary container (no library needed): a 6-byte header
// (reserved, type, count) followed by `count` 16-byte directory entries whose
// first two bytes are width/height (0 means 256, per the spec).
function faviconIcoSizes(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 6 || view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return [];
    const count = view.getUint16(4, true);
    const sizes = [];
    for (let i = 0; i < count && 6 + i * 16 + 2 <= view.byteLength; i++) {
      const off = 6 + i * 16;
      const w = view.getUint8(off) || 256;
      const h = view.getUint8(off + 1) || 256;
      sizes.push({ width: w, height: h });
    }
    return sizes;
  } catch { return []; }
}

// Fetch one URL and report status, whether it's a real image, its actual pixel
// dimensions, and (for .ico files) every size embedded in the container. Never
// throws.
async function faviconProbe(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FAVICON_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: abort.signal });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const isSvg = /svg/.test(contentType) || /\.svg(\?|$)/i.test(url);
    const isIco = !isSvg && (/\.ico(\?|$)/i.test(url) || /(^|[/.\s-])icon\b|vnd\.microsoft\.icon/.test(contentType));
    const isImage = /^\s*image\//.test(contentType) || isIco;
    const out = { url, ok: res.ok, status: res.status, contentType, isImage, width: null, height: null, scalable: false, icoSizes: null };

    if (res.ok) {
      try {
        if (isSvg) {
          out.scalable = true;
          const dims = faviconSvgDimensions(await res.text());
          if (dims) { out.width = dims.width; out.height = dims.height; }
        } else {
          const buf = await res.arrayBuffer();
          if (isIco) {
            const sizes = faviconIcoSizes(buf);
            if (sizes.length) {
              out.icoSizes = sizes;
              const largest = sizes.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
              out.width = largest.width; out.height = largest.height;
            }
          }
          if (!out.width) {
            const bmp = await createImageBitmap(new Blob([buf], { type: contentType || 'image/x-icon' }));
            out.width = bmp.width; out.height = bmp.height;
            bmp.close();
          }
        }
      } catch { /* measurement failed — status/type still reported */ }
    }
    return out;
  } catch (err) {
    return { url, ok: false, status: 0, contentType: '', isImage: false, width: null, height: null, scalable: false, icoSizes: null, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Link health overlay: check many links' destination status ───────────────
// The content-script overlay sends every unique on-page http(s) link here; we
// fetch each from the background (page CORS can't read cross-origin status, but
// the *://*/* host permission lets us) and report whether it redirects or is
// broken. Lightweight: HEAD with redirect:follow gives the FINAL status +
// Response.redirected + Response.url without downloading a body; deeper hop
// tracing already lives in the Redirect tab (traceUrl).
const LINK_CHECK_TIMEOUT_MS = 8000;
const LINK_CHECK_CONCURRENCY = 6;    // small pool — a page can have 100+ links
const LINK_CHECK_MAX = 300;          // cap per request
const LINK_CACHE_TTL_MS = 5 * 60 * 1000;
// Deliberately NOT mirrored to storage.session, unlike redirectByTab. This is
// a pure cache with a 5-minute TTL: losing it to a service-worker restart
// costs a re-probe, never correctness. Persisting it would mean a storage
// write per probed URL (up to 300 per sweep) to save work that expires in
// minutes anyway — worse than the problem.
const linkStatusCache = new Map();   // url -> { status, redirected, finalUrl, error, fetchedAt }

// Bounded-concurrency map: run `worker` over `items`, at most `limit` at a time.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// Probe one URL's final status. Never throws. HEAD first (no body); fall back
// to GET when HEAD is rejected (405/501) or errors, cancelling the body stream
// as soon as the status is read.
async function probeLinkStatus(url) {
  const cached = linkStatusCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < LINK_CACHE_TTL_MS) {
    return { status: cached.status, redirected: cached.redirected, finalUrl: cached.finalUrl, error: cached.error };
  }

  const attempt = async (method) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LINK_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, redirect: 'follow', cache: 'no-store', credentials: 'omit', signal: abort.signal });
      if (method === 'GET') { try { await res.body?.cancel(); } catch { /* ignore */ } }
      return { status: res.status, redirected: res.redirected, finalUrl: res.url || url, error: null };
    } catch (err) {
      return { status: 0, redirected: false, finalUrl: url, error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  };

  let out = await attempt('HEAD');
  // Many servers reject HEAD (405/501) or mishandle it — retry with GET.
  if (out.status === 405 || out.status === 501 || out.status === 0) {
    const viaGet = await attempt('GET');
    if (viaGet.status !== 0) out = viaGet;      // keep GET only if it actually got a status
    else if (out.status === 0) out = viaGet;    // both failed — report the GET error
  }

  linkStatusCache.set(url, { ...out, fetchedAt: Date.now() });
  if (linkStatusCache.size > 1000) {
    const oldest = [...linkStatusCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt).slice(0, linkStatusCache.size - 1000);
    oldest.forEach(([k]) => linkStatusCache.delete(k));
  }
  return out;
}

// Chrome terminates an idle service worker after ~30s. Touching an extension
// API resets that timer, so long-running work holds the worker open by pinging
// one on an interval. Returns a stop function; always call it in a `finally`,
// or the worker is pinned awake for the rest of the browsing session.
//
// Firefox's event page suspends far less aggressively and the existing
// behaviour there is fine, so this is Chromium-only.
function keepWorkerAlive() {
  if (!IS_CHROMIUM_BG) return () => {};
  const timer = setInterval(() => {
    browser.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  return () => clearInterval(timer);
}

async function checkLinkStatuses({ urls }) {
  const list = [...new Set((urls || []).filter(u => /^https?:\/\//i.test(u)))].slice(0, LINK_CHECK_MAX);
  // Worst case this runs for minutes: 300 URLs, 6 at a time, an 8s timeout
  // each. The content script waits on it with a plain sendMessage and no
  // timeout of its own, so a worker killed mid-sweep leaves the link overlay
  // blank forever rather than surfacing an error.
  const stopKeepAlive = keepWorkerAlive();
  try {
    const probed = await runPool(list, LINK_CHECK_CONCURRENCY, probeLinkStatus);
    const results = {};
    list.forEach((u, i) => { results[u] = probed[i]; });
    return { results };
  } finally {
    stopKeepAlive();
  }
}

// Live-check every declared icon URL (+ the legacy /favicon.ico) and parse the
// web app manifest for its icon set. All best-effort; a failed fetch just
// reports status 0.
async function validateFavicon({ icons, manifestHref, defaultIcoUrl }) {
  const urls = [];
  (icons || []).forEach(i => { if (i && i.href && !urls.includes(i.href)) urls.push(i.href); });
  if (defaultIcoUrl && !urls.includes(defaultIcoUrl)) urls.push(defaultIcoUrl);

  const probes = await Promise.all(urls.map(u => faviconProbe(u)));
  const results = {};
  probes.forEach(p => { results[p.url] = p; });

  let manifest = null;
  if (manifestHref) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), FAVICON_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(manifestHref, { cache: 'no-store', credentials: 'omit', signal: abort.signal });
      if (res.ok) {
        const m = await res.json();
        const micons = (Array.isArray(m.icons) ? m.icons : []).map(ic => {
          let href = '';
          try { href = new URL(ic.src, manifestHref).href; } catch { href = ic.src || ''; }
          const sizes = String(ic.sizes || '').trim().toLowerCase();
          return { href, sizes, type: String(ic.type || '').trim().toLowerCase() };
        });
        const hasSize = (dim) => micons.some(ic => ic.sizes.split(/\s+/).includes(dim));
        manifest = {
          ok: true, icons: micons, has192: hasSize('192x192'), has512: hasSize('512x512'),
          name: (m.name || '').trim() || null,
          shortName: (m.short_name || '').trim() || null,
          backgroundColor: (m.background_color || '').trim() || null,
          themeColor: (m.theme_color || '').trim() || null
        };
      } else {
        manifest = { ok: false, icons: [], has192: false, has512: false, status: res.status };
      }
    } catch (err) {
      manifest = { ok: false, icons: [], has192: false, has512: false, error: String((err && err.message) || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { results, manifest };
}

// "Torch" this site's favicon: re-fetch each favicon URL with cache:'reload' so
// the browser replaces exactly those HTTP-cache entries with fresh copies
// (site-scoped — other sites are untouched), then hard-reload the tab bypassing
// cache so Firefox re-requests and re-paints the new favicon. Uses only fetch +
// tabs, so no browsingData permission is required.
async function clearFaviconCache({ tabId, urls }) {
  await Promise.all((urls || []).map(u =>
    fetch(u, { cache: 'reload', credentials: 'omit' }).catch(() => {})
  ));
  if (tabId != null) {
    try { await browser.tabs.reload(tabId, { bypassCache: true }); } catch { /* tab gone — ignore */ }
  }
  return { ok: true };
}
