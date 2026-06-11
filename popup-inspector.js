// On-page SEO inspector: title, meta description, headings, canonical, word
// count, indexability, Open Graph, structured data, dates, and the alt-text
// overlay toggle. Also owns the main `loadData`/`render` entry points.

const MAX_WORDS = 25;
const MAX_CHARS = 180;

const store = { title: '', meta: '', canonical: '' };

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(text) {
  if (!text) return { display: '', truncated: false };
  const words = text.trim().split(/\s+/);
  if (words.length <= MAX_WORDS && text.length <= MAX_CHARS) {
    return { display: text, truncated: false };
  }
  let cut = words.slice(0, MAX_WORDS).join(' ');
  if (cut.length > MAX_CHARS) cut = cut.slice(0, MAX_CHARS);
  return { display: cut + '…', truncated: true };
}

// ─── Render: title ──────────────────────────────────────────────────────────

function renderTitle(data) {
  const { display } = truncate(data.title.text);
  const el = document.getElementById('title-text');
  el.textContent = display || '(empty)';
  el.className = 'field-value' + (data.title.text ? '' : ' is-none');

  const metaEl = document.getElementById('title-meta');
  metaEl.textContent = `${data.title.charCount} chars · ${data.title.wordCount} words`;
  metaEl.className = 'field-meta ' + countColorClass(data.title.charCount, charRanges.title);

  store.title = data.title.text;
}

// ─── Render: meta description ───────────────────────────────────────────────

function renderMeta(data, expand = false) {
  const metaEl   = document.getElementById('meta-text');
  const metaMeta = document.getElementById('meta-meta');
  const toggleBtn = document.getElementById('meta-toggle');

  if (!data.metaDescription) {
    metaEl.textContent = 'None';
    metaEl.className = 'field-value is-none';
    metaMeta.textContent = '';
    metaMeta.className = 'field-meta';
    toggleBtn.classList.add('hidden');
    store.meta = '';
    return;
  }

  store.meta = data.metaDescription.text;
  const { display, truncated } = truncate(data.metaDescription.text);

  metaEl.textContent = expand ? data.metaDescription.text : display;
  metaEl.className = 'field-value';

  metaMeta.textContent = `${data.metaDescription.charCount} chars · ${data.metaDescription.wordCount} words`;
  metaMeta.className = 'field-meta ' + countColorClass(data.metaDescription.charCount, charRanges.meta);

  if (truncated && !expand) {
    toggleBtn.classList.remove('hidden');
    toggleBtn.textContent = 'Show more';
  } else if (truncated && expand) {
    toggleBtn.classList.remove('hidden');
    toggleBtn.textContent = 'Show less';
  } else {
    toggleBtn.classList.add('hidden');
  }
}

// ─── Render: headings ───────────────────────────────────────────────────────

function analyzeHeadings(headings) {
  const extraH1Indices = new Set();
  const skipIndices    = new Set();
  let noH1 = false;

  const h1Count = headings.filter(h => h.tag === 'h1').length;
  if (h1Count === 0) noH1 = true;

  let firstH1Seen = false;
  let prevLevel = 0;

  headings.forEach(({ tag }, i) => {
    const level = parseInt(tag[1], 10);

    if (tag === 'h1') {
      if (firstH1Seen) extraH1Indices.add(i);
      else firstH1Seen = true;
    }

    if (prevLevel > 0 && level > prevLevel + 1) skipIndices.add(i);

    prevLevel = level;
  });

  return { noH1, extraH1Indices, skipIndices };
}

