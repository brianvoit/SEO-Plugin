const OVERLAY_ATTR = 'data-seo-overlay';
const WRAPPER_ATTR = 'data-seo-wrapper';
const TOOLTIP_ID   = 'seo-inspector-tooltip';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Page data ───────────────────────────────────────────────────────────────

function getPageData() {
  const titleEl    = document.querySelector('title');
  const titleText  = titleEl ? titleEl.textContent.trim() : '';

  const metaEl     = document.querySelector('meta[name="description"]');
  const metaContent = metaEl ? metaEl.getAttribute('content') : null;

  const headings = Array.from(
    document.querySelectorAll('h1, h2, h3, h4, h5')
  ).map(el => ({
    tag:  el.tagName.toLowerCase(),
    text: el.textContent.trim().replace(/\s+/g, ' ')
  }));

  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const canonical   = canonicalEl ? canonicalEl.getAttribute('href') : null;

  return {
    title: { text: titleText, charCount: titleText.length, wordCount: wordCount(titleText) },
    metaDescription: metaContent !== null
      ? { text: metaContent, charCount: metaContent.length, wordCount: wordCount(metaContent) }
      : null,
    headings,
    canonical
  };
}

// ─── Alt overlay tooltip ─────────────────────────────────────────────────────

function getTooltip() {
  let tt = document.getElementById(TOOLTIP_ID);
  if (!tt) {
    tt = document.createElement('div');
    tt.id = TOOLTIP_ID;
    tt.setAttribute(OVERLAY_ATTR, 'true');
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
  const offset = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
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
  label.addEventListener('mouseout', () => { getTooltip().style.display = 'none'; });
}

// ─── Alt overlay injection ───────────────────────────────────────────────────

function ensureWrapper(img) {
  if (img.parentElement && img.parentElement.hasAttribute(WRAPPER_ATTR)) {
    return img.parentElement;
  }
  const isBlock = getComputedStyle(img).display === 'block';
  const wrapper = document.createElement('span');
  wrapper.setAttribute(WRAPPER_ATTR, 'true');
  wrapper.style.cssText = [
    isBlock ? 'display:block' : 'display:inline-block',
    'position:relative',
    'max-width:100%',
    'vertical-align:middle'
  ].join(';');
  img.parentNode.insertBefore(wrapper, img);
  wrapper.appendChild(img);
  return wrapper;
}

function buildLabel(img) {
  const label = document.createElement('div');
  label.setAttribute(OVERLAY_ATTR, 'true');

  let bg, statusText, tooltipText;

  if (!img.hasAttribute('alt')) {
    bg          = 'rgba(220,38,38,0.92)';
    statusText  = 'MISSING ALT';
    tooltipText = 'No alt attribute — add one to improve accessibility and SEO';
  } else if (img.alt === '') {
    bg          = 'rgba(180,95,6,0.92)';
    statusText  = 'Decorative';
    tooltipText = 'Empty alt (alt="") — intentionally hidden from screen readers';
  } else {
    bg          = 'rgba(22,163,74,0.92)';
    statusText  = img.alt;
    tooltipText = img.alt;
  }

  label.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    'right:0',
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
  document.querySelectorAll('img').forEach(img => {
    const rect = img.getBoundingClientRect();
    if (rect.width < 4 && rect.height < 4) return;
    const wrapper = ensureWrapper(img);
    wrapper.appendChild(buildLabel(img));
  });
}

function removeOverlay() {
  // Hide tooltip immediately
  const tt = document.getElementById(TOOLTIP_ID);
  if (tt) tt.style.display = 'none';

  document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach(el => el.remove());
  document.querySelectorAll(`[${WRAPPER_ATTR}]`).forEach(wrapper => {
    const img = wrapper.querySelector('img');
    if (img) wrapper.parentNode.insertBefore(img, wrapper);
    wrapper.remove();
  });
}

// ─── Init: restore overlay if sticky ─────────────────────────────────────────

browser.storage.local.get('altOverlayActive').then(({ altOverlayActive }) => {
  if (altOverlayActive) applyOverlay();
});

// ─── Message handler ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getPageData') {
    browser.storage.local.get('altOverlayActive').then(({ altOverlayActive }) => {
      sendResponse({ ...getPageData(), altOverlayActive: !!altOverlayActive });
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
});
