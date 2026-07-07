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

// ─── SERP pixel width ─────────────────────────────────────────────────────────
// Google truncates by rendered pixel width, not characters. Measured with the
// fonts Google uses in results: titles ~20px Arial, descriptions ~14px Arial.

const TITLE_PX_TARGET = 600;
const META_PX_TARGET  = 920;   // desktop; mobile is ~680

const _pxCtx = document.createElement('canvas').getContext('2d');

function measureSerpWidth(text, font) {
  _pxCtx.font = font;
  return Math.round(_pxCtx.measureText(text).width);
}

// Within 10% below target = green; over target = red; further below = amber
function pxHintClass(w, target) {
  if (w > target) return 'hint-red';
  if (w >= target * 0.9) return 'hint-green';
  return 'hint-amber';
}

// "{chars} chars · {words} words · {px}px" with the px segment independently
// colored by the pixel rule (the line itself keeps the char-range color)
function fillCountsLine(metaEl, charCount, wordCount, pxWidth, pxTarget) {
  metaEl.replaceChildren();
  metaEl.appendChild(document.createTextNode(`${charCount} chars · ${wordCount} words · `));
  const px = document.createElement('span');
  px.className = pxHintClass(pxWidth, pxTarget);
  px.textContent = `${pxWidth}px`;
  px.title = `Rendered width in Google results (truncates ~${pxTarget}px)`;
  metaEl.appendChild(px);
}

// ─── Render: title ──────────────────────────────────────────────────────────

function renderTitle(data) {
  const { display } = truncate(data.title.text);
  const el = document.getElementById('title-text');
  el.textContent = display || '(empty)';
  el.className = 'field-value' + (data.title.text ? '' : ' is-none');

  const metaEl = document.getElementById('title-meta');
  const pxWidth = measureSerpWidth(data.title.text, '20px Arial');
  fillCountsLine(metaEl, data.title.charCount, data.title.wordCount, pxWidth, TITLE_PX_TARGET);
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

  const pxWidth = measureSerpWidth(data.metaDescription.text, '14px Arial');
  fillCountsLine(metaMeta, data.metaDescription.charCount, data.metaDescription.wordCount, pxWidth, META_PX_TARGET);
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

  // The document's heading outline should open on an H1; flag when it doesn't.
  const wrongStart = headings.length > 0 && headings[0].tag !== 'h1';

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

  return { noH1, wrongStart, extraH1Indices, skipIndices };
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

  const { noH1, wrongStart, extraH1Indices, skipIndices } = analyzeHeadings(data.headings);
  const hasWarnings = noH1 || wrongStart || extraH1Indices.size || skipIndices.size;

  if (hasWarnings) warningZone.className = 'heading-warnings';

  const addWarningBanner = (text) => {
    const banner = document.createElement('div');
    banner.className = 'heading-warning-banner';
    banner.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L1 14h14z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12.5" r=".5" fill="currentColor" stroke="none"/></svg>'));
    banner.appendChild(document.createTextNode(' ' + text));
    warningZone.appendChild(banner);
  };

  if (noH1) {
    addWarningBanner('No H1 found on this page');
  } else if (wrongStart) {
    addWarningBanner(`Page starts with ${data.headings[0].tag.toUpperCase()} — the first heading should be an H1`);
  }

  const indentPerLevel = 14;

  data.headings.forEach(({ tag, text }, i) => {
    const level = parseInt(tag[1], 10);
    const isExtraH1   = extraH1Indices.has(i);
    const isSkip      = skipIndices.has(i);
    const isWrongStart = wrongStart && i === 0;

    const row = document.createElement('div');
    row.className = 'heading-row';
    row.style.paddingLeft = `${(level - 1) * indentPerLevel}px`;

    const tagEl = document.createElement('span');
    tagEl.className = 'heading-tag';
    if (isExtraH1 || isWrongStart) tagEl.classList.add('heading-tag--error');
    else if (isSkip) tagEl.classList.add('heading-tag--warning');
    tagEl.textContent = tag.toUpperCase();

    const textEl = document.createElement('span');
    textEl.className = 'heading-text';
    textEl.textContent = text || '(empty)';

    row.appendChild(tagEl);
    row.appendChild(textEl);

    if (isExtraH1 || isSkip || isWrongStart) {
      const badge = document.createElement('span');
      const isError = isExtraH1 || isWrongStart;
      badge.className = 'heading-issue-badge' + (isError ? ' heading-issue-badge--error' : '');
      badge.textContent = '!';
      badge.title = isWrongStart
        ? `Page starts with ${tag.toUpperCase()} — the first heading should be an H1`
        : isExtraH1
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
  const chip = document.getElementById('canonical-chip');

  if (data.canonical) {
    el.textContent = data.canonical;
    el.className = 'field-value field-value--link';
    el.title = 'Open canonical URL';
    store.canonical = data.canonical;

    // Indexability already resolved the canonical against the current URL
    const selfRef = !data.indexability?.canonicalMismatch;
    chip.textContent = selfRef ? 'Self-referencing' : 'Different URL';
    chip.className = 'canonical-chip ' + (selfRef ? 'canonical-chip--ok' : 'canonical-chip--warn');
  } else {
    el.textContent = 'None';
    el.className = 'field-value is-missing';
    el.title = 'No canonical tag found on this page';
    store.canonical = '';
    chip.textContent = 'Missing';
    chip.className = 'canonical-chip canonical-chip--err';
  }
}

document.getElementById('canonical-text').addEventListener('click', () => {
  if (store.canonical) browser.tabs.create({ url: store.canonical });
});

// ─── Render: domain age (RDAP, resolved in the background) ───────────────────

function loadDomainAge(tab) {
  const el = document.getElementById('domain-age');
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { /* non-http page */ }
  if (!host) {
    el.textContent = '—';
    el.className = 'dates-value dates-value--none';
    return;
  }
  el.textContent = '…';
  el.className = 'dates-value';
  sendMessageWithTimeout({ action: 'getDomainAge', host }).then(res => {
    if (!res || res.error || !res.registered) {
      el.textContent = '—';
      el.className = 'dates-value dates-value--none';
      el.title = '';
      return;
    }
    const reg = new Date(res.registered);
    const years = (Date.now() - reg.getTime()) / (365.25 * 86400000);
    el.textContent = `${years.toFixed(1)} years (${reg.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })})`;
    el.className = 'dates-value';
    el.title = [
      res.domain,
      res.registrar && `Registrar: ${res.registrar}`,
      res.expires && `Expires: ${formatDate(res.expires)}`
    ].filter(Boolean).join('\n');
  }).catch(() => {
    el.textContent = '—';
    el.className = 'dates-value dates-value--none';
  });
}

// ─── Robots.txt header button ─────────────────────────────────────────────────

document.getElementById('btn-robots').addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    browser.tabs.create({ url: new URL('/robots.txt', tab.url).href });
  } catch { /* non-http page */ }
});

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

// Keys where we offer AI generation (text-only, not images/URLs/vocab values)
const OG_GENERABLE_KEYS = new Set(['og:title','og:description','twitter:title','twitter:description']);

// Conditional-formatting thresholds for social cards
const OG_TITLE_MAX   = 60;    // X/LinkedIn truncate beyond ~60 chars
const OG_DESC_MAX    = 125;   // social previews often show ~125 chars
const OG_IMG_RATIO   = 1.91;  // 1200×630 — the format most platforms expect
const OG_IMG_RATIO_TOL = 0.30;
const OG_IMG_MIN_W   = 600;
const OG_IMG_MIN_H   = 315;