function renderHeadings(data) {
  const list        = document.getElementById('headings-list');
  const warningZone = document.getElementById('headings-warnings');
  list.innerHTML = '';
  warningZone.innerHTML = '';

  if (!data.headings.length) {
    const empty = document.createElement('div');
    empty.className = 'headings-empty';
    empty.textContent = 'No headings found';
    list.appendChild(empty);
    return;
  }

  const { noH1, extraH1Indices, skipIndices } = analyzeHeadings(data.headings);
  const hasWarnings = noH1 || extraH1Indices.size || skipIndices.size;

  if (hasWarnings) warningZone.className = 'heading-warnings';

  if (noH1) {
    const banner = document.createElement('div');
    banner.className = 'heading-warning-banner';
    banner.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L1 14h14z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12.5" r=".5" fill="currentColor" stroke="none"/></svg> No H1 found on this page`;
    warningZone.appendChild(banner);
  }

  const indentPerLevel = 14;

  data.headings.forEach(({ tag, text }, i) => {
    const level = parseInt(tag[1], 10);
    const isExtraH1 = extraH1Indices.has(i);
    const isSkip    = skipIndices.has(i);

    const row = document.createElement('div');
    row.className = 'heading-row';
    row.style.paddingLeft = `${(level - 1) * indentPerLevel}px`;

    const tagEl = document.createElement('span');
    tagEl.className = 'heading-tag';
    if (isExtraH1) tagEl.classList.add('heading-tag--error');
    if (isSkip)    tagEl.classList.add('heading-tag--warning');
    tagEl.textContent = tag.toUpperCase();

    const textEl = document.createElement('span');
    textEl.className = 'heading-text';
    textEl.textContent = text || '(empty)';

    row.appendChild(tagEl);
    row.appendChild(textEl);

    if (isExtraH1 || isSkip) {
      const badge = document.createElement('span');
      badge.className = 'heading-issue-badge' + (isExtraH1 ? ' heading-issue-badge--error' : '');
      badge.textContent = '!';
      badge.title = isExtraH1
        ? 'Multiple H1s — only one H1 is recommended per page'
        : `Skipped from H${level - 1 < 1 ? 1 : level - 1} to H${level} — avoid jumping heading levels`;
      row.appendChild(badge);
    }

    list.appendChild(row);
  });
}

// ─── Render: canonical ──────────────────────────────────────────────────────

function renderCanonical(data) {
  const el = document.getElementById('canonical-text');
  if (data.canonical) {
    el.textContent = data.canonical;
    el.className = 'field-value';
    store.canonical = data.canonical;
  } else {
    el.textContent = 'None';
    el.className = 'field-value is-none';
    store.canonical = '';
  }
}

// ─── Render: word count ──────────────────────────────────────────────────────

function renderWordCount(data) {
  const count = data.bodyWordCount ?? 0;
  const mins  = Math.max(1, Math.round(count / 200));
  document.getElementById('wordcount-text').textContent =
    `${count.toLocaleString()} words · ~${mins} min read`;
}

// ─── Render: indexability ────────────────────────────────────────────────────

function renderIndexability(data) {
  const { noindex } = data.indexability;
  _idxOnPage = noindex
    ? { level: 'error', text: 'Noindex' }
    : { level: 'ok', text: 'Indexable' };
  // Drop any prior page's GSC coverage until this page's inspection resolves
  // (loadGscData runs right after and repaints it)
  _idxGsc = undefined;
  renderIndexabilitySection();
}

// ─── Render: open graph ──────────────────────────────────────────────────────

const OG_KEYS = ['og:title','og:description','og:image','og:url','og:site_name','og:type'];
const TW_KEYS = ['twitter:card','twitter:title','twitter:description','twitter:image'];

// Conditional-formatting thresholds for social cards
const OG_TITLE_MAX   = 60;    // X/LinkedIn truncate beyond ~60 chars
const OG_DESC_MAX    = 125;   // social previews often show ~125 chars
const OG_IMG_RATIO   = 1.91;  // 1200×630 — the format most platforms expect
const OG_IMG_RATIO_TOL = 0.30;
const OG_IMG_MIN_W   = 600;
const OG_IMG_MIN_H   = 315;

