const OVERLAY_ATTR  = 'data-seo-overlay';
const CONTAINER_ID  = 'seo-inspector-overlay';
const TOOLTIP_ID    = 'seo-inspector-tooltip';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Page data ───────────────────────────────────────────────────────────────

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

  return {
    title: { text: titleText, charCount: titleText.length, wordCount: wordCount(titleText) },
    metaDescription: metaContent !== null
      ? { text: metaContent, charCount: metaContent.length, wordCount: wordCount(metaContent) }
      : null,
    headings,
    canonical
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