async function renderOpenGraph(data) {
  const ogList = document.getElementById('og-list');
  const twList = document.getElementById('tw-list');
  ogList.innerHTML = '';
  twList.innerHTML = '';
  const { og, twitter } = data.openGraph;

  // Best-effort: read cached AI insights so we can show chips on existing value rows
  let insights = null;
  try {
    const tab = await getActiveTab();
    const cacheKey = (tab.url || '').split('#')[0];
    const { aiInsightsCache } = await browser.storage.local.get('aiInsightsCache');
    insights = (aiInsightsCache || {})[cacheKey] || null;
  } catch { /* ignore */ }

  OG_KEYS.forEach(key => appendOGRow(ogList, key, og[key], insights));
  TW_KEYS.forEach(key => appendOGRow(twList, key, twitter[key], insights));

  const ogPresent = OG_KEYS.filter(k => og[k]).length;
  const twPresent = TW_KEYS.filter(k => twitter[k]).length;
  setOgNavSummary('btn-og', 'og-summary', ogPresent, OG_KEYS.length);
  setOgNavSummary('btn-tw', 'tw-summary', twPresent, TW_KEYS.length);

  // Status symbol on the nav row: worst of the field checks (only when some
  // tags are present — a section with nothing set just reads "None")
  setNavStatus('og-status', ogPresent ? worstOgLevel(OG_KEYS, og) : 'ok');
  setNavStatus('tw-status', twPresent ? worstOgLevel(TW_KEYS, twitter) : 'ok');
}

// Worst level (error > warning > ok) across a set of OG/Twitter fields
function worstOgLevel(keys, source) {
  let worst = 'ok';
  for (const key of keys) {
    const present = source[key] !== undefined && source[key] !== null && source[key] !== '';
    const { level } = ogFieldCheck(key, source[key], present);
    if (level === 'error') return 'error';
    if (level === 'warning') worst = 'warning';
  }
  return worst;
}

