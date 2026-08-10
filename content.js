// Content scripts run in the page context and cannot access popup-shared.js globals.

// Idempotency guard: this file can be injected both by the manifest
// (auto-injection at document_idle) AND on demand by the background's
// injectContentScript (for tabs already open before the extension loaded).
// Running it twice in the same page would throw "redeclaration of const" on
// the first declaration and abort. The whole script is wrapped so a second
// injection is a clean no-op — the first-registered message listener keeps
// serving. The sentinel lives on window (page context), cleared on every
// navigation, so a fresh page load always re-runs this cleanly.
if (!window.__seoInspectorContentLoaded) {
window.__seoInspectorContentLoaded = true;

// Update this when the model tier used for alt-text generation changes.
const CONTENT_MODEL_LIGHT = 'claude-haiku-4-5-20251001';

const OVERLAY_ATTR  = 'data-seo-overlay';
const CONTAINER_ID  = 'seo-inspector-overlay';
const TOOLTIP_ID    = 'seo-inspector-tooltip';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Page data ───────────────────────────────────────────────────────────────

function getCleanBodyText() {
  const clone = document.body.cloneNode(true);
  ['script','style','noscript','nav','header','footer','aside'].forEach(tag =>
    clone.querySelectorAll(tag).forEach(el => el.remove())
  );
  ['navigation','banner','contentinfo','complementary'].forEach(role =>
    clone.querySelectorAll(`[role="${role}"]`).forEach(el => el.remove())
  );
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function getBodyWordCount(bodyText) {
  return bodyText ? bodyText.split(' ').filter(Boolean).length : 0;
}

function getIndexability() {
  const robotsMeta    = document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '';
  const googlebotMeta = document.querySelector('meta[name="googlebot"]')?.getAttribute('content') ?? '';
  const combined      = (robotsMeta + ',' + googlebotMeta).toLowerCase();

  const noindex  = combined.includes('noindex');
  const nofollow = combined.includes('nofollow');

  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
  let canonicalAbsolute = null;
  if (canonicalHref) {
    try { canonicalAbsolute = new URL(canonicalHref, window.location.href).href; } catch { canonicalAbsolute = canonicalHref; }
  }

  const norm = url => url.replace(/\/$/, '').split('#')[0];
  const canonicalMismatch = !!(canonicalAbsolute && norm(canonicalAbsolute) !== norm(window.location.href));

  return { noindex, nofollow, canonicalMismatch, canonicalUrl: canonicalAbsolute, robotsMeta: robotsMeta || null };
}

function getOpenGraph() {
  const og = {}, twitter = {};
  document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]').forEach(m => {
    const key = m.getAttribute('property') || m.getAttribute('name');
    if (key) og[key] = m.getAttribute('content') ?? '';
  });
  document.querySelectorAll('meta[name^="twitter:"]').forEach(m => {
    const key = m.getAttribute('name');
    if (key) twitter[key] = m.getAttribute('content') ?? '';
  });
  return { og, twitter };
}

function getStructuredData() {
  const schemas = [];
  let invalid = 0;
  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    const raw = script.textContent.trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const items  = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      schemas.push(...items.filter(item => item && item['@type']));
    } catch { invalid++; }
  });
  return { schemas, invalid };
}

function getDates() {
  let published = null, modified = null;

  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      const parsed = JSON.parse(script.textContent);
      const items  = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      items.forEach(item => {
        if (!item) return;
        if (item.datePublished && !published) published = item.datePublished;
        if (item.dateModified  && !modified)  modified  = item.dateModified;
      });
    } catch { /* invalid JSON-LD */ }
  });

  if (!published) published =
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
    document.querySelector('meta[name="date"]')?.getAttribute('content') ?? null;

  if (!modified) modified =
    document.querySelector('meta[property="article:modified_time"]')?.getAttribute('content') ??
    document.querySelector('meta[name="last-modified"]')?.getAttribute('content') ?? null;

  return { published, modified };
}

// Body-content links: skip nav/header/footer/aside elements.
// Uses closest() which is O(depth) but simple and correct.
function isBodyContent(el) {
  return !el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]');
}

function getHreflang() {
  const tags = [];
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(el => {
    const lang = (el.getAttribute('hreflang') || '').trim().toLowerCase();
    const href = el.href || '';
    if (lang) tags.push({ lang, href });
  });
  const pageLanguage = (document.documentElement.getAttribute('lang') || '').trim().toLowerCase() || null;
  return { tags, pageLanguage };
}

function getFavicon() {
  const icons = [];
  document.querySelectorAll(
    'link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]'
  ).forEach(el => {
    const rel   = (el.getAttribute('rel')   || '').trim().toLowerCase();
    const href  = el.href || '';                                // resolved absolute
    const type  = (el.getAttribute('type')  || '').trim().toLowerCase();
    const sizes = (el.getAttribute('sizes') || '').trim().toLowerCase();
    if (href) icons.push({ rel, href, type, sizes });
  });
  const manEl = document.querySelector('link[rel="manifest"]');
  let origin = '';
  try { origin = new URL(document.baseURI).origin; } catch { /* ignore */ }
  const titleEl = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  return {
    icons,
    manifestHref: manEl ? (manEl.href || null) : null,
    defaultIcoUrl: origin ? origin + '/favicon.ico' : null,     // legacy fallback probe
    appleWebAppTitle: titleEl ? (titleEl.getAttribute('content') || '').trim() || null : null
  };
}

