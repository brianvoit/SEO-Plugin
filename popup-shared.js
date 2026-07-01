// Loaded as a classic (non-module) script — declarations below are shared
// globals across all popup-*.js files via the script order in popup.html.

// ─── Claude model IDs ─────────────────────────────────────────────────────────
// Update here when Anthropic releases new versions; every call in the extension
// picks up the change automatically.
const MODEL_LIGHT = 'claude-haiku-4-5-20251001'; // classification, generation, schema suggestions
const MODEL_MID   = 'claude-sonnet-4-6';          // ad copy, negatives, enforce-limits
const MODEL_HEAVY = 'claude-opus-4-8';             // action plan (reasoning-heavy synthesis)

const DEFAULT_RANGES = {
  title: { min: 30, target: 55, max: 70 },
  meta:  { min: 70, target: 155, max: 160 }
};

// Cached after load; used in every render
let charRanges = DEFAULT_RANGES;

let metaExpanded = false;

// Most recently loaded page data, used as context for AI generation and GSC query chips
let pageData = null;

// Per-domain branded-query regex patterns, keyed by hostname
let allBrandedTerms = {};

// Structured data found on the page, used by the schema detail panel
let _schemas = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ─── Timeout-guarded network helpers ─────────────────────────────────────────
// Firefox can suspend the background event page after ~30s idle. If that
// happens mid-request — most likely when the sidebar or a pop-out window has
// been left open for a long time — a plain sendMessage (or a stalled fetch)
// can hang forever with no resolution or rejection, leaving whatever "…busy"
// UI state was showing stuck indefinitely. Every background message and every
// direct Claude call goes through one of these two wrappers so that can't
// happen — a stuck request now fails with a clear error after a bounded time
// instead of hanging silently.

async function sendMessageWithTimeout(message, timeoutMs = 30000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The extension background didn\'t respond in time — try again.')), timeoutMs);
  });
  try {
    return await Promise.race([browser.runtime.sendMessage(message), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Performs the full Claude Messages API round trip — fetch, status check,
// AND body parse — and returns the parsed response body directly. The abort
// timer stays armed for the entire round trip, not just the initial fetch()
// call: fetch()'s promise resolves as soon as headers arrive, so a timer
// cleared at that point wouldn't catch a response whose BODY then stalls
// mid-stream. Doing the json() read inside the same guarded scope closes
// that gap — the whole thing throws after timeoutMs no matter which part
// of the request/response actually stalled.
async function claudeFetch(options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { ...options, signal: controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Claude request timed out — try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Build an SVG element (e.g. an icon, or a whole chart) from a markup string
// without using innerHTML. DOMParser is not flagged by the AMO linter, and the
// markup we pass is always numeric/escaped, so this is safe.
function svgFromString(markup) {
  // image/svg+xml parsing needs the SVG namespace on the root, or elements land
  // in the null namespace and won't render — inject it when absent.
  if (!/\sxmlns=/.test(markup)) {
    markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

// Create a namespaced SVG element with attributes (+ optional text content)
function svgEl(name, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (text != null) el.textContent = text;
  return el;
}

function flashCopyBtn(btn) {
  const iconCopy  = btn.querySelector('.icon-copy');
  const iconCheck = btn.querySelector('.icon-check');
  iconCopy.classList.add('hidden');
  iconCheck.classList.remove('hidden');
  setTimeout(() => {
    iconCopy.classList.remove('hidden');
    iconCheck.classList.add('hidden');
  }, 900);
}

function countColorClass(count, ranges) {
  const { min, target, max } = ranges;
  if (count < min || count > max) return 'is-count-red';
  if (count < target) return 'is-count-amber';
  return 'is-count-green';
}

function formatDate(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return str; }
}

function appendIndexRow(list, level, text) {
  const row  = document.createElement('div');
  row.className = `index-row index-row--${level}`;
  const dot  = document.createElement('span');
  dot.className = 'index-dot';
  const label = document.createElement('span');
  label.className = 'index-text';
  label.textContent = text;
  row.appendChild(dot);
  row.appendChild(label);
  list.appendChild(row);
}

// Combined INDEXABILITY section (Overview tab). Row 1 merges the on-page
// verdict with Google's coverage ("Indexable / Indexed"); row 2 is the last
// crawl date. renderIndexability (on-page) and renderGscInspection (GSC) each
// update the shared state below, then call this to repaint.
let _idxOnPage = null;    // { level, text }
let _idxGsc = undefined;  // undefined = not loaded; null = unavailable; or { coverage:{level,text}, crawl:{level,text} }

const _IDX_ORDER = { ok: 0, warning: 1, error: 2 };

function renderIndexabilitySection() {
  const statusList = document.getElementById('indexability-list');
  const crawlList  = document.getElementById('gsc-inspection-list');
  statusList.innerHTML = '';
  crawlList.innerHTML = '';
  if (!_idxOnPage) return;

  // Row 1: on-page verdict, plus Google coverage when available. Each segment
  // keeps its own colour; the leading dot reflects the worst of them.
  const segs = [_idxOnPage];
  if (_idxGsc && _idxGsc.coverage) segs.push(_idxGsc.coverage);
  const worst = segs.reduce((w, s) => (_IDX_ORDER[s.level] > _IDX_ORDER[w] ? s.level : w), 'ok');

  const row = document.createElement('div');
  row.className = `index-row index-row--${worst}`;
  const dot = document.createElement('span');
  dot.className = 'index-dot';
  row.appendChild(dot);
  const text = document.createElement('span');
  text.className = 'index-text';
  segs.forEach((s, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'index-sep';
      sep.textContent = ' / ';
      text.appendChild(sep);
    }
    const seg = document.createElement('span');
    seg.className = `index-seg index-seg--${s.level}`;
    seg.textContent = s.text;
    text.appendChild(seg);
  });
  row.appendChild(text);
  statusList.appendChild(row);

  // Row 2: last crawled (green when within 30 days, amber otherwise)
  if (_idxGsc && _idxGsc.crawl) {
    appendIndexRow(crawlList, _idxGsc.crawl.level, _idxGsc.crawl.text);
  }
}

async function getActiveTab() {
  // In the pop-out window, "current window" is the pop-out itself — ask the
  // background for the active tab of the last focused normal browser window.
  if (document.body.classList.contains('embed-window')) {
    try {
      const tab = await sendMessageWithTimeout({ action: 'getTargetTab' });
      if (tab) return tab;
    } catch { /* fall back to the regular query */ }
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Small trash button used to unlink a domain from its chosen property/account
// (clears the per-domain override; the Google account stays connected).
function propertyTrashButton(title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'gsc-property-trash icon-btn';
  btn.title = title || 'Unlink this domain';
  btn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11"/><path d="M6 4V2.8a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8V4"/><path d="M3.6 4l.6 8.5a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.4 4"/><line x1="6.6" y1="6.4" x2="6.8" y2="11"/><line x1="9.4" y1="6.4" x2="9.2" y2="11"/></svg>'));
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}