// Show a red/amber warning triangle on a nav row, or hide it for ok/neutral
function setNavStatus(elId, level) {
  const el = document.getElementById(elId);
  el.replaceChildren();
  el.classList.remove('field-nav-status--error', 'field-nav-status--warning');
  if (level !== 'error' && level !== 'warning') {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.classList.add(level === 'error' ? 'field-nav-status--error' : 'field-nav-status--warning');
  el.appendChild(svgFromString(
    '<svg viewBox="0 0 16 16" width="13" height="13">' +
      '<path d="M8 1.8 15 14H1z" fill="currentColor"/>' +
      '<rect x="7.3" y="6" width="1.4" height="4" rx=".7" fill="#fff"/>' +
      '<circle cx="8" cy="11.6" r=".8" fill="#fff"/>' +
    '</svg>'
  ));
}

// Set a nav button's summary + enabled state (disabled when nothing is set)
function setOgNavSummary(btnId, summaryId, present, total) {
  const btn = document.getElementById(btnId);
  const summary = document.getElementById(summaryId);
  if (!present) {
    summary.textContent = 'None';
    btn.disabled = true;
  } else {
    summary.textContent = `${present}/${total} set`;
    btn.disabled = false;
  }
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

function appendOGRow(container, key, value, insights = null) {
  const present = value !== undefined && value !== null && value !== '';
  const label   = key.replace('og:', '').replace('twitter:', 'tw:');
  const isImage = present && (key === 'og:image' || key === 'twitter:image');
  const isUrl   = present && /^https?:\/\//i.test(value);
  const { level, detail } = ogFieldCheck(key, value, present);

  const row = document.createElement('div');
  row.className = `og-row og-row--${level}`;

  const dot = document.createElement('span');
  dot.className = 'og-dot';

  const body = document.createElement('div');
  body.className = 'og-body';

  const line = document.createElement('div');
  line.className = 'og-line';
  const keyEl = document.createElement('span');
  keyEl.className = 'og-key';
  keyEl.textContent = label;
  line.appendChild(keyEl);

  let valueEl = null;
  if (!present) {
    const missing = document.createElement('span');
    missing.className = 'og-missing';
    missing.textContent = 'missing';
    line.appendChild(missing);
  } else {
    valueEl = document.createElement('span');
    valueEl.className = isUrl ? 'og-value og-value--link' : 'og-value';
    valueEl.title = value;
    valueEl.textContent = value.length > 42 ? value.slice(0, 42) + '…' : value;
    line.appendChild(valueEl);
  }

  let genBtn = null;
  if (OG_GENERABLE_KEYS.has(key)) {
    genBtn = document.createElement('button');
    genBtn.className = 'gen-btn og-gen-btn';
    genBtn.title = 'Generate with Claude';
    genBtn.appendChild(svgFromString(
      '<svg class="icon-generate" viewBox="0 0 16 16" width="13" height="13" fill="currentColor">' +
      '<path d="M8 1l1.4 4.6L14 7l-4.6 1.4L8 13l-1.4-4.6L2 7l4.6-1.4z"/>' +
      '</svg>'
    ));
    genBtn.appendChild(svgFromString(
      '<svg class="icon-spinner hidden" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
      '<path d="M14 8A6 6 0 1 1 8 2"/>' +
      '</svg>'
    ));
    line.appendChild(genBtn);
  }

  const detailEl = document.createElement('div');
  detailEl.className = 'og-detail';
  detailEl.textContent = detail;

  body.appendChild(line);
  body.appendChild(detailEl);

  if (OG_GENERABLE_KEYS.has(key)) {
    // Show intent/sentiment chips on existing value rows (only when a value is present)
    if (present && insights && typeof buildInsightChips === 'function') {
      const chips = buildInsightChips(insights);
      if (chips) body.appendChild(chips);
    }
    const resultEl = document.createElement('div');
    resultEl.className = 'gen-result hidden';
    body.appendChild(resultEl);
    genBtn.addEventListener('click', () => generateOGField(key, body, genBtn));
  }

  row.appendChild(dot);
  row.appendChild(body);
  container.appendChild(row);

  if (!present) return;
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

// ─── Render: hreflang ────────────────────────────────────────────────────────

function hreflangRowLevel(tag) {
  if (!/^https?:\/\//i.test(tag.href)) return 'warn';
  const lang = tag.lang;
  if (lang === 'x-default') return 'ok';
  if (!/^[a-z]{2}(-[a-z]{2,4})?$/.test(lang)) return 'warn';
  return 'ok';
}

function buildHreflangChecks(tags, pageLanguage, canonical) {
  const langs = tags.map(t => t.lang);
  const hrefs = tags.map(t => t.href);
  const checks = [];

  checks.push({ pass: langs.includes('x-default'), label: 'x-default tag present' });

  const selfRef = canonical && hrefs.some(h => {
    try { return new URL(h).pathname.replace(/\/$/, '') === new URL(canonical).pathname.replace(/\/$/, ''); }
    catch { return false; }
  });
  checks.push({ pass: !!selfRef, label: 'Page references itself in hreflang (self-referencing tag)' });

  const dupes = langs.filter((l, i) => langs.indexOf(l) !== i);
  checks.push({
    pass: dupes.length === 0,
    label: 'No duplicate locale codes' + (dupes.length ? ` (duplicates: ${[...new Set(dupes)].join(', ')})` : '')
  });

  checks.push({ pass: hrefs.every(h => /^https?:\/\//i.test(h)), label: 'All href values are absolute URLs' });

  if (pageLanguage) {
    const match = langs.some(l => l === pageLanguage || l.startsWith(pageLanguage + '-') || pageLanguage.startsWith(l + '-'));
    checks.push({ pass: match, label: `<html lang="${pageLanguage}"> matches a hreflang entry` });
  }

  return checks;
}

function hreflangValidationLevel(tags, pageLanguage, canonical) {
  const checks = buildHreflangChecks(tags, pageLanguage, canonical);
  const failures = checks.filter(c => !c.pass).length;
  if (failures >= 2) return 'error';
  if (failures === 1) return 'warning';
  return 'ok';
}

function renderHreflang(data) {
  const tags = data.hreflang || [];
  const btn     = document.getElementById('btn-hreflang');
  const summary = document.getElementById('hreflang-summary');

  if (!tags.length) {
    summary.textContent = 'None';
    btn.disabled = true;
    setNavStatus('hreflang-status', 'ok');
    return;
  }

  const langCount = tags.filter(t => t.lang !== 'x-default').length;
  summary.textContent = `${langCount} language${langCount !== 1 ? 's' : ''}`;
  btn.disabled = false;

  const canonical = data.canonical || data.indexability?.canonicalUrl || null;
  setNavStatus('hreflang-status', hreflangValidationLevel(tags, data.pageLanguage || null, canonical));
}

function renderHreflangDetail() {
  const content = document.getElementById('hreflang-detail-content');
  content.replaceChildren();

  const tags      = (pageData && pageData.hreflang)      || [];
  const pageLang  = (pageData && pageData.pageLanguage)  || null;
  const canonical = (pageData && (pageData.canonical || pageData.indexability?.canonicalUrl)) || null;

  if (!tags.length) {
    const sec = document.createElement('section');
    sec.className = 'field-section';
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-muted';
    hint.textContent = 'No hreflang tags found on this page.';
    sec.appendChild(hint);
    content.appendChild(sec);
    return;
  }

  // Languages table
  const tableSec = document.createElement('section');
  tableSec.className = 'field-section';
  const th = document.createElement('div');
  th.className = 'field-header';
  const tl = document.createElement('span');
  tl.className = 'field-label';
  tl.textContent = 'LANGUAGES';
  th.appendChild(tl);
  tableSec.appendChild(th);

  tags.forEach(t => {
    const row = document.createElement('div');
    row.className = 'hl-row';
    const langEl = document.createElement('span');
    langEl.className = 'hl-lang';
    langEl.textContent = t.lang;

    const hrefEl = document.createElement('span');
    hrefEl.className = 'hl-href';
    try {
      const u = new URL(t.href);
      hrefEl.textContent = u.pathname + (u.search || '');
    } catch { hrefEl.textContent = t.href || '(empty)'; }
    hrefEl.title = t.href;

    const level = hreflangRowLevel(t);
    const chip = document.createElement('span');
    chip.className = `hl-chip hl-chip--${level}`;
    chip.textContent = level === 'ok' ? '✓' : '!';
    if (level === 'warn') chip.title = /^https?:\/\//i.test(t.href) ? 'Locale format may be invalid' : 'href is not absolute — must be an absolute URL';

    row.append(langEl, hrefEl, chip);
    tableSec.appendChild(row);
  });
  content.appendChild(tableSec);

  // Validation checklist
  const checkSec = document.createElement('section');
  checkSec.className = 'field-section';
  const ch = document.createElement('div');
  ch.className = 'field-header';
  const cl = document.createElement('span');
  cl.className = 'field-label';
  cl.textContent = 'VALIDATION';
  ch.appendChild(cl);
  checkSec.appendChild(ch);

  buildHreflangChecks(tags, pageLang, canonical).forEach(c => {
    const row = document.createElement('div');
    row.className = `hl-check hl-check--${c.pass ? 'pass' : 'fail'}`;
    const icon = document.createElement('span');
    icon.className = 'hl-check-icon';
    icon.textContent = c.pass ? '✓' : '✗';
    const label = document.createElement('span');
    label.className = 'hl-check-label';
    label.textContent = c.label;
    row.append(icon, label);
    checkSec.appendChild(row);
  });
  content.appendChild(checkSec);
}

// ─── Render: favicon ─────────────────────────────────────────────────────────

// Live reachability results for the current favicon set, cached so re-opening
// the panel doesn't re-probe. Keyed by a signature of the declared icon URLs.
let _faviconLive = null;      // { results: { url: {ok,status,contentType,isImage} }, manifest }
let _faviconLiveSig = null;
let _faviconLoading = false;

function faviconSignature(fav) {
  if (!fav) return '';
  return JSON.stringify([(fav.icons || []).map(i => i.href), fav.manifestHref, fav.defaultIcoUrl]);
}

function faviconIsStandard(i) { return (i.rel || '').split(/\s+/).includes('icon'); }
function faviconIsApple(i)    { return /apple-touch-icon/.test(i.rel || ''); }
function faviconIsMask(i)     { return (i.rel || '').split(/\s+/).includes('mask-icon'); }
function faviconIsSvg(i) {
  if (i.type === 'image/svg+xml') return true;
  if (faviconIsMask(i)) return true;   // mask-icon is always SVG
  try { return new URL(i.href).pathname.toLowerCase().endsWith('.svg'); }
  catch { return /\.svg(\?|$)/i.test(i.href || ''); }
}
function faviconSizeTokens(i) { return (i.sizes || '').split(/\s+/).filter(Boolean); }
function faviconIsIco(i) {
  if (/vnd\.microsoft\.icon|x-icon/.test(i.type || '')) return true;
  try { return new URL(i.href).pathname.toLowerCase().endsWith('.ico'); }
  catch { return /\.ico(\?|$)/i.test(i.href || ''); }
}

// Distinct raster (non-scalable) sizes declared across standard icons.
function faviconRasterSizes(icons) {
  const set = new Set();
  icons.filter(faviconIsStandard).forEach(i => faviconSizeTokens(i).forEach(s => { if (s !== 'any') set.add(s); }));
  return set;
}

// Overview status dot: green = standard + apple + (svg or >=2 raster sizes);
// amber = something present but incomplete; red = nothing declared.
function faviconStaticLevel(fav) {
  const icons = (fav && fav.icons) || [];
  if (!icons.length && !(fav && fav.manifestHref)) return 'error';
  const hasStd   = icons.some(faviconIsStandard);
  const hasApple = icons.some(faviconIsApple);
  const hasSvg   = icons.some(faviconIsSvg);
  if (hasStd && hasApple && (hasSvg || faviconRasterSizes(icons).size >= 2)) return 'ok';
  if (hasStd || hasApple || hasSvg || (fav && fav.manifestHref)) return 'warning';
  return 'error';
}

function renderFavicon(data) {
  const fav = data.favicon || null;
  const btn = document.getElementById('btn-favicon');
  const summary = document.getElementById('favicon-summary');
  const icons = (fav && fav.icons) || [];

  // The panel is useful even when nothing is declared (checklist + /favicon.ico
  // probe + torch), so keep it openable whenever we have a favicon object.
  btn.disabled = !fav;

  if (!fav || (!icons.length && !fav.manifestHref)) {
    summary.textContent = 'Missing';
    setNavStatus('favicon-status', 'error');
    return;
  }
  summary.textContent = icons.length ? `${icons.length} icon${icons.length !== 1 ? 's' : ''}` : 'Manifest only';
  setNavStatus('favicon-status', faviconStaticLevel(fav));
}

// Human-readable actual pixel size of a probed icon (null until the live check
// resolves, or if it couldn't be measured).
function faviconActualSize(live, href) {
  const r = live && live.results ? live.results[href] : null;
  if (!r) return null;
  if (r.icoSizes && r.icoSizes.length) return r.icoSizes.map(s => `${s.width}×${s.height}`).join(', ');
  if (r.width && r.height) return r.scalable ? `${r.width}×${r.height} (SVG)` : `${r.width}×${r.height}`;
  if (r.scalable) return 'Scalable (SVG)';
  return null;
}

// Per-declared-icon live status chip (pending until the reachability check
// resolves).
function faviconIconChip(live, href) {
  const chip = document.createElement('span');
  const r = live && live.results ? live.results[href] : null;
  if (!r) { chip.className = 'hl-chip hl-chip--pending'; chip.textContent = '…'; return chip; }
  if (r.ok && r.isImage) { chip.className = 'hl-chip hl-chip--ok'; chip.textContent = '✓'; chip.title = `${r.status} · ${r.contentType}`; return chip; }
  if (r.ok && !r.isImage) { chip.className = 'hl-chip hl-chip--warn'; chip.textContent = '!'; chip.title = `Loads but content-type is "${r.contentType || 'unknown'}", not an image`; return chip; }
  chip.className = 'hl-chip hl-chip--err'; chip.textContent = '✗'; chip.title = r.status ? `HTTP ${r.status}` : 'Failed to load';
  return chip;
}

// Hovering a declared-icon row shows the actual image at its actual pixel
// resolution (SVGs — which have no fixed native size — are rendered at a
// fixed 256x256 so they're inspectable). Skipped while the live check is
// still pending or the file failed to load.
let _faviconPreviewEl = null;

function showFaviconPreview(anchorEl, href, live) {
  const r = live && live.results ? live.results[href] : null;
  if (!r || !r.ok || !r.isImage) return;

  if (!_faviconPreviewEl) {
    _faviconPreviewEl = document.createElement('div');
    _faviconPreviewEl.className = 'favicon-img-preview';
    _faviconPreviewEl.appendChild(document.createElement('img')).alt = '';
    const cap = document.createElement('div');
    cap.className = 'favicon-preview-caption';
    _faviconPreviewEl.appendChild(cap);
    document.body.appendChild(_faviconPreviewEl);
  }

  const img = _faviconPreviewEl.querySelector('img');
  const cap = _faviconPreviewEl.querySelector('.favicon-preview-caption');
  img.src = href;

  if (r.scalable) {
    img.style.width = '256px';
    img.style.height = '256px';
    cap.textContent = 'SVG — shown at 256×256';
  } else {
    img.style.width  = r.width  ? `${r.width}px`  : '';
    img.style.height = r.height ? `${r.height}px` : '';
    cap.textContent = r.width && r.height ? `${r.width}×${r.height} — actual size` : 'Size unknown';
  }

  _faviconPreviewEl.classList.add('visible');

  const rect = anchorEl.getBoundingClientRect();
  const maxW = 340;
  _faviconPreviewEl.style.top  = `${rect.bottom + 6}px`;
  _faviconPreviewEl.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - maxW - 6))}px`;
}

function hideFaviconPreview() {
  if (_faviconPreviewEl) _faviconPreviewEl.classList.remove('visible');
}

// Validation checklist rows, grouped to mirror realfavicongenerator.net's
// checker report: { group, label, level: 'pass'|'warn'|'fail' }.
function buildFaviconChecks(fav, live) {
  const icons = (fav && fav.icons) || [];
  const checks = [];
  const std = icons.filter(faviconIsStandard);
  const apple = icons.filter(faviconIsApple);
  const raster = faviconRasterSizes(icons);
  const push = (group, label, level) => checks.push({ group, label, level });

  // ── Classic & SVG favicon ──
  const G1 = 'CLASSIC & SVG FAVICON';
  const icoIcon = icons.find(faviconIsIco);
  const icoUrl = icoIcon ? icoIcon.href : (fav && fav.defaultIcoUrl);
  const icoLive = icoUrl && live && live.results ? live.results[icoUrl] : null;
  const icoWorks = !!(icoLive && icoLive.ok && icoLive.isImage);

  push(G1, std.length ? 'Standard favicon declared (<link rel="icon">)'
    : icoWorks ? 'No <link rel="icon">, but /favicon.ico loads'
    : 'No standard favicon (<link rel="icon"> or /favicon.ico)',
    std.length ? 'pass' : icoWorks ? 'warn' : 'fail');

  push(G1, icons.some(faviconIsSvg) ? 'SVG favicon present' : 'No SVG favicon',
    icons.some(faviconIsSvg) ? 'pass' : 'warn');

  const has96 = raster.has('96x96');
  push(G1, has96 ? '96x96 desktop PNG favicon declared' : 'No 96x96 desktop PNG favicon', has96 ? 'pass' : 'warn');

  push(G1, icoIcon ? 'ICO favicon is declared' : 'No .ico favicon declared (browsers still request /favicon.ico as a fallback)',
    icoIcon ? 'pass' : 'warn');

  if (live) {
    push(G1, icoWorks ? 'ICO favicon found' : 'ICO favicon not found (checked ' + (icoIcon ? 'declared icon' : '/favicon.ico') + ')',
      icoWorks ? 'pass' : 'warn');

    if (icoWorks) {
      const icoDims = new Set((icoLive.icoSizes || []).map(s => `${s.width}x${s.height}`));
      const wantIco = ['16x16', '32x32', '48x48'];
      const missingIco = wantIco.filter(d => !icoDims.has(d));
      push(G1, missingIco.length ? `ICO favicon is missing expected sizes (${missingIco.join(', ')})` : 'ICO favicon has the expected sizes (48x48, 32x32, 16x16)',
        missingIco.length ? 'warn' : 'pass');
    }
  }

  if (icons.length && live && live.results) {
    const declared = icons.map(i => i.href);
    const broken   = declared.filter(h => { const r = live.results[h]; return !r || !r.ok; });
    const notImage = declared.filter(h => { const r = live.results[h]; return r && r.ok && !r.isImage; });
    push(G1, broken.length ? `${broken.length} declared icon${broken.length !== 1 ? 's' : ''} failed to load`
      : notImage.length ? `${notImage.length} icon${notImage.length !== 1 ? 's' : ''} not served as an image`
      : 'All declared icons return 200 and an image type',
      broken.length ? 'fail' : notImage.length ? 'warn' : 'pass');
  }

  const has16 = raster.has('16x16'), has32 = raster.has('32x32');
  push(G1, has16 && has32 ? '16x16 and 32x32 sizes declared'
    : raster.size ? 'Missing a recommended 16x16 or 32x32 size'
    : 'No explicit raster sizes declared (16x16 / 32x32)',
    has16 && has32 ? 'pass' : 'warn');

  // ── Touch icon ──
  const G2 = 'TOUCH ICON';
  const apple180 = apple.some(i => faviconSizeTokens(i).includes('180x180'));
  push(G2, apple180 ? 'Apple touch icon 180x180 present'
    : apple.length ? 'Apple touch icon present but not 180x180'
    : 'No apple-touch-icon (iOS home screen)',
    apple180 ? 'pass' : 'warn');

  push(G2, fav && fav.appleWebAppTitle ? 'Touch web app title declared' : 'No touch web app title declared',
    fav && fav.appleWebAppTitle ? 'pass' : 'warn');

  // ── Web app manifest ──
  const G3 = 'WEB APP MANIFEST';
  if (fav && fav.manifestHref) {
    const m = live && live.manifest;
    if (!m) {
      push(G3, 'Web app manifest referenced', 'pass');
    } else if (!m.ok) {
      push(G3, 'Web app manifest referenced but could not be read', 'warn');
    } else {
      push(G3, 'Web app manifest referenced', 'pass');
      push(G3, m.name ? 'Web app manifest has a name' : 'Web app manifest has no name', m.name ? 'pass' : 'warn');
      push(G3, m.shortName ? 'Web app manifest has a short_name' : 'Web app manifest has no short_name', m.shortName ? 'pass' : 'warn');
      push(G3, m.has192 ? 'Web app manifest has a 192x192 icon' : 'Web app manifest has no 192x192 icon', m.has192 ? 'pass' : 'warn');
      push(G3, m.has512 ? 'Web app manifest has a 512x512 icon' : 'Web app manifest has no 512x512 icon', m.has512 ? 'pass' : 'warn');
      push(G3, m.backgroundColor && m.themeColor ? 'Web app manifest declares background and theme color' : 'Web app manifest is missing a background_color or theme_color',
        m.backgroundColor && m.themeColor ? 'pass' : 'warn');
    }
  } else {
    push(G3, 'No web app manifest (optional, for PWA install)', 'warn');
  }

  return checks;
}

function renderFaviconDetail() {
  const content = document.getElementById('favicon-detail-content');
  if (!content) return;
  content.replaceChildren();

  const fav   = (pageData && pageData.favicon) || null;
  const icons = (fav && fav.icons) || [];
  const sig   = faviconSignature(fav);
  const live  = (fav && _faviconLiveSig === sig) ? _faviconLive : null;

  // ── Declared icons ──
  const tableSec = document.createElement('section');
  tableSec.className = 'field-section';
  const th = document.createElement('div');
  th.className = 'field-header';
  const tl = document.createElement('span');
  tl.className = 'field-label';
  tl.textContent = 'DECLARED ICONS';
  th.appendChild(tl);
  tableSec.appendChild(th);

  if (!icons.length) {
    const hint = document.createElement('div');
    hint.className = 'field-hint hint-muted';
    hint.textContent = 'No <link> icon tags on this page.';
    tableSec.appendChild(hint);
  } else {
    icons.forEach(i => {
      const row = document.createElement('div');
      row.className = 'hl-row';

      const tag = document.createElement('span');
      tag.className = 'hl-lang';
      tag.textContent = faviconSizeTokens(i)[0]
        || (faviconIsApple(i) ? 'apple' : faviconIsMask(i) ? 'mask' : faviconIsSvg(i) ? 'svg' : 'icon');
      tag.title = [i.rel, i.type, i.sizes].filter(Boolean).join(' · ');

      const hrefEl = document.createElement('span');
      hrefEl.className = 'hl-href favicon-href';
      try { const u = new URL(i.href); hrefEl.textContent = u.pathname + (u.search || ''); }
      catch { hrefEl.textContent = i.href || '(empty)'; }
      const actual = faviconActualSize(live, i.href);
      hrefEl.title = (actual ? `Actual size: ${actual}\n` : '') + 'Open in new tab: ' + i.href;
      if (i.href) hrefEl.addEventListener('click', () => browser.tabs.create({ url: i.href }));
      if (actual) tag.title = `${tag.title}\nActual size: ${actual}`;

      if (i.href) {
        row.addEventListener('mouseenter', () => showFaviconPreview(row, i.href, live));
        row.addEventListener('mouseleave', hideFaviconPreview);
      }

      row.append(tag, hrefEl, faviconIconChip(live, i.href));
      tableSec.appendChild(row);
    });
  }
  content.appendChild(tableSec);

  // ── Validation checklist — grouped into sub-sections, one per category ──
  const checksByGroup = new Map();
  buildFaviconChecks(fav, live).forEach(c => {
    if (!checksByGroup.has(c.group)) checksByGroup.set(c.group, []);
    checksByGroup.get(c.group).push(c);
  });

  checksByGroup.forEach((groupChecks, groupName) => {
    const checkSec = document.createElement('section');
    checkSec.className = 'field-section';
    const ch = document.createElement('div');
    ch.className = 'field-header';
    const cl = document.createElement('span');
    cl.className = 'field-label';
    cl.textContent = groupName;
    ch.appendChild(cl);
    checkSec.appendChild(ch);

    groupChecks.forEach(c => {
      const row = document.createElement('div');
      row.className = `hl-check hl-check--${c.level}`;
      const icon = document.createElement('span');
      icon.className = 'hl-check-icon';
      icon.textContent = c.level === 'pass' ? '✓' : c.level === 'warn' ? '!' : '✗';
      const label = document.createElement('span');
      label.className = 'hl-check-label';
      label.textContent = c.label;
      row.append(icon, label);
      checkSec.appendChild(row);
    });
    content.appendChild(checkSec);
  });

  // ── Torch button ──
  const torchSec = document.createElement('section');
  torchSec.className = 'field-section favicon-torch-row';
  const torchBtn = document.createElement('button');
  torchBtn.className = 'adcopy-launch-btn';
  torchBtn.id = 'btn-favicon-torch';
  torchBtn.textContent = 'Wipe Favicon Cache';
  torchBtn.title = 'Force a fresh favicon for this site: replaces this site’s cached favicon copies, then hard-reloads the tab. Other sites are unaffected.';
  torchBtn.addEventListener('click', () => torchFavicon(torchBtn));
  torchSec.appendChild(torchBtn);
  const torchHint = document.createElement('div');
  torchHint.className = 'field-hint hint-muted';
  torchHint.textContent = 'Re-fetches this site’s favicon files and hard-reloads the tab so the new one shows.';
  torchSec.appendChild(torchHint);
  content.appendChild(torchSec);

  // Kick off the live reachability check once per favicon set.
  if (fav && _faviconLiveSig !== sig && !_faviconLoading) faviconRunLiveCheck(fav, sig);
}

async function faviconRunLiveCheck(fav, sig) {
  _faviconLoading = true;
  try {
    const res = await sendMessageWithTimeout({
      action: 'validateFavicon',
      icons: fav.icons, manifestHref: fav.manifestHref, defaultIcoUrl: fav.defaultIcoUrl
    });
    _faviconLive = res || null;
  } catch {
    _faviconLive = null;   // sig still set below → no refetch loop; checks fall back to static
  } finally {
    _faviconLiveSig = sig;
    _faviconLoading = false;
    const panel = document.getElementById('favicon-panel');
    if (panel && !panel.classList.contains('hidden')) renderFaviconDetail();
  }
}

async function torchFavicon(btn) {
  const fav = (pageData && pageData.favicon) || null;
  const urls = [];
  if (fav) {
    (fav.icons || []).forEach(i => { if (i.href) urls.push(i.href); });
    if (fav.defaultIcoUrl) urls.push(fav.defaultIcoUrl);
    if (_faviconLive && _faviconLive.manifest && Array.isArray(_faviconLive.manifest.icons)) {
      _faviconLive.manifest.icons.forEach(ic => { if (ic.href) urls.push(ic.href); });
    }
    if (fav.manifestHref) urls.push(fav.manifestHref);
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Clearing — reloading…';
  try {
    const tab = await getActiveTab();
    await sendMessageWithTimeout({ action: 'clearFaviconCache', tabId: tab && tab.id, urls });
    _faviconLive = null; _faviconLiveSig = null;   // re-probe fresh copies on next open
  } catch {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ─── Render: structured data ─────────────────────────────────────────────────

// Required vs recommended properties per Schema.org type, per Google's
// published Search Gallery structured-data guidelines
// (developers.google.com/search/docs/appearance/structured-data). "required"
// means Google won't show the rich result at all without it; "recommended"
// means the result is eligible but weaker/less featured.
const SCHEMA_GOOGLE_RULES = {
  Article:       { required: ['headline', 'image'],              recommended: ['author', 'datePublished', 'dateModified', 'publisher'] },
  BlogPosting:   { required: ['headline', 'image'],              recommended: ['author', 'datePublished', 'dateModified', 'publisher'] },
  NewsArticle:   { required: ['headline', 'image'],              recommended: ['author', 'datePublished', 'dateModified', 'publisher'] },
  Product:       { required: ['name'],                           recommended: ['image', 'description', 'sku', 'brand', 'offers', 'aggregateRating', 'review'] },
  Recipe:        { required: ['name', 'image'],                  recommended: ['author', 'datePublished', 'description', 'prepTime', 'cookTime', 'totalTime', 'recipeYield', 'recipeIngredient', 'recipeInstructions', 'nutrition', 'aggregateRating', 'video'] },
  Organization:  { required: ['name'],                           recommended: ['logo', 'url', 'sameAs', 'contactPoint'] },
  LocalBusiness: { required: ['name', 'address'],                recommended: ['telephone', 'openingHoursSpecification', 'priceRange', 'geo', 'image'] },
  Event:         { required: ['name', 'startDate', 'location'],  recommended: ['endDate', 'image', 'offers', 'performer', 'organizer', 'eventStatus', 'eventAttendanceMode'] },
  VideoObject:   { required: ['name', 'description', 'thumbnailUrl', 'uploadDate'], recommended: ['duration', 'contentUrl', 'embedUrl'] },
  BreadcrumbList:{ required: ['itemListElement'],                recommended: [] },
  FAQPage:       { required: ['mainEntity'],                     recommended: [] },
  Person:        { required: ['name'],                           recommended: ['url', 'image', 'jobTitle', 'worksFor'] },
  Review:        { required: ['reviewRating', 'author'],         recommended: ['itemReviewed'] },
  AggregateRating:{ required: ['ratingValue', 'reviewCount'],    recommended: ['bestRating', 'worstRating'] },
  JobPosting:    { required: ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation'], recommended: ['validThrough', 'employmentType', 'baseSalary'] },
};

function schemaIsMissing(schema, prop) {
  const v = schema[prop];
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

// Very lightweight format sanity checks — not a full validator, just catches
// the common "technically present but obviously wrong" mistakes (a relative
// or empty string where a URL is expected, an unparseable date).
const SCHEMA_URL_KEYS  = ['url', 'logo', 'thumbnailUrl', 'contentUrl', 'embedUrl'];
const SCHEMA_DATE_KEYS = ['datePublished', 'dateModified', 'startDate', 'endDate', 'uploadDate', 'datePosted', 'validThrough'];

function schemaFormatIssues(node) {
  const issues = [];
  Object.entries(node).forEach(([key, val]) => {
    if (key.startsWith('@') || val == null) return;
    if (SCHEMA_DATE_KEYS.includes(key) && typeof val === 'string' && isNaN(Date.parse(val))) {
      issues.push(`"${key}" doesn't look like a valid date ("${val}")`);
    }
    if (SCHEMA_URL_KEYS.includes(key)) {
      const s = typeof val === 'string' ? val : (val && typeof val === 'object' ? val.url : null);
      if (s && !/^https?:\/\//i.test(s)) issues.push(`"${key}" doesn't look like an absolute URL ("${s}")`);
    }
  });
  return issues;
}

// Worst status across all schemas: red for invalid JSON-LD or a recognized
// type missing a REQUIRED property, amber for a missing recommended property
// or a format issue.
function schemaWorstLevel(schemas, invalidCount) {
  if (invalidCount > 0) return 'error';
  for (const schema of schemas) {
    for (const type of [].concat(schema['@type'])) {
      const rules = SCHEMA_GOOGLE_RULES[type];
      if (rules && rules.required.some(p => schemaIsMissing(schema, p))) return 'error';
    }
  }
  for (const schema of schemas) {
    for (const type of [].concat(schema['@type'])) {
      const rules = SCHEMA_GOOGLE_RULES[type];
      if (rules && rules.recommended.some(p => schemaIsMissing(schema, p))) return 'warning';
    }
    if (schemaFormatIssues(schema).length) return 'warning';
  }
  return 'ok';
}

function renderStructuredData(data) {
  _schemas = data.structuredData ?? [];
  const invalid = data.structuredDataInvalid ?? 0;
  const btn     = document.getElementById('btn-schema');
  const summary = document.getElementById('schema-summary');

  if (!_schemas.length) {
    summary.textContent = invalid ? 'Invalid' : 'None';
    btn.disabled = true;
  } else {
    const types = _schemas.map(s => [].concat(s['@type'])[0]).filter(Boolean);
    summary.textContent = types.length === 1 ? types[0] : `${types.length} types`;
    btn.disabled = false;
  }

  setNavStatus('schema-status', schemaWorstLevel(_schemas, invalid));
}

let _schemaSuggestions = null;
let _schemaSuggestLoading = false;

// How many levels of nested objects/arrays-of-objects to expand inline
// (e.g. WebPage -> address -> PostalAddress fields is depth 1; a further
// nested object inside that would be depth 2, then we stop and just show
// its type/ref so a deeply linked graph can't blow up the panel).
const SCHEMA_MAX_DEPTH = 2;

// A node that's purely a cross-reference into the page's @graph — e.g.
// {"@id":"https://site.com/#website"} with no other fields. Common in
// Yoast/RankMath-style linked schema (isPartOf, breadcrumb, publisher, …).
function schemaIsRefOnly(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  return !!val['@id'] && Object.keys(val).filter(k => k !== '@id').length === 0;
}

// Trim a long @id URL down to its fragment ("#/schema/WebSite") when present,
// since that's the meaningful, stable part for a same-page reference.
function schemaShortRef(id) {
  const s = String(id || '');
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) return s.slice(hashIdx);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

// A value that points at an image file — used to attach a hover preview.
function schemaImageUrl(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return /^https?:\/\/\S+\.(jpe?g|png|webp|gif|svg|avif|bmp|ico)(\?\S*)?$/i.test(t) ? t : null;
}

function appendSchemaRow(container, key, valueText, title) {
  const row = document.createElement('div');
  row.className = 'schema-prop';
  const keyEl = document.createElement('span');
  keyEl.className = 'schema-key';
  keyEl.textContent = key;
  const valEl = document.createElement('span');
  valEl.className = 'schema-val';
  valEl.textContent = valueText;
  if (title) valEl.title = title;
  // Image URL → hover to preview the actual image (reuses the OG preview).
  const imgUrl = schemaImageUrl(valueText);
  if (imgUrl) {
    valEl.classList.add('schema-val--img');
    valEl.addEventListener('mouseenter', () => showImagePreview(imgUrl, valEl));
    valEl.addEventListener('mouseleave', hideImagePreview);
  }
  row.append(keyEl, valEl);
  container.appendChild(row);
}

// Validation summary for one entity: red rows for missing REQUIRED
// properties (Google won't grant the rich result at all), amber rows for
// missing recommended ones or format issues. Nothing rendered for types with
// no known rule set (unchanged from before — we simply don't claim to
// validate what we don't have documented rules for).
function renderSchemaValidation(node, container) {
  const types = [].concat(node['@type']).filter(Boolean);
  const rules = types.map(t => SCHEMA_GOOGLE_RULES[t]).find(Boolean);
  const formatIssues = schemaFormatIssues(node);
  if (!rules && !formatIssues.length) return;

  const missingRequired    = rules ? rules.required.filter(p => schemaIsMissing(node, p)) : [];
  const missingRecommended = rules ? rules.recommended.filter(p => schemaIsMissing(node, p)) : [];

  if (!missingRequired.length && !missingRecommended.length && !formatIssues.length) {
    const ok = document.createElement('div');
    ok.className = 'schema-validation-row schema-validation-row--ok';
    ok.textContent = '✓ Has everything Google documents for this type';
    container.appendChild(ok);
    return;
  }
  if (missingRequired.length) {
    const row = document.createElement('div');
    row.className = 'schema-validation-row schema-validation-row--error';
    row.textContent = `✗ Missing required: ${missingRequired.join(', ')}`;
    container.appendChild(row);
  }
  if (missingRecommended.length) {
    const row = document.createElement('div');
    row.className = 'schema-validation-row schema-validation-row--warning';
    row.textContent = `⚠ Missing recommended: ${missingRecommended.join(', ')}`;
    container.appendChild(row);
  }
  formatIssues.forEach(msg => {
    const row = document.createElement('div');
    row.className = 'schema-validation-row schema-validation-row--warning';
    row.textContent = `⚠ ${msg}`;
    container.appendChild(row);
  });
}

// Renders one schema property. Primitives are a single key:value line.
// A reference into the @graph ({"@id":"..."}) is resolved and inlined as a
// full nested entity card the first time it's encountered (so the hierarchy
// is visible in place, not split across separate top-level cards); if that
// entity was already rendered elsewhere in the tree, it falls back to a
// "→ #fragment" pointer so shared/cyclic references can't loop or duplicate.
// Anonymous (no @id) nested objects/arrays get the same treatment up to
// SCHEMA_MAX_DEPTH, purely to bound worst-case render size.
function renderSchemaValue(key, val, container, depth, byId, seenIds) {
  if (val === undefined || val === null || val === '') return;

  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    appendSchemaRow(container, key, String(val));
    return;
  }

  if (Array.isArray(val)) {
    if (!val.length) return;
    const hasObjects = val.some(v => v && typeof v === 'object');
    if (!hasObjects) {
      appendSchemaRow(container, key, val.map(String).join(', '));
      return;
    }
    appendSchemaRow(container, key, `${val.length} item${val.length !== 1 ? 's' : ''}`);
    const wrapAll = document.createElement('div');
    wrapAll.className = 'schema-nested';
    val.forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      if (schemaIsRefOnly(item)) {
        const target = byId.get(item['@id']);
        if (target && !seenIds.has(item['@id'])) {
          const label = document.createElement('div');
          label.className = 'schema-nested-label';
          const t = target['@type'] ? [].concat(target['@type']).join(' + ') : '';
          label.textContent = `${key}[${i + 1}]` + (t ? ` · ${t}` : '');
          wrapAll.appendChild(label);
          renderSchemaEntityBody(target, wrapAll, byId, seenIds);
        } else {
          appendSchemaRow(wrapAll, `${key}[${i + 1}]`, `→ ${schemaShortRef(item['@id'])}`, item['@id']);
        }
        return;
      }
      const label = document.createElement('div');
      label.className = 'schema-nested-label';
      const itemType = item['@type'] ? [].concat(item['@type']).join(' + ') : '';
      label.textContent = `${key}[${i + 1}]` + (itemType ? ` · ${itemType}` : '');
      wrapAll.appendChild(label);
      if (depth < SCHEMA_MAX_DEPTH) {
        Object.entries(item).forEach(([k, v]) => { if (!k.startsWith('@')) renderSchemaValue(k, v, wrapAll, depth + 1, byId, seenIds); });
      }
    });
    container.appendChild(wrapAll);
    return;
  }

  // Plain object: either a graph reference (resolve + inline once) or an
  // anonymous embedded object (expand its own fields up to the depth cap).
  // Either way the type shows once on the key row; the fields are indented
  // below with no repeated type header (that double-labelling was confusing).
  if (schemaIsRefOnly(val)) {
    const target = byId.get(val['@id']);
    if (target && !seenIds.has(val['@id'])) {
      appendSchemaRow(container, key, [].concat(target['@type']).join(' + ') || '(object)');
      const wrap = document.createElement('div');
      wrap.className = 'schema-nested';
      renderSchemaEntityBody(target, wrap, byId, seenIds);
      container.appendChild(wrap);
    } else {
      appendSchemaRow(container, key, `→ ${schemaShortRef(val['@id'])}`, val['@id']);
    }
    return;
  }
  const ownKeys = Object.keys(val).filter(k => !k.startsWith('@'));
  const typeLabel = val['@type'] ? [].concat(val['@type']).join(' + ') : '';
  appendSchemaRow(container, key, val.name || typeLabel || val.url || '(object)');
  if (!ownKeys.length || depth >= SCHEMA_MAX_DEPTH) return;
  const wrap = document.createElement('div');
  wrap.className = 'schema-nested';
  ownKeys.forEach(k => renderSchemaValue(k, val[k], wrap, depth + 1, byId, seenIds));
  container.appendChild(wrap);
}