function getInternalLinks() {
  const seen = new Set();
  const links = [];
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('a[href]').forEach(a => {
    if (!isBodyContent(a)) return;
    let normalized;
    try {
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      normalized = url.pathname.replace(/\/$/, '') || '/';
      if (normalized === currentPath) return;
    } catch { return; }
    const text = (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) return;
    const key = `${normalized}::${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ href: normalized, text });
  });
  return links.slice(0, 30);
}

function getExternalLinkCount() {
  let count = 0;
  document.querySelectorAll('a[href]').forEach(a => {
    if (!isBodyContent(a)) return;
    try {
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) count++;
    } catch { /* skip */ }
  });
  return count;
}

// A <meta http-equiv="refresh" content="0; url=..."> is a client-side redirect
// that webRequest can't see, so the popup flags it from the page itself.
function getMetaRefresh() {
  const el = document.querySelector('meta[http-equiv="refresh" i]');
  const content = el && el.getAttribute('content');
  if (!content) return null;
  const m = /^\s*(\d+)\s*;\s*url\s*=\s*(.+?)\s*$/i.exec(content);
  if (!m) return null;
  return { delay: parseInt(m[1], 10), url: m[2].replace(/^['"]|['"]$/g, '') };
}

// GA4 measurement IDs (G-XXXXXXXX) used on the page — from the gtag.js script
// src and inline gtag('config', …) calls. Used to suggest the matching GA4
// property in the Analytics picker.
function getGaMeasurementIds() {
  const ids = new Set();
  document.querySelectorAll('script[src]').forEach(s => {
    const m = /[?&]id=(G-[A-Z0-9]+)/i.exec(s.src);
    if (m) ids.add(m[1].toUpperCase());
  });
  document.querySelectorAll('script:not([src])').forEach(s => {
    const re = /G-[A-Z0-9]{6,}/gi;
    let m;
    while ((m = re.exec(s.textContent || ''))) ids.add(m[0].toUpperCase());
  });
  return Array.from(ids).slice(0, 10);
}

function getPageData() {
  const titleEl     = document.querySelector('title');
  const titleText   = titleEl ? titleEl.textContent.trim() : '';
  const metaEl      = document.querySelector('meta[name="description"]');
  const metaContent = metaEl ? metaEl.getAttribute('content') : null;

  const headings = Array.from(
    document.querySelectorAll('h1, h2, h3, h4, h5')
  ).map(el => ({
    tag:  el.tagName.toLowerCase(),
    text: el.textContent.trim().replace(/\s+/g, ' ')
  }));

  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const canonical   = canonicalEl ? canonicalEl.getAttribute('href') : null;

  const bodyText = getCleanBodyText();
  const sd = getStructuredData();
  const hl = getHreflang();

  return {
    metaRefresh: getMetaRefresh(),
    title: { text: titleText, charCount: titleText.length, wordCount: wordCount(titleText) },
    metaDescription: metaContent !== null
      ? { text: metaContent, charCount: metaContent.length, wordCount: wordCount(metaContent) }
      : null,
    headings,
    canonical,
    bodyWordCount:    getBodyWordCount(bodyText),
    bodyTextExcerpt:  bodyText.slice(0, 1000),
    indexability:     getIndexability(),
    openGraph:        getOpenGraph(),
    structuredData:        sd.schemas,
    structuredDataInvalid: sd.invalid,
    dates:            getDates(),
    gaMeasurementIds: getGaMeasurementIds(),
    hreflang:         hl.tags,
    pageLanguage:     hl.pageLanguage,
    favicon:          getFavicon(),
    internalLinks:    getInternalLinks(),
    externalLinkCount: getExternalLinkCount()
  };
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function getTooltip() {
  let tt = document.getElementById(TOOLTIP_ID);
  if (!tt) {
    tt = document.createElement('div');
    tt.id = TOOLTIP_ID;
    tt.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'background:rgba(15,15,15,0.93)',
      'color:#fff',
      'padding:7px 11px',
      'border-radius:6px',
      'font:12px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif',
      'max-width:300px',
      'word-break:break-word',
      'white-space:pre-wrap',
      'pointer-events:none',
      'display:none',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
    ].join(';');
    document.body.appendChild(tt);
  }
  return tt;
}

function positionTooltip(tt, e) {
  const offset = 16, vw = window.innerWidth, vh = window.innerHeight;
  let left = e.clientX + offset;
  let top  = e.clientY + offset;
  if (left + 300 > vw - 8) left = e.clientX - 300 - offset;
  if (top  + 80  > vh - 8) top  = e.clientY - 80  - offset;
  tt.style.left = `${Math.max(4, left)}px`;
  tt.style.top  = `${Math.max(4, top)}px`;
}

function attachTooltip(label, tooltipText) {
  label.addEventListener('mouseover', e => {
    const tt = getTooltip();
    tt.textContent = tooltipText;
    tt.style.display = 'block';
    positionTooltip(tt, e);
  });
  label.addEventListener('mousemove', e => positionTooltip(getTooltip(), e));
  label.addEventListener('mouseout',  () => { getTooltip().style.display = 'none'; });
}

// ─── Overlay: fixed-position container, never touches page DOM structure ──────

function makeOverlayLabel(bg, statusText, tooltipText) {
  const label = document.createElement('div');
  label.setAttribute(OVERLAY_ATTR, 'true');
  label.style.cssText = [
    'position:fixed',          // positioned by applyOverlay / updatePositions
    `background:${bg}`,
    'color:#fff',
    'padding:3px 6px',
    'font:600 11px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif',
    'overflow:hidden',
    'white-space:nowrap',
    'text-overflow:ellipsis',
    'z-index:2147483647',
    'pointer-events:auto',
    'box-sizing:border-box',
    'cursor:default',
  ].join(';');
  label.textContent = statusText;
  attachTooltip(label, tooltipText);
  return label;
}

// A link's accessible name, in the same precedence order a screen reader
// would use: visible text, aria-label, aria-labelledby, title, then an inner
// image's alt text. Empty string means nothing announces anything.
function linkAccessibleText(a) {
  const visible = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
  if (visible) return visible;
  const ariaLabel = a.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  const ariaLabelledBy = a.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const t = ariaLabelledBy.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean).join(' ');
    if (t) return t;
  }
  const title = a.getAttribute('title');
  if (title && title.trim()) return title.trim();
  const imgWithAlt = a.querySelector('img[alt]:not([alt=""])');
  if (imgWithAlt) return imgWithAlt.getAttribute('alt').trim();
  return '';
}

function buildEmptyLinkLabel() {
  return makeOverlayLabel(
    'rgba(220,38,38,0.92)',
    'EMPTY LINK TEXT',
    'This link has no accessible text — screen readers announce nothing meaningful. Add visible text, an aria-label, or alt text on an inner image.'
  );
}

function buildLabel(img) {
  const hasAlt        = img.hasAttribute('alt');
  const altText       = img.getAttribute('alt') ?? '';
  const ariaLabel     = img.getAttribute('aria-label');
  const ariaLabelledBy = img.getAttribute('aria-labelledby');
  const role          = img.getAttribute('role');
  const ariaHidden    = img.getAttribute('aria-hidden');

  const isPresentational = role === 'presentation' || role === 'none';
  const isAriaHidden     = ariaHidden === 'true';
  const ariaName         = ariaLabel || (ariaLabelledBy
    ? document.getElementById(ariaLabelledBy)?.textContent?.trim()
    : null);

  let bg, statusText, tooltipText;

  if (!hasAlt && ariaName) {
    bg          = 'rgba(180,95,6,0.92)';
    statusText  = ariaName;
    tooltipText = `ARIA label only — no alt attribute\naria-label: "${ariaName}"\nAdd an alt attribute for better SEO`;
  } else if (!hasAlt) {
    bg          = 'rgba(220,38,38,0.92)';
    statusText  = 'MISSING ALT';
    tooltipText = 'No alt attribute — add one to improve accessibility and SEO';
  } else if (altText === '' && (isPresentational || isAriaHidden)) {
    const signal = isPresentational ? `role="${role}"` : 'aria-hidden="true"';
    bg          = 'rgba(100,116,139,0.92)';
    statusText  = 'Decorative';
    tooltipText = `Intentionally decorative (${signal}) — correctly hidden from screen readers`;
  } else if (altText === '') {
    bg          = 'rgba(180,95,6,0.92)';
    statusText  = 'Empty alt';
    tooltipText = 'alt="" — intent unclear. Add role="presentation" if decorative, or write real alt text';
  } else {
    bg          = 'rgba(22,163,74,0.92)';
    statusText  = altText;
    tooltipText = altText;
  }

  return makeOverlayLabel(bg, statusText, tooltipText);
}

function applyOverlay() {
  removeOverlay();

  // Transparent fixed container — sits above the page, never modifies it
  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.style.cssText = [
    'position:fixed',
    'top:0', 'left:0',
    'width:0', 'height:0',   // zero size so it captures no mouse events itself
    'overflow:visible',
    'z-index:2147483646',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(container);

  // Build one label per visible image, plus one per link with no accessible
  // text (nothing a screen reader would announce) — both share the same
  // fixed-position label + reposition-on-scroll machinery below.
  const entries = [];
  document.querySelectorAll('img').forEach(img => {
    const rect = img.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const label = buildLabel(img);
    container.appendChild(label);
    entries.push({ el: img, label });
  });
  document.querySelectorAll('a[href]').forEach(a => {
    const rect = a.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    if (linkAccessibleText(a)) return;
    const label = buildEmptyLinkLabel();
    container.appendChild(label);
    entries.push({ el: a, label });
  });

  container._entries = entries;

  // Position every label to match its element's current viewport rect
  function updatePositions() {
    entries.forEach(({ el, label }) => {
      const r = el.getBoundingClientRect();
      const offscreen = r.bottom < 0 || r.top > window.innerHeight ||
                        r.right  < 0 || r.left > window.innerWidth;
      if (offscreen || r.width < 4 || r.height < 4) {
        label.style.display = 'none';
        return;
      }
      label.style.display   = '';
      label.style.top       = `${r.top}px`;
      label.style.left      = `${r.left}px`;
      label.style.width     = `${r.width}px`;
    });
  }

  updatePositions();
  container._update = () => requestAnimationFrame(updatePositions);
  window.addEventListener('scroll', container._update, { passive: true });
  window.addEventListener('resize', container._update, { passive: true });
}

function removeOverlay() {
  const container = document.getElementById(CONTAINER_ID);
  if (container) {
    if (container._update) {
      window.removeEventListener('scroll', container._update);
      window.removeEventListener('resize', container._update);
    }
    container.remove();
  }
  const tt = document.getElementById(TOOLTIP_ID);
  if (tt) { tt.style.display = 'none'; }
}

// ─── Link health overlay ─────────────────────────────────────────────────────
// Mirrors the image overlay, but marks LINKS whose destination redirects or is
// broken. The actual status fetching happens in the background (page CORS can't
// read cross-origin status); this side collects links, requests their statuses,
// and paints a colored outline + corner dot on the problem ones only.

const LINK_OVERLAY_ATTR = 'data-seo-link-overlay';
const LINK_CONTAINER_ID = 'seo-inspector-link-overlay';
const LINK_INDICATOR_ID = 'seo-inspector-link-indicator';

const LINK_COLORS = {
  redirect:     'rgba(180,95,6,0.95)',   // amber
  broken:       'rgba(220,38,38,0.95)',  // red
  inconclusive: 'rgba(100,116,139,0.95)' // gray
};

// Collect on-page http(s) links, deduped by absolute URL (ignoring the hash),
// as a Map<url, anchorEl[]> so every anchor to one URL gets the same marker.
function collectLinks() {
  const byUrl = new Map();
  document.querySelectorAll('a[href]').forEach(a => {
    const raw = a.getAttribute('href') || '';
    if (!raw || raw.startsWith('#') || /^\s*(mailto:|tel:|javascript:)/i.test(raw)) return;
    let u;
    try { u = new URL(a.href, document.baseURI); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    // Same-page fragment link (only the hash differs from the current page)
    const here = new URL(document.baseURI);
    if (u.href.split('#')[0] === here.href.split('#')[0] && u.hash) return;
    const key = u.href.split('#')[0];
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(a);
  });
  return byUrl;
}

// Classify a background probe result → marker kind (or null = don't mark).
function linkKindFor(res) {
  if (!res) return null;
  const s = res.status;
  if (s === 401 || s === 403 || s === 429) return 'inconclusive';
  if (res.error || s === 0) return 'broken';
  if (s >= 400) return 'broken';
  if (res.redirected) return 'redirect';
  return null;   // clean 200, no redirect
}

function linkTooltipFor(kind, res) {
  if (kind === 'redirect')     return `Redirects → ${res.finalUrl}\n(final status ${res.status})`;
  if (kind === 'inconclusive') return `Inconclusive — ${res.status} (login required or bot-blocked)`;
  if (res.error)               return `Broken — ${res.error}`;
  return `Broken — status ${res.status}`;
}

// A small corner progress/summary indicator (fixed, non-interactive).
function linkIndicator(text) {
  let el = document.getElementById(LINK_INDICATOR_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = LINK_INDICATOR_ID;
    el.style.cssText = [
      'position:fixed', 'bottom:12px', 'right:12px', 'z-index:2147483647',
      'background:rgba(15,15,15,0.9)', 'color:#fff', 'padding:6px 10px',
      'border-radius:6px', 'font:600 12px/1.4 -apple-system,system-ui,sans-serif',
      'pointer-events:none', 'box-shadow:0 2px 10px rgba(0,0,0,0.35)'
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = text;
  return el;
}
function removeLinkIndicator() { document.getElementById(LINK_INDICATOR_ID)?.remove(); }

function applyLinkOverlay() {
  removeLinkOverlay();

  const container = document.createElement('div');
  container.id = LINK_CONTAINER_ID;
  container.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:0', 'height:0',
    'overflow:visible', 'z-index:2147483646', 'pointer-events:none'
  ].join(';');
  document.body.appendChild(container);
  container._entries = [];

  const byUrl = collectLinks();
  const urls = [...byUrl.keys()];
  if (!urls.length) { linkIndicator('No links to check'); setTimeout(removeLinkIndicator, 2000); return; }

  linkIndicator(`Checking ${urls.length} link${urls.length === 1 ? '' : 's'}…`);

  browser.runtime.sendMessage({ action: 'checkLinks', urls }).then(resp => {
    // No-op if the overlay was toggled off before results arrived.
    const live = document.getElementById(LINK_CONTAINER_ID);
    if (!live || live !== container) return;
    const results = (resp && resp.results) || {};

    const entries = [];
    let redirects = 0, broken = 0;
    byUrl.forEach((anchors, url) => {
      const kind = linkKindFor(results[url]);
      if (!kind) return;
      if (kind === 'redirect') redirects++;
      if (kind === 'broken') broken++;
      const tooltip = linkTooltipFor(kind, results[url]);
      anchors.forEach(anchor => {
        const outline = document.createElement('div');
        outline.setAttribute(LINK_OVERLAY_ATTR, 'true');
        outline.style.cssText = [
          'position:fixed', `outline:2px solid ${LINK_COLORS[kind]}`, 'outline-offset:1px',
          'border-radius:2px', 'box-sizing:border-box', 'pointer-events:none', 'z-index:2147483646'
        ].join(';');
        const dot = document.createElement('div');
        dot.setAttribute(LINK_OVERLAY_ATTR, 'true');
        dot.style.cssText = [
          'position:fixed', `background:${LINK_COLORS[kind]}`, 'width:10px', 'height:10px',
          'border-radius:50%', 'border:1.5px solid #fff', 'box-sizing:border-box',
          'pointer-events:auto', 'cursor:help', 'z-index:2147483647'
        ].join(';');
        attachTooltip(dot, tooltip);
        container.appendChild(outline);
        container.appendChild(dot);
        entries.push({ anchor, outline, dot });
      });
    });
    container._entries = entries;

    const parts = [];
    if (redirects) parts.push(`${redirects} redirect${redirects === 1 ? '' : 's'}`);
    if (broken) parts.push(`${broken} broken`);
    if (urls.length > 300) parts.push('checked first 300');
    linkIndicator(parts.length ? parts.join(' · ') : 'No redirect or broken links');
    setTimeout(removeLinkIndicator, 4000);

    function updatePositions() {
      entries.forEach(({ anchor, outline, dot }) => {
        const r = anchor.getBoundingClientRect();
        const offscreen = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
        if (offscreen || (r.width < 1 && r.height < 1)) {
          outline.style.display = 'none'; dot.style.display = 'none'; return;
        }
        outline.style.display = ''; dot.style.display = '';
        outline.style.top = `${r.top}px`;
        outline.style.left = `${r.left}px`;
        outline.style.width = `${r.width}px`;
        outline.style.height = `${r.height}px`;
        dot.style.top = `${r.top - 5}px`;
        dot.style.left = `${r.right - 5}px`;
      });
    }
    updatePositions();
    container._update = () => requestAnimationFrame(updatePositions);
    window.addEventListener('scroll', container._update, { passive: true });
    window.addEventListener('resize', container._update, { passive: true });
  }).catch(() => { linkIndicator('Link check failed'); setTimeout(removeLinkIndicator, 3000); });
}

function removeLinkOverlay() {
  const container = document.getElementById(LINK_CONTAINER_ID);
  if (container) {
    if (container._update) {
      window.removeEventListener('scroll', container._update);
      window.removeEventListener('resize', container._update);
    }
    container.remove();
  }
  removeLinkIndicator();
  const tt = document.getElementById(TOOLTIP_ID);
  if (tt) { tt.style.display = 'none'; }   // shared tooltip: hide only, never remove
}

// ─── Init: restore overlay if it was active before navigation ────────────────
// Top frame only. This script runs in every frame (all_frames, so the alt-text
// generator can reach images inside the block editor's iframe), and without
// this guard every ad/reCAPTCHA/embed iframe would restore and draw its own
// overlay over its own images.

const IS_TOP_FRAME = (() => {
  try { return window.top === window; } catch { return false; }   // cross-origin parent
})();

if (IS_TOP_FRAME) {
  browser.storage.local.get(['altOverlayActive', 'linkOverlayActive']).then(({ altOverlayActive, linkOverlayActive }) => {
    if (altOverlayActive) applyOverlay();
    if (linkOverlayActive) applyLinkOverlay();
  });
}

// ─── Alt text generator ──────────────────────────────────────────────────────

const GENERATOR_ID = 'seo-inspector-alt-gen';

function removeGenerator() {
  document.getElementById(GENERATOR_ID)?.remove();
}

// Create an element with inline style + optional properties (id, textContent,
// value, rows). Used to build the alt-text generator UI without innerHTML.
function sagEl(tag, style, props) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (props) Object.assign(el, props);
  return el;
}

function createGeneratorPanel(img) {
  removeGenerator();

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const c = dark ? {
    bg: '#1c1c1e', headerBg: '#2c2c2e', border: '#3a3a3c',
    text: '#f2f2f7', muted: '#98989d', inputBg: '#2c2c2e', inputBorder: '#48484a'
  } : {
    bg: '#ffffff', headerBg: '#f8f9fa', border: '#e5e7eb',
    text: '#111827', muted: '#9ca3af', inputBg: '#ffffff', inputBorder: '#d1d5db'
  };

  const rect = img.getBoundingClientRect();
  const W    = 300;
  const left = Math.min(Math.max(rect.left, 8), window.innerWidth - W - 8);
  const top  = rect.bottom + 8;

  const panel = document.createElement('div');
  panel.id = GENERATOR_ID;
  panel.style.cssText = [
    'position:fixed', `top:${top}px`, `left:${left}px`, `width:${W}px`,
    `background:${c.bg}`, `border:1px solid ${c.border}`,
    'border-radius:8px', 'box-shadow:0 4px 20px rgba(0,0,0,0.18)',
    'font:13px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif',
    `color:${c.text}`, 'z-index:2147483647', 'overflow:hidden',
  ].join(';');

  const header = sagEl('div', `display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:${c.headerBg};border-bottom:1px solid ${c.border}`);
  header.appendChild(sagEl('span', `font-size:9px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${c.muted}`, { textContent: 'Suggested Alt Text' }));
  header.appendChild(sagEl('button', `background:none;border:none;cursor:pointer;color:${c.muted};font-size:18px;line-height:1;padding:0`, { id: 'sag-close', textContent: '×' }));

  const body = sagEl('div', 'padding:10px', { id: 'sag-body' });
  body.appendChild(sagEl('span', `color:${c.muted};font-size:12px`, { textContent: 'Generating…' }));

  panel.appendChild(header);
  panel.appendChild(body);

  document.body.appendChild(panel);
  panel.querySelector('#sag-close').addEventListener('click', removeGenerator);
  panel._colors = c;

  const dismiss = e => {
    if (!panel.contains(e.target)) {
      removeGenerator();
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 200);

  return panel;
}

function showGeneratorResult(altText, usedVision, img) {
  const panel = document.getElementById(GENERATOR_ID);
  const body  = document.getElementById('sag-body');
  if (!body || !panel) return;
  const c = panel._colors;

  body.textContent = '';
  body.appendChild(sagEl('textarea',
    `width:100%;box-sizing:border-box;border:1px solid ${c.inputBorder};border-radius:5px;padding:7px 9px;font:13px/1.5 -apple-system,system-ui,sans-serif;resize:vertical;color:${c.text};background:${c.inputBg};outline:none`,
    { id: 'sag-text', rows: 3, value: altText }));

  const actions = sagEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-top:8px');
  actions.appendChild(sagEl('span', `font-size:10px;color:${c.muted}`, { textContent: usedVision ? '✦ vision' : '✦ page context' }));
  const btnWrap = sagEl('div', 'display:flex;gap:6px');
  btnWrap.appendChild(sagEl('button', 'background:#21759b;color:#fff;border:none;border-radius:4px;padding:4px 12px;font:600 12px/1.5 sans-serif;cursor:pointer', { id: 'sag-save-wp', textContent: 'Save to WP' }));
  btnWrap.appendChild(sagEl('button', 'background:#2563eb;color:#fff;border:none;border-radius:4px;padding:4px 12px;font:600 12px/1.5 sans-serif;cursor:pointer', { id: 'sag-copy', textContent: 'Copy' }));
  actions.appendChild(btnWrap);
  body.appendChild(actions);

  body.appendChild(sagEl('div', 'margin-top:7px;font-size:11px;line-height:1.4', { id: 'sag-wp-status' }));

  document.getElementById('sag-copy').addEventListener('click', () => {
    const val = document.getElementById('sag-text').value;
    navigator.clipboard.writeText(val).then(() => {
      const btn = document.getElementById('sag-copy');
      btn.textContent = 'Copied!';
      btn.style.background = '#16a34a';
      setTimeout(() => { btn.textContent = 'Copy'; btn.style.background = '#2563eb'; }, 1500);
    });
  });

  document.getElementById('sag-save-wp').addEventListener('click', () => saveAltToWordPress(img, c));
}

function showGeneratorError(msg) {
  const body = document.getElementById('sag-body');
  if (!body) return;
  body.textContent = '';
  const span = document.createElement('span');
  span.style.cssText = 'color:#dc2626;font-size:12px';
  span.textContent = msg;
  body.appendChild(span);
}

// ─── Save to WordPress ────────────────────────────────────────────────────────

function getAttachmentIdFromImg(img) {
  const cls = Array.from(img.classList).find(c => /^wp-image-\d+$/.test(c));
  return cls ? parseInt(cls.split('-').pop(), 10) : null;
}

function getBaseFilename(src) {
  const filename = src.split('/').pop().split('?')[0];
  return filename.replace(/-\d+x\d+(?=\.\w+$)/, '');
}

async function findAttachmentIdByFilename(origin, src, authHeader) {
  const filename   = getBaseFilename(src);
  const searchTerm = filename.replace(/\.[^.]+$/, '');

  const res = await fetch(`${origin}/wp-json/wp/v2/media?search=${encodeURIComponent(searchTerm)}&per_page=20`, {
    headers: { 'Authorization': authHeader }
  });
  if (!res.ok) return null;

  const items = await res.json();
  const match = items.find(item => item.source_url && getBaseFilename(item.source_url) === filename);
  return match ? match.id : null;
}

async function saveAltToWordPress(img, c) {
  const statusEl = document.getElementById('sag-wp-status');
  const btn      = document.getElementById('sag-save-wp');
  const altText  = document.getElementById('sag-text').value;

  btn.disabled = true;
  btn.textContent = 'Saving…';
  statusEl.style.color = c.muted;
  statusEl.textContent = '';

  try {
    const { wpSites } = await browser.storage.local.get('wpSites');
    const site = (wpSites ?? []).find(s => {
      try { return new URL(s.url).hostname === window.location.hostname; }
      catch { return false; }
    });

    if (!site) {
      throw new Error('No WordPress credentials for this site — add one in Settings (⚙).');
    }

    const authHeader = 'Basic ' + btoa(`${site.username}:${site.appPassword}`);
    const origin = window.location.origin;

    let attachmentId = getAttachmentIdFromImg(img);
    if (!attachmentId) {
      attachmentId = await findAttachmentIdByFilename(origin, img.currentSrc || img.src, authHeader);
    }
    if (!attachmentId) {
      throw new Error('Could not find this image in the Media Library.');
    }

    const res = await fetch(`${origin}/wp-json/wp/v2/media/${attachmentId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({ alt_text: altText })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    img.setAttribute('alt', altText);
    statusEl.style.color = '#16a34a';
    statusEl.textContent = '✓ Saved to WordPress';
    btn.textContent = 'Saved';
  } catch (err) {
    statusEl.style.color = '#dc2626';
    statusEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Save to WP';
  }
}

async function tryGetImageBase64(img) {
  const maxDim = 800;

  function drawToBase64(source, w, h) {
    const scale  = Math.min(1, maxDim / Math.max(w, h, 1));
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75).split(',')[1];
  }

  // Try 1: draw the already-loaded img element (works if same-origin or CORS-allowed)
  try {
    return { data: drawToBase64(img, img.naturalWidth, img.naturalHeight), mimeType: 'image/jpeg' };
  } catch { /* tainted canvas — cross-origin */ }

  // Try 2: fetch with CORS mode (works if the server sends CORS headers)
  try {
    const blob = await fetch(img.src, { mode: 'cors' }).then(r => r.blob());
    const bm   = await createImageBitmap(blob);
    return { data: drawToBase64(bm, bm.width, bm.height), mimeType: 'image/jpeg' };
  } catch { /* no CORS headers on the image server */ }

  return null;
}

async function generateAltText(srcUrl) {
  // Firefox reports info.srcUrl as the source actually being displayed, which
  // with srcset (WP's -scaled/-300x200 variants) is currentSrc, not src — so
  // matching on .src alone silently found nothing and the menu item did nothing.
  const imgs = Array.from(document.querySelectorAll('img'));
  const img = imgs.find(i => i.currentSrc === srcUrl)
    || imgs.find(i => i.src === srcUrl)
    || imgs.find(i => getBaseFilename(i.currentSrc || i.src || '') === getBaseFilename(srcUrl || ''));
  if (!img) return;

  createGeneratorPanel(img);

  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) {
    showGeneratorError('No Claude API key — add one in Settings (⚙).');
    return;
  }

  // Gather context
  const pageTitle = document.querySelector('title')?.textContent?.trim() ?? '';
  const pageMeta  = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  const filename  = srcUrl.split('/').pop().split('?')[0];
  const caption   = img.closest('figure')?.querySelector('figcaption')?.textContent?.trim();
  const linkText  = img.closest('a')?.textContent?.trim().replace(/\s+/g, ' ');

  // Walk up DOM for the nearest preceding heading
  let nearestHeading = '';
  let el = img.parentElement;
  for (let depth = 0; depth < 8 && el && el !== document.body; depth++) {
    let sib = el.previousElementSibling;
    while (sib) {
      const h = sib.matches('h1,h2,h3,h4,h5,h6') ? sib : sib.querySelector('h1,h2,h3,h4,h5,h6');
      if (h) { nearestHeading = h.textContent.trim(); break; }
      sib = sib.previousElementSibling;
    }
    if (nearestHeading) break;
    el = el.parentElement;
  }

  const context = [
    pageTitle      && `Page title: "${pageTitle}"`,
    pageMeta       && `Page meta description: "${pageMeta}"`,
    nearestHeading && `Nearest heading: "${nearestHeading}"`,
    caption        && `Figure caption: "${caption}"`,
    linkText       && `Link text (image is a link): "${linkText}"`,
    `Image filename: ${filename}`,
    `Current alt: ${img.hasAttribute('alt') ? `"${img.alt}"` : 'absent'}`,
  ].filter(Boolean).join('\n');

  const system = `You write concise, accurate alt text following WCAG 2.1 AA guidelines.
- Describe what the image communicates in context, not just what it depicts
- Under 125 characters
- No "Image of" or "Photo of" prefix
- If it is purely decorative, respond with exactly: [decorative]
- Return only the alt text, nothing else`;

  const imageData   = await tryGetImageBase64(img);
  const userContent = imageData
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.data } },
        { type: 'text',  text: `Generate alt text.\n\n${context}` }
      ]
    : `Generate alt text (image inaccessible — use context only).\n\n${context}`;

  // AbortController-guarded fetch — a stalled connection would otherwise hang
  // this await forever with no error, leaving the alt-text overlay stuck.
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: CONTENT_MODEL_LIGHT,
        max_tokens: 150,
        system,
        messages: [{ role: 'user', content: userContent }]
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }

    const data    = await res.json();
    const altText = data.content?.[0]?.text?.trim();
    if (!altText) throw new Error('Empty response from Claude');

    showGeneratorResult(altText, !!imageData, img);
  } catch (err) {
    showGeneratorError(err.name === 'AbortError' ? 'Error: Claude request timed out — try again.' : `Error: ${err.message}`);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

// ─── WordPress Media Library: per-field generators ───────────────────────────
// Injects a ✦ button into the Alt Text / Title / Caption / Description fields on
// the two wp-admin screens that expose all four:
//   A) the "Attachment details" modal (grid view + the editor's Add Media), a
//      Backbone view created and destroyed on the fly → needs a MutationObserver
//   B) the classic attachment edit screen (post.php?post=<id>&action=edit)
//
// Saving deliberately fills WP's own field and dispatches input/change rather
// than PATCHing the REST API: in wp-admin the user is already authenticated and
// WP persists these fields itself, so no Application Password or nonce is
// needed and we never diverge from WP's own save path.

const WPS_BTN_MARK = 'seoiWpsField';        // dataset flag → injection is idempotent

// Each field, with the selectors used on both screens. Order matters only for
// display. `max` mirrors the prompt's length ceiling.
const WPS_FIELDS = [
  {
    key: 'alt', label: 'Alt text', max: 125,
    selectors: ['#attachment-details-alt-text', '#attachment-details-two-column-alt-text', '#attachment_alt']
  },
  {
    key: 'title', label: 'Title', max: 60,
    selectors: ['#attachment-details-title', '#attachment-details-two-column-title', '#title']
  },
  {
    key: 'caption', label: 'Caption', max: 160,
    selectors: ['#attachment-details-caption', '#attachment-details-two-column-caption', '#attachment_caption']
  },
  {
    key: 'description', label: 'Description', max: 320,
    selectors: ['#attachment-details-description', '#attachment-details-two-column-description', '#attachment_content']
  }
];

function wpsIsAdmin() {
  return /\/wp-admin\//.test(window.location.pathname);
}

// #title is the generic post-title input, so only treat it as an attachment
// title once an unmistakably attachment-only field is present on the screen.
function wpsIsAttachmentScreen() {
  return !!document.querySelector('#attachment_alt, #attachment-details-alt-text, #attachment-details-two-column-alt-text');
}

// The attachment id can't come from wp.media — content scripts run in an
// isolated world and can't see page JS. Read it from the DOM instead.
function wpsAttachmentId(fieldEl) {
  const scope = fieldEl.closest('.attachment-details, .media-sidebar, .media-frame-content, form, body') || document;
  const link = scope.querySelector('a[href*="post.php?post="], a.edit-attachment[href*="post="]')
    || document.querySelector('a[href*="post.php?post="]');
  if (link) {
    const m = link.getAttribute('href').match(/[?&]post=(\d+)/);
    if (m) return m[1];
  }
  const m = window.location.search.match(/[?&]post=(\d+)/);
  return m ? m[1] : null;
}

// Best available URL for the actual image file (preferred over the thumbnail).
function wpsImageUrl(fieldEl) {
  const scope = fieldEl.closest('.attachment-details, .media-sidebar, .media-frame-content, form, body') || document;
  const urlInput = document.querySelector('#attachment_url')
    || scope.querySelector('.attachment-details-copy-link, input[readonly][value*="/uploads/"]');
  if (urlInput && urlInput.value && /^https?:\/\//.test(urlInput.value)) return urlInput.value;

  const img = scope.querySelector('.details-image, .thumbnail img, .wp_attachment_image img, img[src*="/uploads/"]')
    || document.querySelector('.wp_attachment_image img, img[src*="/uploads/"]');
  return img ? (img.currentSrc || img.src) : null;
}

// Same-origin fetch → downscaled JPEG for the vision call. Mirrors
// tryGetImageBase64's sizing (800px / q0.75); returns null for anything that
// can't be decoded (SVG, missing file) so generation degrades to context-only.
async function wpsImageBase64(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const bm = await createImageBitmap(await res.blob());
    const maxDim = 800;
    const scale = Math.min(1, maxDim / Math.max(bm.width, bm.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bm.width * scale);
    canvas.height = Math.round(bm.height * scale);
    canvas.getContext('2d').drawImage(bm, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', 0.75).split(',')[1], mimeType: 'image/jpeg' };
  } catch { return null; }
}

function wpsHost() {
  return window.location.hostname.replace(/^www\./, '').toLowerCase();
}

// Domain goals + tracked keywords. Tracked keywords come from the background
// Web CEO handler (project resolution is host-based, so wp-admin resolves the
// same project as the public site). Everything here is best-effort.
async function wpsKeywordContext() {
  const host = wpsHost();
  let cfg = {};
  try {
    const { imageSeoConfig } = await browser.storage.local.get('imageSeoConfig');
    cfg = (imageSeoConfig || {})[host] || {};
  } catch { /* no config */ }

  let tracked = [];
  if (cfg.useTrackedKeywords !== false) {
    try {
      const res = await browser.runtime.sendMessage({ action: 'webceoGetTrackedKeywords', pageUrl: window.location.href });
      tracked = (res && res.keywords || []).map(String).filter(Boolean).slice(0, 40);
    } catch { /* Web CEO not connected */ }
  }

  let brand = '';
  try {
    const stored = await browser.storage.sync?.get('brandedTerms').catch(() => null)
      || await browser.storage.local.get('brandedTerms');
    brand = ((stored && stored.brandedTerms) || {})[host] || '';
  } catch { /* none */ }

  return { cfg, tracked, brand };
}

// The accuracy floor is about VISUAL claims — don't invent materials, colours,
// counts or text you can't see. It is NOT about the supplied keywords: those
// are facts the site owner has asserted about their business (service area,
// specialism) which are, by their nature, never visible in a photograph.
// Conflating the two made the model refuse every location keyword, since it
// can't see that a bathroom is in Minneapolis.
const WPS_KEYWORD_RULE =
  'The target keywords are owner-supplied facts about this business (such as its service area or specialism). '
  + 'They are not things you could verify by looking at the image, and you are not expected to — treat them as given context and use them for framing. '
  + 'The list is a menu to choose from, not a checklist: pick only the best-fitting term and ignore the rest. '
  + 'Never use two keywords that refer to the same thing (a city and its metro area, or a term and its synonym) in the same piece of text.';

const WPS_PROMPTS = {
  alt: `You write alt text for images in a WordPress Media Library.
- Describe what the image actually shows. Never invent VISUAL details you cannot see — materials, colours, counts, brands or text.
- ${WPS_KEYWORD_RULE}
- Work in ONE target keyword wherever a natural phrasing exists (e.g. "… in a Minneapolis remodel"). Use one only — never list, stack or repeat keywords.
- Under 125 characters. No "image of" or "photo of" prefix.
- If the image is purely decorative, respond with exactly: [decorative]
- Return only the alt text, nothing else.`,

  title: `You write WordPress Media Library attachment titles.
- A short, human-readable label for the image — it powers Media Library search.
- Title Case. No file extensions, dimensions, underscores or hyphens carried over from the filename.
- ${WPS_KEYWORD_RULE}
- Work in one target keyword where it reads naturally.
- Under 60 characters. Return only the title, nothing else.`,

  caption: `You write image captions shown beneath images on a web page.
- One reader-facing sentence adding context a visitor would value — do not simply restate the alt text.
- Never invent visual details you cannot see in the image.
- ${WPS_KEYWORD_RULE}
- Work in ONE target keyword where it reads naturally. One only.
- Under 160 characters. No surrounding quotes. Return only the caption, nothing else.`,

  description: `You write WordPress attachment descriptions (the body text of the attachment page).
- One to three sentences giving fuller context about the image and its subject.
- Never invent visual details you cannot see in the image.
- ${WPS_KEYWORD_RULE}
- Work in at most TWO target keywords, and only if each reads naturally. Fewer is better — one is usually right.
- Under 320 characters. Return only the description, nothing else.`
};

function wpsReadField(sel) {
  const el = document.querySelector(sel);
  return el && el.value ? el.value.trim() : '';
}

function wpsBuildContext(imageUrl, { cfg, tracked, brand }) {
  const filename = imageUrl ? imageUrl.split('/').pop().split('?')[0] : '';
  const existing = WPS_FIELDS
    .map(f => {
      const val = f.selectors.map(wpsReadField).find(Boolean);
      return val ? `Current ${f.label}: "${val}"` : null;
    })
    .filter(Boolean);

  const keywords = [...(cfg.focusKeywords || []), ...tracked];
  const siteName = document.querySelector('#wp-admin-bar-site-name > a')?.textContent?.trim() || wpsHost();

  return [
    `Site: ${siteName}`,
    filename && `Image filename: ${filename}`,
    ...existing,
    keywords.length && `Target keywords for this site — the owner has confirmed these are true of their business (service area, specialism, etc.). Use them for framing; you are not expected to verify them from the image:\n${keywords.slice(0, 40).join(', ')}`,
    cfg.tone && `Preferred tone: ${cfg.tone}`,
    brand && (cfg.includeBrand
      ? `Brand name (may be used): ${brand.split('|')[0]}`
      : `Do not include the brand or site name (e.g. ${brand.split('|').slice(0, 3).join(', ')}).`),
    // Site-owner rules come last so they read as the most specific instruction,
    // but never override the accuracy floor set in the system prompt.
    cfg.rules && `Rules from the site owner — follow these closely. They may assert context you cannot see in the image (location, project type); trust them. The one thing you must not do is invent visual details that contradict what is actually shown:\n${cfg.rules}`
  ].filter(Boolean).join('\n\n');
}

async function wpsGenerate(fieldKey, imageUrl, kw) {
  const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
  if (!claudeApiKey) throw new Error('No Claude API key — add one in the extension Settings.');

  const context = wpsBuildContext(imageUrl, kw);
  const imageData = await wpsImageBase64(imageUrl);
  const userContent = imageData
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.data } },
        { type: 'text', text: `Generate the ${fieldKey}.\n\n${context}` }
      ]
    : `Generate the ${fieldKey} (image could not be loaded — use context only).\n\n${context}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: CONTENT_MODEL_LIGHT,
        max_tokens: 300,
        system: WPS_PROMPTS[fieldKey],
        messages: [{ role: 'user', content: userContent }]
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from Claude');
    return text;
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Claude request timed out' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

// Write into WP's own field and let WP persist it. The modal saves on change;
// the classic screen saves when the user hits Update.
//
// Uses the prototype's native value setter rather than `el.value = …`: the
// block editor's fields are React-controlled, and React tracks the last value
// it set on the node. A direct assignment is invisible to it, so the change is
// ignored and reverted on the next render. Going through the native setter and
// then dispatching `input` is what React's synthetic event system picks up.
// Harmless for the plain (non-React) modal and classic-screen fields.
function wpsFillField(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Block editor (Gutenberg) image sidebar ──────────────────────────────────
// Only the Alt Text field exists here, and its control ids are generated
// (inspector-textarea-control-N), so find it by its label text instead.
function wpsGutenbergAltField() {
  const labels = document.querySelectorAll(
    '.block-editor-block-inspector label, .components-base-control__label, .interface-interface-skeleton__sidebar label'
  );
  for (const label of labels) {
    if (!/alternative\s*text/i.test(label.textContent || '')) continue;
    const id = label.getAttribute('for');
    const el = (id && document.getElementById(id))
      || label.closest('.components-base-control')?.querySelector('textarea, input[type="text"]');
    if (el) return { el, label };
  }
  return null;
}

// The image for the currently-selected block. The canvas may be a same-origin
// iframe (WP 6.3+), which the top frame can read into directly.
function wpsSelectedBlockImageUrl() {
  const docs = [document];
  try {
    const frame = document.querySelector('iframe[name="editor-canvas"]');
    if (frame && frame.contentDocument) docs.push(frame.contentDocument);
  } catch { /* cross-origin canvas — skip */ }

  for (const doc of docs) {
    const img = doc.querySelector(
      '.wp-block-image.is-selected img, [data-block].is-selected img, .block-editor-block-list__block.is-selected img'
    ) || doc.querySelector('.wp-block-image.has-child-selected img');
    if (img) return img.currentSrc || img.src;
  }
  return null;
}

function wpsInjectGutenbergAlt() {
  const found = wpsGutenbergAltField();
  if (!found) return;
  const { el, label } = found;
  if (el.dataset[WPS_BTN_MARK]) return;
  el.dataset[WPS_BTN_MARK] = '1';

  const field = WPS_FIELDS[0];                 // alt
  const btn = wpsMakeButton(field, el, wpsSelectedBlockImageUrl);
  btn.style.marginTop = '0';                   // inline in the label row, not stacked
  btn.style.flexShrink = '0';
  // Sit at the far right of the label row.
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.justifyContent = 'space-between';
  label.style.width = '100%';
  label.appendChild(btn);
}

// Icon-only: ✦ before it has produced anything, ↻ afterwards so a second click
// reads clearly as "regenerate". `hasRun` persists for the life of the field.
const WPS_GLYPH_NEW = '✦';
const WPS_GLYPH_AGAIN = '↻';

// urlResolver lets a caller override how the image URL is found (the block
// editor resolves it from the selected block, not from around the field).
function wpsMakeButton(field, el, urlResolver) {
  const btn = document.createElement('button');
  btn.type = 'button';            // never submit the surrounding WP form
  let hasRun = false;

  const restIcon = () => hasRun ? WPS_GLYPH_AGAIN : WPS_GLYPH_NEW;
  const restTitle = () => `${hasRun ? 'Regenerate' : 'Generate'} ${field.label} with AI`;
  const setState = (glyph, bg, title) => {
    btn.textContent = glyph;
    btn.style.background = bg;
    btn.title = title;
  };

  btn.style.cssText = [
    'display:inline-flex', 'align-items:center', 'justify-content:center',
    'margin-top:4px', 'width:24px', 'height:24px', 'padding:0',
    'font:600 13px/1 -apple-system,system-ui,"Segoe UI",sans-serif',
    'color:#fff', 'background:#2563eb', 'border:none', 'border-radius:4px',
    'cursor:pointer', 'vertical-align:middle'
  ].join(';');
  setState(WPS_GLYPH_NEW, '#2563eb', restTitle());

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    setState('…', '#6b7280', `Generating ${field.label}…`);
    try {
      const imageUrl = urlResolver ? urlResolver() : wpsImageUrl(el);
      const kw = await wpsKeywordContext();
      const text = await wpsGenerate(field.key, imageUrl, kw);
      wpsFillField(el, text);
      hasRun = true;
      setState('✓', '#16a34a', restTitle());
    } catch (err) {
      setState('✕', '#dc2626', String(err.message || err));
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        setState(restIcon(), '#2563eb', restTitle());
      }, 1800);
    }
  });

  // Let "Generate All" flip this button to its regenerate state too.
  el.__seoiMarkRun = () => {
    hasRun = true;
    if (!btn.disabled) setState(WPS_GLYPH_AGAIN, '#2563eb', restTitle());
  };
  return btn;
}

// Tuck the button under the field's LABEL rather than after the field itself.
// WP floats `.setting > .name` left and the input right, so a button inserted
// after the input clears onto its own full-width line at the far left, which
// squeezes the label/field column. Appending into the label keeps it inline
// with the field name and leaves WP's layout untouched.
function wpsPlaceButton(el, btn) {
  // Modal / attachment details: <label class="setting"><span class="name">…</span><textarea/></label>
  const label = el.closest('.setting')?.querySelector('.name, .label, label');
  if (label && !label.contains(el)) {
    label.appendChild(document.createElement('br'));
    label.appendChild(btn);
    return;
  }
  // Classic form table: <tr><th><label>…</label></th><td><textarea/></td></tr>
  const th = el.closest('tr')?.querySelector('th');
  if (th) {
    th.appendChild(document.createElement('br'));
    th.appendChild(btn);
    return;
  }
  el.insertAdjacentElement('afterend', btn);   // last resort
}

// ── Generate All ────────────────────────────────────────────────────────────
// Runs the four fields sequentially rather than in parallel: alt lands first so
// the later fields see it as context, and four concurrent vision calls would
// risk rate limits for no gain.
function wpsPresentFields() {
  return WPS_FIELDS
    .map(f => ({ field: f, el: f.selectors.map(s => document.querySelector(s)).find(Boolean) }))
    .filter(x => x.el);
}

function wpsMakeGenerateAllButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:5px',
    'margin:0 0 10px', 'padding:5px 11px',
    'font:600 12px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif',
    'color:#fff', 'background:#2563eb', 'border:none', 'border-radius:4px',
    'cursor:pointer'
  ].join(';');
  const rest = () => { btn.textContent = '✦ Generate All'; btn.style.background = '#2563eb'; };
  rest();
  btn.title = 'Generate Alt Text, Title, Caption and Description';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    btn.style.background = '#6b7280';

    const targets = wpsPresentFields();
    let done = 0, failed = 0;
    try {
      const kw = await wpsKeywordContext();
      const imageUrl = targets.length ? wpsImageUrl(targets[0].el) : null;
      for (const { field, el } of targets) {
        btn.textContent = `✦ ${field.label}… (${done + 1}/${targets.length})`;
        try {
          const text = await wpsGenerate(field.key, imageUrl, kw);
          wpsFillField(el, text);
          el.__seoiMarkRun?.();
          done++;
        } catch { failed++; }
      }
      if (failed && !done) {
        btn.textContent = '✕ Failed';
        btn.style.background = '#dc2626';
      } else {
        btn.textContent = failed ? `✓ ${done} of ${targets.length}` : '✓ All done';
        btn.style.background = failed ? '#b45309' : '#16a34a';
      }
    } catch (err) {
      btn.textContent = '✕ Failed';
      btn.style.background = '#dc2626';
      btn.title = String(err.message || err);
    } finally {
      setTimeout(() => { btn.disabled = false; rest(); }, 2200);
    }
  });
  return btn;
}

function wpsInjectGenerateAll() {
  if (document.querySelector('[data-seoi-genall]')) return;      // idempotent
  const altEl = WPS_FIELDS[0].selectors.map(s => document.querySelector(s)).find(Boolean);
  if (!altEl) return;

  const btn = wpsMakeGenerateAllButton();
  btn.setAttribute('data-seoi-genall', '1');

  // Sit above the Alt Text row, spanning the full width of the field area.
  const row = altEl.closest('tr');
  if (row && row.parentElement) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.appendChild(btn);
    tr.appendChild(td);
    row.parentElement.insertBefore(tr, row);
    return;
  }
  const setting = altEl.closest('.setting');
  if (setting && setting.parentElement) {
    const wrap = document.createElement('div');
    wrap.appendChild(btn);
    setting.parentElement.insertBefore(wrap, setting);
    return;
  }
  altEl.parentElement?.insertBefore(btn, altEl);
}

function wpsInjectButtons() {
  if (!wpsIsAdmin()) return;
  // The block editor's image sidebar is not an attachment screen and exposes
  // only Alt Text, so it's handled separately from the four-field screens.
  wpsInjectGutenbergAlt();
  if (!wpsIsAttachmentScreen()) return;
  WPS_FIELDS.forEach(field => {
    field.selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (el.dataset[WPS_BTN_MARK]) return;      // already has a button
        el.dataset[WPS_BTN_MARK] = '1';
        wpsPlaceButton(el, wpsMakeButton(field, el));
      });
    });
  });
  wpsInjectGenerateAll();
}

// The attachment-details modal is destroyed and rebuilt constantly, so re-scan
// on DOM changes. Debounced, and injection itself is idempotent.
function wpsInit() {
  if (!wpsIsAdmin()) return;
  wpsInjectButtons();
  let pending = null;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; wpsInjectButtons(); }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

wpsInit();

// ─── Overlay toggles (shared by the message handler and the shortcuts) ───────
// Each flips the persisted flag and applies/removes the on-page chips, then
// resolves with the new state.

function toggleAltOverlayState() {
  return browser.storage.local.get('altOverlayActive').then(({ altOverlayActive }) => {
    const next = !altOverlayActive;
    return browser.storage.local.set({ altOverlayActive: next }).then(() => {
      if (next) applyOverlay(); else removeOverlay();
      return next;
    });
  });
}

function toggleLinkOverlayState() {
  return browser.storage.local.get('linkOverlayActive').then(({ linkOverlayActive }) => {
    const next = !linkOverlayActive;
    return browser.storage.local.set({ linkOverlayActive: next }).then(() => {
      if (next) applyLinkOverlay(); else removeLinkOverlay();
      return next;
    });
  });
}

function toggleFollowActiveTabState() {
  return browser.storage.local.get('followActiveTab').then(({ followActiveTab }) => {
    // Unset means ON, so the first toggle turns it off.
    const next = followActiveTab === false;
    return browser.storage.local.set({ followActiveTab: next }).then(() => next);
  });
}

// ─── Keyboard shortcuts: Option/Alt + F / I / L ──────────────────────────────
// Implemented as a page keydown listener rather than a manifest `commands`
// entry on purpose. A browser-level command would swallow the keystroke even
// while typing, so Option+F could never produce "ƒ" again. Here the handler
// simply stands down whenever a text field has focus, leaving the character to
// be typed normally.
//
// Matching is on e.code (the physical key), because on macOS holding Option
// rewrites e.key to the alternate glyph — Option+F arrives as "ƒ", not "f".

function seoEditableHasFocus(doc) {
  const el = doc.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Alt alone — Alt+Shift / Ctrl+Alt / Cmd+Alt belong to other things.
function seoShortcutFor(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return null;
  if (e.code === 'KeyF') return 'follow';
  if (e.code === 'KeyI') return 'alt';
  if (e.code === 'KeyL') return 'link';
  return null;
}

if (IS_TOP_FRAME) {
  window.addEventListener('keydown', (e) => {
    const action = seoShortcutFor(e);
    if (!action) return;
    if (seoEditableHasFocus(document)) return;   // let the page have the keystroke
    e.preventDefault();
    if (action === 'follow') toggleFollowActiveTabState();
    else if (action === 'alt') toggleAltOverlayState();
    else toggleLinkOverlayState();
  }, true);   // capture, so a page that swallows keydown can't block it
}

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getPageData') {
    // Always respond, even if a single field-reader throws — a page-specific
    // DOM quirk in one helper must not reject the whole read and strand the
    // popup on "Cannot read this page".
    browser.storage.local.get(['altOverlayActive', 'linkOverlayActive']).then(({ altOverlayActive, linkOverlayActive }) => {
      let data;
      try { data = getPageData(); } catch (e) { data = { _readError: String((e && e.message) || e) }; }
      sendResponse({ ...data, altOverlayActive: !!altOverlayActive, linkOverlayActive: !!linkOverlayActive });
    }).catch(() => {
      let data;
      try { data = getPageData(); } catch (e) { data = { _readError: String((e && e.message) || e) }; }
      sendResponse(data);
    });
    return true;
  }

  if (message.action === 'toggleAltOverlay') {
    toggleAltOverlayState().then(next => sendResponse({ altOverlayActive: next }));
    return true;
  }

  if (message.action === 'toggleLinkOverlay') {
    toggleLinkOverlayState().then(next => sendResponse({ linkOverlayActive: next }));
    return true;
  }

  if (message.action === 'generateAltText') {
    generateAltText(message.srcUrl);
  }
});

} // end idempotency guard (window.__seoInspectorContentLoaded)