function renderOpenGraph(data) {
  const list = document.getElementById('og-list');
  list.innerHTML = '';
  const { og, twitter } = data.openGraph;
  const hasTwitter = TW_KEYS.some(k => twitter[k] !== undefined && twitter[k] !== '');

  OG_KEYS.forEach(key => appendOGRow(list, key, og[key]));
  if (hasTwitter) TW_KEYS.forEach(key => appendOGRow(list, key, twitter[key]));
}

// Returns { level, detail } for a field. Image dimensions are resolved
// asynchronously afterwards (see checkOgImage), so present images start neutral.
function ogFieldCheck(key, value, present) {
  const len = present ? value.length : 0;
  switch (key) {
    case 'og:title':
      if (!present) return { level: 'error', detail: 'Missing — set og:title for social cards' };
      return len > OG_TITLE_MAX
        ? { level: 'warning', detail: `${len} chars — over ~${OG_TITLE_MAX}, X/LinkedIn may truncate` }
        : { level: 'ok', detail: `${len} chars` };
    case 'og:description':
      if (!present) return { level: 'error', detail: 'Missing — set og:description' };
      return len > OG_DESC_MAX
        ? { level: 'warning', detail: `${len} chars — over ~${OG_DESC_MAX}, may truncate on mobile` }
        : { level: 'ok', detail: `${len} chars` };
    case 'og:image':
      return present
        ? { level: 'neutral', detail: 'Checking dimensions…' }
        : { level: 'error', detail: 'Missing — pages with an image get far more engagement' };
    case 'og:url':
      return present ? { level: 'ok', detail: 'Set' } : { level: 'warning', detail: 'Missing — set the canonical share URL' };
    case 'og:site_name':
      return present ? { level: 'ok', detail: `"${value}"` } : { level: 'warning', detail: 'Missing — shown as the eyebrow on Discord and others' };
    case 'og:type':
      return present ? { level: 'ok', detail: value } : { level: 'neutral', detail: 'Not set — defaults to website' };
    case 'twitter:card':
      if (!present) return { level: 'warning', detail: 'Missing — add summary_large_image for a full-width image' };
      if (value === 'summary_large_image') return { level: 'ok', detail: 'Large image card' };
      if (value === 'summary') return { level: 'ok', detail: 'Summary card (small image)' };
      return { level: 'neutral', detail: value };
    case 'twitter:title':
      if (!present) return { level: 'neutral', detail: 'Not set — falls back to og:title' };
      return len > OG_TITLE_MAX ? { level: 'warning', detail: `${len} chars — may truncate` } : { level: 'ok', detail: `${len} chars` };
    case 'twitter:description':
      if (!present) return { level: 'neutral', detail: 'Not set — falls back to og:description' };
      return len > OG_DESC_MAX ? { level: 'warning', detail: `${len} chars — may truncate` } : { level: 'ok', detail: `${len} chars` };
    case 'twitter:image':
      return present ? { level: 'ok', detail: 'Set' } : { level: 'neutral', detail: 'Not set — falls back to og:image' };
    default:
      return present ? { level: 'ok', detail: '' } : { level: 'neutral', detail: '' };
  }
}

function setOgRowLevel(row, level) {
  row.classList.remove('og-row--ok', 'og-row--warning', 'og-row--error', 'og-row--neutral');
  row.classList.add(`og-row--${level}`);
}

// Load an og:image/twitter:image off-screen to check its aspect ratio & size,
// then update the row's level and detail text in place.
function checkOgImage(url, row) {
  const detailEl = row.querySelector('.og-detail');
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { setOgRowLevel(row, 'neutral'); detailEl.textContent = 'Image set (couldn’t read dimensions)'; return; }
    const ratio = w / h;
    if (w < OG_IMG_MIN_W || h < OG_IMG_MIN_H) {
      setOgRowLevel(row, 'warning');
      detailEl.textContent = `${w}×${h} — small, use ≥${OG_IMG_MIN_W}×${OG_IMG_MIN_H} (ideally 1200×630)`;
    } else if (Math.abs(ratio - OG_IMG_RATIO) > OG_IMG_RATIO_TOL) {
      setOgRowLevel(row, 'warning');
      detailEl.textContent = `${w}×${h} — expected ~1.91:1 (1200×630), card may crop or letterbox`;
    } else {
      setOgRowLevel(row, 'ok');
      detailEl.textContent = `${w}×${h}`;
    }
  };
  img.onerror = () => { setOgRowLevel(row, 'neutral'); detailEl.textContent = 'Image set (couldn’t load to verify)'; };
  img.src = url;
}