// An entity's validation summary + own properties, with NO type header — the
// type is shown by the caller (a blue header for top-level roots, or the key
// row for an inlined linked/nested entity). Shared so both render identically.
function renderSchemaEntityBody(node, container, byId, seenIds) {
  if (node['@id']) seenIds.add(node['@id']);
  renderSchemaValidation(node, container);
  Object.entries(node).forEach(([key, val]) => {
    if (key.startsWith('@')) return;
    renderSchemaValue(key, val, container, 0, byId, seenIds);
  });
}

// A top-level entity card: blue type header + body. Inlined linked entities
// use renderSchemaEntityBody directly (their type is already on the key row).
function renderSchemaEntity(node, container, byId, seenIds) {
  const type = [].concat(node['@type']).join(' + ') || 'Unknown';
  const card = document.createElement('div');
  card.className = 'schema-card';

  const header = document.createElement('div');
  header.className = 'schema-type-name';
  header.textContent = type;
  card.appendChild(header);

  renderSchemaEntityBody(node, card, byId, seenIds);
  container.appendChild(card);
}

// Every @id referenced anywhere within a node's own property values (not
// recursing into other graph nodes — just this node's direct references).
function schemaCollectRefs(node, refs) {
  Object.entries(node).forEach(([k, v]) => {
    if (k.startsWith('@')) return;
    if (Array.isArray(v)) {
      v.forEach(item => { if (item && typeof item === 'object' && item['@id']) refs.add(item['@id']); });
    } else if (v && typeof v === 'object' && v['@id']) {
      refs.add(v['@id']);
    }
  });
}

