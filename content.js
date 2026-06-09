const OVERLAY_ATTR  = 'data-seo-overlay';
const CONTAINER_ID  = 'seo-inspector-overlay';
const TOOLTIP_ID    = 'seo-inspector-tooltip';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Page data ───────────────────────────────────────────────────────────────

function getBodyWordCount() {
  const clone = document.body.cloneNode(true);
  ['script','style','noscript','nav','header','footer','aside'].forEach(tag =>
    clone.querySelectorAll(tag).forEach(el => el.remove())
  );
  ['navigation','banner','contentinfo','complementary'].forEach(role =>
    clone.querySelectorAll(`[role="${role}"]`).forEach(el => el.remove())
  );
  const text = clone.textContent.replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').filter(Boolean).length : 0;
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
  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      const parsed = JSON.parse(script.textContent);
      const items  = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      schemas.push(...items.filter(item => item && item['@type']));
    } catch { /* invalid JSON-LD */ }
  });
  return schemas;
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

  return {
    title: { text: titleText, charCount: titleText.length, wordCount: wordCount(titleText) },
    metaDescription: metaContent !== null
      ? { text: metaContent, charCount: metaContent.length, wordCount: wordCount(metaContent) }
      : null,
    headings,
    canonical,
    bodyWordCount:  getBodyWordCount(),
    indexability:   getIndexability(),
    openGraph:      getOpenGraph(),
    structuredData: getStructuredData()
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

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:${c.headerBg};border-bottom:1px solid ${c.border}">
      <span style="font-size:9px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${c.muted}">Suggested Alt Text</span>
      <button id="sag-close" style="background:none;border:none;cursor:pointer;color:${c.muted};font-size:18px;line-height:1;padding:0">&times;</button>
    </div>
    <div id="sag-body" style="padding:10px">
      <span style="color:${c.muted};font-size:12px">Generating…</span>
    </div>`;

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

function showGeneratorResult(altText, usedVision) {
  const panel = document.getElementById(GENERATOR_ID);
  const body  = document.getElementById('sag-body');
  if (!body || !panel) return;
  const c = panel._colors;

  body.innerHTML = `
    <textarea id="sag-text" rows="3" style="width:100%;box-sizing:border-box;border:1px solid ${c.inputBorder};border-radius:5px;padding:7px 9px;font:13px/1.5 -apple-system,system-ui,sans-serif;resize:vertical;color:${c.text};background:${c.inputBg};outline:none">${altText}</textarea>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
      <span style="font-size:10px;color:${c.muted}">${usedVision ? '✦ vision' : '✦ page context'}</span>
      <button id="sag-copy" style="background:#2563eb;color:#fff;border:none;border-radius:4px;padding:4px 12px;font:600 12px/1.5 sans-serif;cursor:pointer">Copy</button>
    </div>`;

  document.getElementById('sag-copy').addEventListener('click', () => {
    const val = document.getElementById('sag-text').value;
    navigator.clipboard.writeText(val).then(() => {
      const btn = document.getElementById('sag-copy');
      btn.textContent = 'Copied!';
      btn.style.background = '#16a34a';
      setTimeout(() => { btn.textContent = 'Copy'; btn.style.background = '#2563eb'; }, 1500);
    });
  });
}

function showGeneratorError(msg) {
  const body = document.getElementById('sag-body');
  if (!body) return;
  body.innerHTML = `<span style="color:#dc2626;font-size:12px">${msg}</span>`;
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }

    const data    = await res.json();
    const altText = data.content?.[0]?.text?.trim();
    if (!altText) throw new Error('Empty response from Claude');

    showGeneratorResult(altText, !!imageData);
  } catch (err) {
    showGeneratorError(`Error: ${err.message}`);
  }
}

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

  if (message.action === 'generateAltText') {
    generateAltText(message.srcUrl);
  }
});