function appendOGRow(container, key, value) {
  const present = value !== undefined && value !== null && value !== '';
  const label   = key.replace('og:', '').replace('twitter:', 'tw:');
  const isImage = present && (key === 'og:image' || key === 'twitter:image');
  const isUrl   = present && /^https?:\/\//i.test(value);
  const { level, detail } = ogFieldCheck(key, value, present);

  let valueMarkup;
  if (!present) {
    valueMarkup = '<span class="og-missing">missing</span>';
  } else {
    const display = value.length > 42 ? value.slice(0, 42) + '…' : value;
    valueMarkup = `<span class="og-value${isUrl ? ' og-value--link' : ''}" title="${escapeHtml(value)}">${escapeHtml(display)}</span>`;
  }

  const row = document.createElement('div');
  row.className = `og-row og-row--${level}`;
  row.innerHTML = `<span class="og-dot"></span>`
    + `<div class="og-body">`
    +   `<div class="og-line"><span class="og-key">${escapeHtml(label)}</span>${valueMarkup}</div>`
    +   `<div class="og-detail">${escapeHtml(detail)}</div>`
    + `</div>`;
  container.appendChild(row);

  if (!present) return;

  const valueEl = row.querySelector('.og-value');
  if (isUrl) {
    valueEl.addEventListener('click', () => browser.tabs.create({ url: value }));
  }
  if (isImage && isUrl) {
    valueEl.addEventListener('mouseenter', () => showImagePreview(value, valueEl));
    valueEl.addEventListener('mouseleave', hideImagePreview);
    checkOgImage(value, row);
  }
}

// ─── OG/Twitter image hover preview ──────────────────────────────────────────

let _ogPreviewEl = null;

