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

function buildLabel(img) {
  const label = document.createElement('div');
  label.setAttribute(OVERLAY_ATTR, 'true');

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

  // Build one label per visible image and store img reference
  const entries = [];
  document.querySelectorAll('img').forEach(img => {
    const rect = img.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const label = buildLabel(img);
    container.appendChild(label);
    entries.push({ img, label });
  });

  container._entries = entries;

  // Position every label to match its image's current viewport rect
  function updatePositions() {
    entries.forEach(({ img, label }) => {
      const r = img.getBoundingClientRect();
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

// ─── Init: restore overlay if it was active before navigation ────────────────

browser.storage.local.get('altOverlayActive').then(({ altOverlayActive }) => {
  if (altOverlayActive) applyOverlay();
});

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
  const img = Array.from(document.querySelectorAll('img')).find(i => i.src === srcUrl);
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

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getPageData') {
    // Always respond, even if a single field-reader throws — a page-specific
    // DOM quirk in one helper must not reject the whole read and strand the
    // popup on "Cannot read this page".
    browser.storage.local.get('altOverlayActive').then(({ altOverlayActive }) => {
      let data;
      try { data = getPageData(); } catch (e) { data = { _readError: String((e && e.message) || e) }; }
      sendResponse({ ...data, altOverlayActive: !!altOverlayActive });
    }).catch(() => {
      let data;
      try { data = getPageData(); } catch (e) { data = { _readError: String((e && e.message) || e) }; }
      sendResponse(data);
    });
    return true;
  }

  if (message.action === 'toggleAltOverlay') {
    browser.storage.local.get('altOverlayActive').then(({ altOverlayActive }) => {
      const next = !altOverlayActive;
      browser.storage.local.set({ altOverlayActive: next }).then(() => {
        if (next) applyOverlay();
        else removeOverlay();
        sendResponse({ altOverlayActive: next });
      });
    });
    return true;
  }

  if (message.action === 'generateAltText') {
    generateAltText(message.srcUrl);
  }
});

} // end idempotency guard (window.__seoInspectorContentLoaded)