function renderSchemaDetail() {
  const content = document.getElementById('schema-detail-content');
  content.innerHTML = '';
  if (!_schemas.length) { renderSchemaSuggestions(); return; }

  const byId = new Map();
  _schemas.forEach(s => { if (s && s['@id']) byId.set(s['@id'], s); });

  const referenced = new Set();
  _schemas.forEach(s => schemaCollectRefs(s, referenced));

  // Roots = entities nothing else points to (the natural top of the tree).
  // If every entity is referenced by something (a pure cycle — rare, but
  // possible), fall back to treating them all as roots so nothing vanishes.
  let roots = _schemas.filter(s => !s['@id'] || !referenced.has(s['@id']));
  if (!roots.length) roots = _schemas.slice();

  const seenIds = new Set();
  roots.forEach(root => renderSchemaEntity(root, content, byId, seenIds));

  // Safety net: anything the traversal above never reached still gets its
  // own top-level card, so a full page's structured data is always visible.
  _schemas.forEach(s => {
    if (s['@id'] ? seenIds.has(s['@id']) : roots.includes(s)) return;
    renderSchemaEntity(s, content, byId, seenIds);
  });

  renderSchemaSuggestions();
}

function renderSchemaSuggestions() {
  const content = document.getElementById('schema-detail-content');
  let sec = document.getElementById('schema-suggestions-sec');
  if (!sec) {
    sec = document.createElement('section');
    sec.id = 'schema-suggestions-sec';
    sec.className = 'field-section';
    content.appendChild(sec);
  }
  sec.replaceChildren();

  const h = document.createElement('div');
  h.className = 'field-header';
  const lbl = document.createElement('span');
  lbl.className = 'field-label';
  lbl.textContent = 'SCHEMA SUGGESTIONS';
  h.appendChild(lbl);
  sec.appendChild(h);

  if (_schemaSuggestLoading) {
    const wrap = document.createElement('div');
    wrap.className = 'ap-center';
    wrap.appendChild(svgFromString('<svg class="ap-spinner" viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14 8A6 6 0 1 1 8 2"/></svg>'));
    sec.appendChild(wrap);
    return;
  }

  if (_schemaSuggestions) {
    if (!_schemaSuggestions.length) {
      const hint = document.createElement('div');
      hint.className = 'field-hint hint-muted';
      hint.textContent = 'No additional schema types suggested for this page.';
      sec.appendChild(hint);
      return;
    }
    _schemaSuggestions.forEach(s => {
      const card = document.createElement('div');
      card.className = 'schema-suggestion';
      const top = document.createElement('div');
      top.className = 'schema-suggestion-top';
      const typeLink = document.createElement('a');
      typeLink.className = 'schema-suggestion-type';
      typeLink.textContent = s.type;
      typeLink.href = '#';
      typeLink.addEventListener('click', e => {
        e.preventDefault();
        browser.tabs.create({ url: `https://schema.org/${encodeURIComponent(s.type)}` });
      });
      const badge = document.createElement('span');
      badge.className = `schema-suggestion-priority schema-suggestion-priority--${s.priority}`;
      badge.textContent = s.priority;
      top.append(typeLink, badge);
      const why = document.createElement('div');
      why.className = 'schema-suggestion-why';
      why.textContent = s.why;
      card.append(top, why);
      sec.appendChild(card);
    });
    return;
  }

  // Check for Claude key, then show button or fallback hint
  browser.storage.local.get('claudeApiKey').then(({ claudeApiKey }) => {
    if (!claudeApiKey) {
      const hint = document.createElement('div');
      hint.className = 'field-hint hint-muted';
      hint.textContent = 'Add a Claude API key in Settings to get schema suggestions.';
      sec.appendChild(hint);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'schema-suggest-btn';
    btn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 1l1.4 4.6L14 7l-4.6 1.4L8 13l-1.4-4.6L2 7l4.6-1.4z"/></svg>'));
    btn.appendChild(document.createTextNode(' Suggest with Claude'));
    btn.addEventListener('click', () => loadSchemaSuggestions(claudeApiKey));
    sec.appendChild(btn);
  });
}

async function loadSchemaSuggestions(apiKey) {
  if (_schemaSuggestLoading) return;
  _schemaSuggestLoading = true;
  renderSchemaSuggestions();

  try {
    const pd = pageData || {};
    const existingTypes = (_schemas || []).map(s => [].concat(s['@type'])[0]).filter(Boolean);
    const headings = (pd.headings || [])
      .filter(h => ['h1','h2','h3'].includes(h.tag))
      .slice(0, 10)
      .map(h => `${h.tag.toUpperCase()}: ${h.text}`)
      .join('\n');

    const prompt = [
      pd.canonical   ? `URL: ${pd.canonical}` : '',
      pd.title       ? `Title: "${pd.title.text}"` : '',
      pd.metaDescription ? `Meta description: "${pd.metaDescription.text}"` : '',
      headings       ? `Headings:\n${headings}` : '',
      existingTypes.length ? `Existing schema types: ${existingTypes.join(', ')}` : 'No existing schema markup.',
      pd.bodyTextExcerpt ? `Content excerpt: "${pd.bodyTextExcerpt.slice(0, 500)}"` : ''
    ].filter(Boolean).join('\n');

    const system = `You are a structured data expert. Given a page's content and its existing Schema.org markup, suggest up to 5 additional JSON-LD schema types that would be appropriate and likely to earn Google rich results. Be specific about why each type fits this page. Avoid suggesting types already present.

Respond with ONLY a compact JSON object, no prose, no code fences:
{"suggestions":[{"type":"FAQPage","why":"one sentence explaining why this type fits","priority":"high|medium|low"}]}
priority: high = strong rich-result candidate; medium = useful; low = nice-to-have.`;

    const data = await claudeFetch({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL_LIGHT,
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    let text = claudeText(data).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(text);
    _schemaSuggestions = (parsed.suggestions || []).slice(0, 5).map(s => ({
      type:     String(s.type     || '').trim(),
      why:      String(s.why      || '').trim(),
      priority: ['high','medium','low'].includes(s.priority) ? s.priority : 'medium'
    })).filter(s => s.type);
  } catch (err) {
    _schemaSuggestions = null;
    const sec2 = document.getElementById('schema-suggestions-sec');
    if (sec2) {
      const errEl = document.createElement('div');
      errEl.className = 'field-hint hint-red';
      errEl.textContent = `Error: ${err.message}`;
      sec2.appendChild(errEl);
    }
    _schemaSuggestLoading = false;
    return;
  }
  _schemaSuggestLoading = false;
  renderSchemaSuggestions();
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

function renderLinkOverlayToggle(active) {
  document.getElementById('btn-link-overlay').setAttribute('aria-pressed', String(active));
}

// ─── Render: all ────────────────────────────────────────────────────────────

function render(data, expandMeta = false) {
  pageData = data;
  _schemaSuggestions = null;   // reset on each new page load
  _schemaSuggestLoading = false;
  renderTitle(data);
  renderMeta(data, expandMeta);
  renderWordCount(data);
  renderIndexability(data);
  renderHeadings(data);
  renderCanonical(data);
  renderOpenGraph(data);
  renderStructuredData(data);
  renderHreflang(data);
  renderFavicon(data);
  renderDates(data);
  renderOverlayToggle(data.altOverlayActive);
  renderLinkOverlayToggle(data.linkOverlayActive);
  if (typeof loadBacklinksData === 'function') loadBacklinksData(false);
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function loadData(expandMeta = false, forceRefreshGsc = false) {
  const { charRanges: stored } = await browser.storage.local.get('charRanges');
  charRanges = stored ?? DEFAULT_RANGES;

  const tab = await getActiveTab();
  try {
    const data = await getPageDataFromTab(tab.id);
    document.getElementById('error-state').classList.add('hidden');
    showActiveTab();
    render(data, expandMeta);
    loadGscData(forceRefreshGsc);
    // GA and DNS load lazily per tab; refresh only the one that's visible
    if (activeTab === 'analytics' && typeof loadGaData === 'function') loadGaData(forceRefreshGsc);
    if (activeTab === 'ads' && typeof loadAdsData === 'function') loadAdsData(forceRefreshGsc);
    if (activeTab === 'ranking' && typeof loadWebceoData === 'function') loadWebceoData(false);
    if (activeTab === 'dns' && typeof loadDnsData === 'function') loadDnsData();
    renderRedirectStatus(tab.id, data);
    loadDomainAge(tab);
    if (typeof loadAiInsights === 'function') loadAiInsights(forceRefreshGsc);
    if (typeof hydrateActionPlanNav === 'function') hydrateActionPlanNav();
  } catch {
    // The page's content script didn't answer — most often because this tab
    // was already open before the extension loaded (content scripts only
    // inject on subsequent page loads), or it's a page they can't run on
    // (about:, view-source:, the PDF viewer, etc.). Only the Overview tab
    // depends on that on-page read; the other tabs pull by URL and still
    // work, so keep the tab bar visible and let the user navigate instead of
    // stranding them on a bare error. The banner + hidden Overview content
    // convey the failure without hiding navigation.
    document.getElementById('error-state').classList.remove('hidden');
    mainContent.classList.add('hidden');
    searchTab.classList.add('hidden');
    renderRedirectStatus(tab.id, null);
    // The Search/Analytics/Ads/Tracked/DNS tabs pull by URL, not from the
    // on-page read, so they still work here. Analytics/Ads/Tracked/DNS load
    // lazily on tab-click; GSC is the exception (only the success path above
    // loads it eagerly), so kick it off here too — loadGscData falls back to
    // tab.url when the page's canonical can't be read, so the Search tab
    // populates instead of sitting empty after a failed page read.
    loadGscData(forceRefreshGsc);
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
  if (typeof clearGenResults === 'function') clearGenResults();
  loadData(false, true);
});

// ─── Meta show more/less ─────────────────────────────────────────────────────

document.getElementById('meta-toggle').addEventListener('click', async () => {
  metaExpanded = !metaExpanded;
  const tab = await getActiveTab();
  try {
    const data = await getPageDataFromTab(tab.id);
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

// ─── Link health overlay toggle ──────────────────────────────────────────────

document.getElementById('btn-link-overlay').addEventListener('click', async () => {
  const tab = await getActiveTab();
  try {
    const response = await browser.tabs.sendMessage(tab.id, { action: 'toggleLinkOverlay' });
    renderLinkOverlayToggle(response.linkOverlayActive);
  } catch { /* ignore */ }
});