function showImagePreview(url, anchorEl) {
  if (!_ogPreviewEl) {
    _ogPreviewEl = document.createElement('div');
    _ogPreviewEl.className = 'og-img-preview';
    const img = document.createElement('img');
    img.alt = '';
    _ogPreviewEl.appendChild(img);
    document.body.appendChild(_ogPreviewEl);
  }
  _ogPreviewEl.querySelector('img').src = url;
  _ogPreviewEl.classList.add('visible');

  // Position just below the URL, clamped to the viewport
  const r = anchorEl.getBoundingClientRect();
  const maxW = 210;
  _ogPreviewEl.style.top  = `${r.bottom + 6}px`;
  _ogPreviewEl.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - maxW - 6))}px`;
}

function hideImagePreview() {
  if (_ogPreviewEl) _ogPreviewEl.classList.remove('visible');
}

// ─── Render: structured data ─────────────────────────────────────────────────

function renderStructuredData(data) {
  _schemas = data.structuredData ?? [];
  const btn     = document.getElementById('btn-schema');
  const summary = document.getElementById('schema-summary');

  if (!_schemas.length) {
    summary.textContent = 'None';
    btn.disabled = true;
  } else {
    const types = _schemas.map(s => [].concat(s['@type'])[0]).filter(Boolean);
    summary.textContent = types.length === 1 ? types[0] : `${types.length} types`;
    btn.disabled = false;
  }
}

function renderSchemaDetail() {
  const content = document.getElementById('schema-detail-content');
  content.innerHTML = '';

  _schemas.forEach(schema => {
    const type = [].concat(schema['@type']).join(' + ') || 'Unknown';
    const card = document.createElement('div');
    card.className = 'schema-card';

    const header = document.createElement('div');
    header.className = 'schema-type-name';
    header.textContent = type;
    card.appendChild(header);

    Object.entries(schema).forEach(([key, val]) => {
      if (key.startsWith('@')) return;
      let display;
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        display = String(val);
        if (display.length > 80) display = display.slice(0, 80) + '…';
      } else if (Array.isArray(val)) {
        display = `${val.length} item${val.length !== 1 ? 's' : ''}`;
      } else if (val && typeof val === 'object') {
        display = val.name || val['@type'] || val.url || '(object)';
      } else { return; }

      const row = document.createElement('div');
      row.className = 'schema-prop';
      row.innerHTML = `<span class="schema-key">${escapeHtml(key)}</span><span class="schema-val">${escapeHtml(display)}</span>`;
      card.appendChild(row);
    });

    content.appendChild(card);
  });
}

// ─── Render: dates ───────────────────────────────────────────────────────────

function renderDates(data) {
  const { published, modified } = data.dates ?? {};
  const pubEl = document.getElementById('date-published');
  const modEl = document.getElementById('date-modified');
  const fmt = formatDate(published);
  const fmtMod = formatDate(modified);

  pubEl.textContent = fmt ?? '—';
  pubEl.className = 'dates-value' + (fmt ? '' : ' dates-value--none');
  modEl.textContent = fmtMod ?? '—';
  modEl.className = 'dates-value' + (fmtMod ? '' : ' dates-value--none');
}

// ─── Render: overlay toggle ─────────────────────────────────────────────────

function renderOverlayToggle(active) {
  document.getElementById('btn-overlay').setAttribute('aria-pressed', String(active));
}

// ─── Render: all ────────────────────────────────────────────────────────────

function render(data, expandMeta = false) {
  pageData = data;
  renderTitle(data);
  renderMeta(data, expandMeta);
  renderWordCount(data);
  renderIndexability(data);
  renderHeadings(data);
  renderCanonical(data);
  renderOpenGraph(data);
  renderStructuredData(data);
  renderDates(data);
  renderOverlayToggle(data.altOverlayActive);
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadData(expandMeta = false, forceRefreshGsc = false) {
  const { charRanges: stored } = await browser.storage.local.get('charRanges');
  charRanges = stored ?? DEFAULT_RANGES;

  const tab = await getActiveTab();
  try {
    const data = await browser.tabs.sendMessage(tab.id, { action: 'getPageData' });
    document.getElementById('error-state').classList.add('hidden');
    showActiveTab();
    render(data, expandMeta);
    loadGscData(forceRefreshGsc);
  } catch {
    document.getElementById('error-state').classList.remove('hidden');
    tabGroup.classList.add('hidden');
    mainContent.classList.add('hidden');
    searchTab.classList.add('hidden');
  }
}

// ─── Copy buttons ────────────────────────────────────────────────────────────

document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    await copyToClipboard(store[btn.dataset.copyTarget] ?? '');
    flashCopyBtn(btn);
  });
});

// ─── Refresh button ──────────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', () => {
  metaExpanded = false;
  loadData(false, true);
});

// ─── Meta show more/less ─────────────────────────────────────────────────────

document.getElementById('meta-toggle').addEventListener('click', async () => {
  metaExpanded = !metaExpanded;
  const tab = await getActiveTab();
  try {
    const data = await browser.tabs.sendMessage(tab.id, { action: 'getPageData' });
    renderMeta(data, metaExpanded);
  } catch { /* ignore */ }
});

// ─── Alt overlay toggle ──────────────────────────────────────────────────────

document.getElementById('btn-overlay').addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    const response = await browser.tabs.sendMessage(tab.id, { action: 'toggleAltOverlay' });
    renderOverlayToggle(response.altOverlayActive);
  } catch { /* ignore */ }
});
