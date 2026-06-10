const MAX_WORDS = 25;
const MAX_CHARS = 180;

const GITHUB_REPO = 'brianvoit/SEO-Plugin';

const DEFAULT_RANGES = {
  title: { min: 30, target: 55, max: 70 },
  meta:  { min: 70, target: 155, max: 160 }
};

// Cached after load; used in every render
let charRanges = DEFAULT_RANGES;

const store = { title: '', meta: '', canonical: '' };
let metaExpanded = false;

// Most recently loaded page data, used as context for AI generation
let pageData = null;
const genSuggestions = { title: '', meta: '' };

// Google Search Console state
let gscSelectedRange = 30;
let gscHideBranded = true;
let allBrandedTerms = {};
let _gscPageUrl = null;
let _gscSiteUrl = null;
let _gscQueries = [];

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

function countColorClass(count, ranges) {
  const { min, target, max } = ranges;
  if (count < min || count > max) return 'is-count-red';
  if (count < target) return 'is-count-amber';
  return 'is-count-green';
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Render: word count ──────────────────────────────────────────────────────

function renderWordCount(data) {
  const count = data.bodyWordCount ?? 0;
  const mins  = Math.max(1, Math.round(count / 200));
  document.getElementById('wordcount-text').textContent =
    `${count.toLocaleString()} words · ~${mins} min read`;
}

// ─── Render: indexability ────────────────────────────────────────────────────

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

function renderIndexability(data) {
  const list = document.getElementById('indexability-list');
  list.innerHTML = '';
  const { noindex, nofollow, canonicalMismatch, canonicalUrl } = data.indexability;

  const issues = [];
  if (noindex)          issues.push({ level: 'error',   text: 'noindex — excluded from search results' });
  if (canonicalMismatch) issues.push({ level: 'warning', text: `Canonical → ${canonicalUrl}` });
  if (nofollow)         issues.push({ level: 'warning', text: 'nofollow — outbound links not followed' });

  (issues.length ? issues : [{ level: 'ok', text: 'Indexable' }]).forEach(({ level, text }) => appendIndexRow(list, level, text));
}

// ─── Render: open graph ──────────────────────────────────────────────────────

const OG_KEYS = ['og:title','og:description','og:image','og:type','og:url'];
const TW_KEYS = ['twitter:card','twitter:title','twitter:image'];

function renderOpenGraph(data) {
  const list = document.getElementById('og-list');
  list.innerHTML = '';
  const { og, twitter } = data.openGraph;
  const hasTwitter = TW_KEYS.some(k => twitter[k] !== undefined);

  OG_KEYS.forEach(key => appendOGRow(list, key, og[key]));
  if (hasTwitter) TW_KEYS.forEach(key => appendOGRow(list, key, twitter[key]));
}

function appendOGRow(container, key, value) {
  const row   = document.createElement('div');
  row.className = 'og-row';
  const label = key.replace('og:','').replace('twitter:','tw:');
  const present = value !== undefined && value !== null && value !== '';

  row.innerHTML = present
    ? `<span class="og-key">${escapeHtml(label)}</span><span class="og-value" title="${escapeHtml(value)}">${escapeHtml(value.length > 45 ? value.slice(0,45)+'…' : value)}</span>`
    : `<span class="og-key">${escapeHtml(label)}</span><span class="og-missing">missing</span>`;

  container.appendChild(row);
}

// ─── Render: structured data ─────────────────────────────────────────────────

let _schemas = [];

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

function formatDate(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    if (isNaN(d.getTime())) return str;
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return str; }
}

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
  updateGscSummary();
}

// ─── Data loading ────────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadData(expandMeta = false) {
  const { charRanges: stored } = await browser.storage.local.get('charRanges');
  charRanges = stored ?? DEFAULT_RANGES;

  const tab = await getActiveTab();
  try {
    const data = await browser.tabs.sendMessage(tab.id, { action: 'getPageData' });
    document.getElementById('error-state').classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');
    render(data, expandMeta);
  } catch {
    document.getElementById('error-state').classList.remove('hidden');
    document.getElementById('content').classList.add('hidden');
  }
}

// ─── Copy buttons ────────────────────────────────────────────────────────────

document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    await copyToClipboard(store[btn.dataset.copyTarget] ?? '');
    flashCopyBtn(btn);
  });
});

// ─── Generate title/meta with Claude ────────────────────────────────────────

const GEN_FIELD_LABELS = { title: 'title tag', meta: 'meta description' };

async function generateField(field) {
  const btn     = document.getElementById(`btn-generate-${field}`);
  const result  = document.getElementById(`${field}-gen-result`);
  const textEl  = document.getElementById(`${field}-gen-text`);
  const metaEl  = document.getElementById(`${field}-gen-meta`);

  if (!pageData || btn.disabled) return;

  btn.disabled = true;
  btn.querySelector('.icon-generate').classList.add('hidden');
  btn.querySelector('.icon-spinner').classList.remove('hidden');
  result.classList.remove('hidden', 'is-error');
  textEl.textContent = 'Generating…';
  metaEl.textContent = '';
  metaEl.className = 'gen-result-meta';

  try {
    const { claudeApiKey } = await browser.storage.local.get('claudeApiKey');
    if (!claudeApiKey) throw new Error('No Claude API key — add one in Settings (⚙).');

    const tab = await getActiveTab();
    const ranges = charRanges[field];
    const fieldLabel = GEN_FIELD_LABELS[field];
    const pageUrl = pageData.canonical || tab.url;

    let host = '';
    try { host = new URL(pageUrl, tab.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const brandTerms = (allBrandedTerms[host] || '')
      .split('|')
      .map(s => s.trim())
      .filter(Boolean);

    const context = [
      `Page URL: ${pageUrl}`,
      `Current title tag: "${pageData.title.text}"`,
      pageData.metaDescription && `Current meta description: "${pageData.metaDescription.text}"`,
      pageData.headings.length && `Headings:\n${pageData.headings.map(h => `${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`,
      pageData.bodyTextExcerpt && `Page content excerpt: "${pageData.bodyTextExcerpt}"`
    ].filter(Boolean).join('\n\n');

    const system = `You are an SEO copywriter. Write a single replacement ${fieldLabel} for the page described below.
- Do not include the site name, brand name, or company name${brandTerms.length ? ` (e.g., ${brandTerms.join(', ')})` : ''}.
- Be specific and relevant to the page's actual topic and primary keywords. Do not invent facts not supported by the page content.
- Target length: ${ranges.min}-${ranges.max} characters, ideally close to ${ranges.target} characters.
- Return only the ${fieldLabel} text, nothing else — no quotes, no labels, no explanation.`;

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
        max_tokens: 200,
        system,
        messages: [{ role: 'user', content: context }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    const suggestion = data.content?.[0]?.text?.trim();
    if (!suggestion) throw new Error('Empty response from Claude');

    genSuggestions[field] = suggestion;
    textEl.textContent = suggestion;
    metaEl.textContent = `${suggestion.length} chars`;
    metaEl.className = 'gen-result-meta ' + countColorClass(suggestion.length, ranges);
  } catch (err) {
    result.classList.add('is-error');
    textEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.querySelector('.icon-generate').classList.remove('hidden');
    btn.querySelector('.icon-spinner').classList.add('hidden');
  }
}

document.querySelectorAll('.gen-btn').forEach(btn => {
  btn.addEventListener('click', () => generateField(btn.dataset.field));
});

document.querySelectorAll('[id$="-gen-copy"]').forEach(btn => {
  btn.addEventListener('click', async () => {
    await copyToClipboard(genSuggestions[btn.dataset.field] ?? '');
    flashCopyBtn(btn);
  });
});

document.querySelectorAll('[id$="-gen-dismiss"]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(`${btn.dataset.field}-gen-result`).classList.add('hidden');
  });
});

// ─── Refresh button ──────────────────────────────────────────────────────────

document.getElementById('btn-refresh').addEventListener('click', () => {
  metaExpanded = false;
  loadData(false);
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

// ─── Settings panel ──────────────────────────────────────────────────────────

const settingsPanel = document.getElementById('settings-panel');
const schemaPanel   = document.getElementById('schema-panel');
const gscPanel      = document.getElementById('gsc-panel');
const mainContent   = document.getElementById('content');
const updateFooter  = document.getElementById('update-footer');
const errorBanner   = document.getElementById('error-state');

function showSchemaPanel() {
  if (!_schemas.length) return;
  mainContent.classList.add('hidden');
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  settingsPanel.classList.add('hidden');
  gscPanel.classList.add('hidden');
  schemaPanel.classList.remove('hidden');
  document.getElementById('btn-refresh').classList.add('hidden');
  renderSchemaDetail();
}

function hideSchemaPanel() {
  schemaPanel.classList.add('hidden');
  updateFooter.classList.remove('hidden');
  document.getElementById('btn-refresh').classList.remove('hidden');
  mainContent.classList.remove('hidden');
}

function showSettings() {
  mainContent.classList.add('hidden');
  schemaPanel.classList.add('hidden');
  gscPanel.classList.add('hidden');
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  settingsPanel.classList.remove('hidden');
  document.getElementById('btn-refresh').classList.add('hidden');

  browser.storage.local.get(['claudeApiKey', 'charRanges', 'displayMode', 'gscClientId', 'gscClientSecret']).then(({ claudeApiKey, charRanges: stored, displayMode, gscClientId, gscClientSecret }) => {
    document.getElementById('api-key-input').value = claudeApiKey ?? '';
    document.getElementById('key-saved-msg').classList.add('hidden');
    document.getElementById('key-hint').classList.remove('hidden');

    const ranges = stored ?? DEFAULT_RANGES;
    document.getElementById('title-min').value    = ranges.title.min;
    document.getElementById('title-target').value = ranges.title.target;
    document.getElementById('title-max').value    = ranges.title.max;
    document.getElementById('meta-min').value     = ranges.meta.min;
    document.getElementById('meta-target').value  = ranges.meta.target;
    document.getElementById('meta-max').value     = ranges.meta.max;

    document.getElementById('gsc-client-id').value     = gscClientId ?? '';
    document.getElementById('gsc-client-secret').value = gscClientSecret ?? '';

    setDisplayModeUI(displayMode || 'popup');
  });

  loadWpSites();
  refreshGscSettingsStatus();
  loadBrandedTerms();
}

function hideSettings() {
  settingsPanel.classList.add('hidden');
  updateFooter.classList.remove('hidden');
  document.getElementById('btn-refresh').classList.remove('hidden');
  loadData(metaExpanded);
}

document.getElementById('btn-settings').addEventListener('click', showSettings);
document.getElementById('btn-settings-back').addEventListener('click', hideSettings);
document.getElementById('btn-schema').addEventListener('click', showSchemaPanel);
document.getElementById('btn-schema-back').addEventListener('click', hideSchemaPanel);

// ─── Display mode (popup vs. sidebar) ────────────────────────────────────────

function setDisplayModeUI(mode) {
  document.querySelectorAll('#display-mode-group .mode-option').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  });
}

document.querySelectorAll('#display-mode-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    setDisplayModeUI(mode);
    browser.storage.local.set({ displayMode: mode });
  });
});

// ─── WordPress sites ──────────────────────────────────────────────────────────

let wpSites = [];

const wpSiteForm = document.getElementById('wp-site-form');

function renderWpSites() {
  const list  = document.getElementById('wp-sites-list');
  const empty = document.getElementById('wp-sites-empty');
  list.innerHTML = '';

  if (!wpSites.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  wpSites.forEach((site, i) => {
    let host = site.url;
    try { host = new URL(site.url).hostname; } catch { /* keep raw url */ }

    const row = document.createElement('div');
    row.className = 'wp-site-row';
    row.innerHTML = `
      <div class="wp-site-info">
        <span class="wp-site-url">${escapeHtml(host)}</span>
        <span class="wp-site-user">${escapeHtml(site.username)}</span>
      </div>
      <button class="wp-site-remove icon-btn" title="Remove site" data-index="${i}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="3" x2="13" y2="13"/>
          <line x1="13" y1="3" x2="3" y2="13"/>
        </svg>
      </button>`;
    list.appendChild(row);
  });

  list.querySelectorAll('.wp-site-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      wpSites.splice(parseInt(btn.dataset.index, 10), 1);
      browser.storage.local.set({ wpSites }).then(renderWpSites);
    });
  });
}

function loadWpSites() {
  browser.storage.local.get('wpSites').then(({ wpSites: stored }) => {
    wpSites = stored ?? [];
    renderWpSites();
  });
}

document.getElementById('btn-add-wp-site').addEventListener('click', () => {
  document.getElementById('wp-site-url').value = '';
  document.getElementById('wp-site-username').value = '';
  document.getElementById('wp-site-app-password').value = '';
  wpSiteForm.classList.remove('hidden');
});

document.getElementById('btn-cancel-wp-site').addEventListener('click', () => {
  wpSiteForm.classList.add('hidden');
});

document.getElementById('btn-save-wp-site').addEventListener('click', () => {
  const url         = document.getElementById('wp-site-url').value.trim().replace(/\/+$/, '');
  const username    = document.getElementById('wp-site-username').value.trim();
  const appPassword = document.getElementById('wp-site-app-password').value.trim();

  if (!url || !username || !appPassword) return;

  const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  wpSites.push({ url: normalizedUrl, username, appPassword });
  browser.storage.local.set({ wpSites }).then(() => {
    renderWpSites();
    wpSiteForm.classList.add('hidden');
  });
});

// ─── Google Search Console: helpers ──────────────────────────────────────────

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function gscRelativeTime(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const GSC_ERROR_MESSAGES = {
  RATE_LIMITED: 'Search Console API rate limit reached. Try again in a moment.',
  API_ERROR: 'Search Console API error.',
  TOKEN_REFRESH_FAILED: 'Could not refresh your Google connection. Try reconnecting in Settings.'
};

function gscErrorMessage(error, detail) {
  const base = GSC_ERROR_MESSAGES[error] || `Search Console error: ${error}`;
  return detail ? `${base} (${detail})` : base;
}

const GSC_CONNECT_ERRORS = {
  NO_CLIENT_ID: 'Enter an OAuth Client ID first.',
  STATE_MISMATCH: 'Authorization response did not match — please try again.',
  NO_CODE: 'Google did not return an authorization code.',
  TOKEN_EXCHANGE_FAILED: 'Could not exchange the authorization code for tokens. Check your Client ID/Secret.'
};

function gscConnectErrorMessage(error) {
  return GSC_CONNECT_ERRORS[error] || `Connection failed: ${error}`;
}

// ─── Google Search Console: chart helper ─────────────────────────────────────

function buildLineChart(points, { width = 320, height = 80, formatValue = String, invertY = false } = {}) {
  const padL = 28, padR = 4, padT = 8, padB = 14;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const values = points.map(p => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const range = (max - min) || 1;
  const xFor = i => padL + (i / (points.length - 1 || 1)) * innerW;
  const yFor = v => { const t = (v - min) / range; return padT + (invertY ? t : 1 - t) * innerH; };
  const linePoints = points.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)}`).join(' ');
  const areaPoints = `${linePoints} ${xFor(points.length - 1).toFixed(1)},${(padT+innerH).toFixed(1)} ${padL},${(padT+innerH).toFixed(1)}`;
  const topLabel = invertY ? formatValue(min) : formatValue(max);
  const bottomLabel = invertY ? formatValue(max) : formatValue(min);
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <line class="gsc-chart-gridline" x1="${padL}" y1="${padT}" x2="${width-padR}" y2="${padT}" />
    <line class="gsc-chart-gridline" x1="${padL}" y1="${padT+innerH}" x2="${width-padR}" y2="${padT+innerH}" />
    <text class="gsc-chart-axis-label" x="0" y="${padT+4}">${escapeHtml(topLabel)}</text>
    <text class="gsc-chart-axis-label" x="0" y="${padT+innerH+2}">${escapeHtml(bottomLabel)}</text>
    <polygon class="gsc-chart-area" points="${areaPoints}" />
    <polyline class="gsc-chart-line" points="${linePoints}" />
    <text class="gsc-chart-axis-label" x="${padL}" y="${height-2}">${escapeHtml(formatDateShort(points[0].date))}</text>
    <text class="gsc-chart-axis-label" x="${width-padR}" y="${height-2}" text-anchor="end">${escapeHtml(formatDateShort(points[points.length-1].date))}</text>
  </svg>`;
}

function renderGscChange(elId, current, previous, { lowerIsBetter = false } = {}) {
  const el = document.getElementById(elId);
  if (!previous) { el.textContent = current ? 'New' : ''; el.className = 'gsc-chart-change'; return; }
  const pct = ((current - previous) / previous) * 100;
  const improved = lowerIsBetter ? pct < 0 : pct > 0;
  const arrow = pct >= 0 ? '▲' : '▼';
  el.textContent = `${arrow} ${Math.abs(pct).toFixed(0)}%`;
  el.className = `gsc-chart-change ${pct === 0 ? '' : improved ? 'gsc-chart-change--up' : 'gsc-chart-change--down'}`;
}

function gscFillTimeseries(timeseries, range) {
  const map = new Map(timeseries.map(d => [d.date, d]));
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const result = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    result.push(map.get(dateStr) || { date: dateStr, clicks: 0, impressions: 0, ctr: 0, position: 0 });
  }
  return result;
}

function renderGscCharts(timeseries, totals, previousTotals, range) {
  const filled = gscFillTimeseries(timeseries, range);

  document.getElementById('gsc-total-clicks').textContent = totals.clicks.toLocaleString();
  document.getElementById('gsc-total-impressions').textContent = totals.impressions.toLocaleString();
  document.getElementById('gsc-total-position').textContent = totals.position ? totals.position.toFixed(1) : '—';

  renderGscChange('gsc-change-clicks', totals.clicks, previousTotals.clicks);
  renderGscChange('gsc-change-impressions', totals.impressions, previousTotals.impressions);
  renderGscChange('gsc-change-position', totals.position, previousTotals.position, { lowerIsBetter: true });

  document.getElementById('gsc-chart-clicks').innerHTML = buildLineChart(
    filled.map(d => ({ date: d.date, value: d.clicks })),
    { formatValue: n => Math.round(n).toLocaleString() }
  );
  document.getElementById('gsc-chart-impressions').innerHTML = buildLineChart(
    filled.map(d => ({ date: d.date, value: d.impressions })),
    { formatValue: n => Math.round(n).toLocaleString() }
  );

  const positionPoints = filled
    .filter(d => d.impressions > 0)
    .map(d => ({ date: d.date, value: d.position }));
  document.getElementById('gsc-chart-position').innerHTML = positionPoints.length
    ? buildLineChart(positionPoints, { invertY: true, formatValue: n => n.toFixed(1) })
    : '';
}

// ─── Google Search Console: queries table ────────────────────────────────────

function isQueryBranded(query, pattern) {
  if (!pattern) return false;
  try { return new RegExp(pattern, 'i').test(query); } catch { return false; }
}

function buildQueryRow(cells, isHeader = false, branded = false) {
  const row = document.createElement('div');
  row.className = 'gsc-query-row' + (isHeader ? ' gsc-query-row--header' : '') + (branded ? ' gsc-query-row--branded' : '');
  const [query, clicks, impressions, ctr, position] = cells;
  const queryCell = isHeader
    ? `<span>${escapeHtml(query)}</span>`
    : `<span class="gsc-query-text" title="${escapeHtml(query)}">${escapeHtml(query)}${branded ? '<span class="gsc-branded-pill">Brand</span>' : ''}</span>`;
  row.innerHTML = `${queryCell}<span class="gsc-query-num">${escapeHtml(String(clicks))}</span><span class="gsc-query-num">${escapeHtml(String(impressions))}</span><span class="gsc-query-num">${escapeHtml(String(ctr))}</span><span class="gsc-query-num">${escapeHtml(String(position))}</span>`;
  return row;
}

function renderGscQueries(queries, pageUrl) {
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  const pattern = allBrandedTerms[host] || '';
  const container = document.getElementById('gsc-queries-table');
  container.innerHTML = '';

  if (!queries.length) {
    document.getElementById('gsc-queries-empty').classList.remove('hidden');
    return;
  }

  container.appendChild(buildQueryRow(['Query', 'Clicks', 'Impr.', 'CTR', 'Pos.'], true));
  let shown = 0;
  queries.forEach(q => {
    const branded = isQueryBranded(q.query, pattern);
    if (gscHideBranded && branded) return;
    shown++;
    container.appendChild(buildQueryRow(
      [q.query, q.clicks, q.impressions, (q.ctr * 100).toFixed(1) + '%', q.position.toFixed(1)],
      false, branded
    ));
  });
  document.getElementById('gsc-queries-empty').classList.toggle('hidden', shown > 0);
}

// ─── Google Search Console: indexing status ──────────────────────────────────

function renderGscInspection(inspection, error) {
  const list = document.getElementById('gsc-inspection-list');
  list.innerHTML = '';

  if (!inspection) {
    appendIndexRow(list, 'warning', error ? `Could not check indexing status (${error})` : 'Indexing status unavailable');
    return;
  }

  const { verdict, coverageState, indexingState, lastCrawlTime, googleCanonical, userCanonical } = inspection;

  let level = 'ok';
  if (verdict === 'FAIL') level = 'error';
  else if (verdict !== 'PASS') level = 'warning';
  appendIndexRow(list, level, coverageState || 'Unknown coverage status');

  if (lastCrawlTime) {
    appendIndexRow(list, 'ok', `Last crawled ${formatDate(lastCrawlTime)}`);
  } else {
    appendIndexRow(list, 'warning', 'Not yet crawled by Google');
  }

  if (googleCanonical && userCanonical && googleCanonical !== userCanonical) {
    appendIndexRow(list, 'warning', `Google's canonical: ${googleCanonical}`);
  }

  if (indexingState && indexingState !== 'INDEXING_ALLOWED') {
    appendIndexRow(list, 'error', `Indexing blocked: ${indexingState.replace(/_/g, ' ').toLowerCase()}`);
  }
}

// ─── Google Search Console: detail panel ─────────────────────────────────────

function setGscRangeUI(range) {
  document.querySelectorAll('#gsc-range-group .mode-option').forEach(btn => {
    btn.classList.toggle('is-active', parseInt(btn.dataset.range, 10) === range);
  });
}

function renderGscPanel(response, pageUrl) {
  const notConnected = document.getElementById('gsc-not-connected');
  const noProperty   = document.getElementById('gsc-no-property');
  const errorBox     = document.getElementById('gsc-error');
  const dataBox      = document.getElementById('gsc-data');
  const refreshBtn   = document.getElementById('btn-gsc-refresh');

  notConnected.classList.add('hidden');
  noProperty.classList.add('hidden');
  errorBox.classList.add('hidden');
  dataBox.classList.add('hidden');
  refreshBtn.classList.add('hidden');

  if (!response.connected) {
    document.getElementById('gsc-not-connected-text').textContent = response.reauthRequired
      ? 'Your Google connection expired — reconnect Search Console in Settings.'
      : 'Connect Google Search Console in Settings to see performance data for this page.';
    notConnected.classList.remove('hidden');
    return;
  }

  if (response.error === 'NO_PROPERTY') {
    let host = pageUrl;
    try { host = new URL(pageUrl).hostname; } catch { /* keep raw */ }
    document.getElementById('gsc-no-property-host').textContent = host;
    noProperty.classList.remove('hidden');
    refreshBtn.classList.remove('hidden');
    return;
  }

  if (response.error) {
    document.getElementById('gsc-error-text').textContent = gscErrorMessage(response.error, response.detail);
    errorBox.classList.remove('hidden');
    refreshBtn.classList.remove('hidden');
    return;
  }

  _gscSiteUrl = response.siteUrl;
  _gscQueries = response.queries || [];
  _gscPageUrl = pageUrl;

  setGscRangeUI(gscSelectedRange);
  renderGscCharts(response.overview.timeseries, response.overview.totals, response.overview.previousTotals, gscSelectedRange);
  renderGscQueries(_gscQueries, pageUrl);
  renderGscInspection(response.inspection, response.inspectionError);

  document.getElementById('gsc-fetched-meta').textContent =
    `Updated ${gscRelativeTime(response.fetchedAt)} · Recent days may be revised by Google`;

  dataBox.classList.remove('hidden');
  refreshBtn.classList.remove('hidden');
}

async function loadGscData(forceRefresh = false) {
  const tab = await getActiveTab();
  let pageUrl = tab.url;
  try {
    const data = await browser.tabs.sendMessage(tab.id, { action: 'getPageData' });
    if (data?.canonical) pageUrl = data.canonical;
  } catch { /* fall back to tab.url */ }

  const response = await browser.runtime.sendMessage({ action: 'gscGetPageData', pageUrl, range: gscSelectedRange, forceRefresh });
  renderGscPanel(response, pageUrl);
}

function showGscPanel() {
  mainContent.classList.add('hidden');
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  settingsPanel.classList.add('hidden');
  schemaPanel.classList.add('hidden');
  gscPanel.classList.remove('hidden');
  document.getElementById('btn-refresh').classList.add('hidden');
  loadGscData(false);
}

function hideGscPanel() {
  gscPanel.classList.add('hidden');
  updateFooter.classList.remove('hidden');
  document.getElementById('btn-refresh').classList.remove('hidden');
  mainContent.classList.remove('hidden');
}

function updateGscSummary() {
  browser.runtime.sendMessage({ action: 'gscGetStatus' }).then(status => {
    document.getElementById('gsc-summary').textContent = status.connected ? 'Connected' : 'Not connected';
  }).catch(() => { /* ignore */ });
}

document.getElementById('btn-gsc').addEventListener('click', showGscPanel);
document.getElementById('btn-gsc-back').addEventListener('click', hideGscPanel);
document.getElementById('btn-gsc-refresh').addEventListener('click', () => loadGscData(true));

document.getElementById('btn-gsc-goto-settings').addEventListener('click', () => {
  gscPanel.classList.add('hidden');
  showSettings();
});

document.getElementById('btn-gsc-open-external').addEventListener('click', () => {
  if (!_gscSiteUrl || !_gscPageUrl) return;
  browser.tabs.create({ url: 'https://search.google.com/search-console/inspect?resource_id=' + encodeURIComponent(_gscSiteUrl) + '&id=' + encodeURIComponent(_gscPageUrl) });
});

document.querySelectorAll('#gsc-range-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = parseInt(btn.dataset.range, 10);
    if (range === gscSelectedRange) return;
    gscSelectedRange = range;
    setGscRangeUI(range);
    browser.storage.local.set({ gscSelectedRange: range });
    loadGscData(false);
  });
});

document.getElementById('btn-gsc-branded-toggle').addEventListener('click', () => {
  gscHideBranded = !gscHideBranded;
  document.getElementById('btn-gsc-branded-toggle').setAttribute('aria-pressed', String(gscHideBranded));
  browser.storage.local.set({ gscHideBranded });
  if (_gscPageUrl) renderGscQueries(_gscQueries, _gscPageUrl);
});

// ─── Google Search Console: settings connection ──────────────────────────────

async function refreshGscSettingsStatus() {
  const status = await browser.runtime.sendMessage({ action: 'gscGetStatus' });
  document.getElementById('gsc-redirect-uri').value = status.redirectUri;

  const badge         = document.getElementById('gsc-status-badge');
  const setupForm     = document.getElementById('gsc-setup-form');
  const connectedInfo = document.getElementById('gsc-connected-info');

  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setupForm.classList.add('hidden');
    connectedInfo.classList.remove('hidden');
    document.getElementById('gsc-connected-since').textContent = status.connectedAt
      ? `Connected since ${formatDate(new Date(status.connectedAt))}`
      : '';
  } else {
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setupForm.classList.remove('hidden');
    connectedInfo.classList.add('hidden');
  }

  return status;
}

document.getElementById('btn-copy-redirect-uri').addEventListener('click', async (e) => {
  await copyToClipboard(document.getElementById('gsc-redirect-uri').value);
  flashCopyBtn(e.currentTarget);
});

document.getElementById('btn-gsc-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-gsc-connect');
  const errorEl = document.getElementById('gsc-connect-error');
  errorEl.classList.add('hidden');

  const clientId     = document.getElementById('gsc-client-id').value.trim();
  const clientSecret = document.getElementById('gsc-client-secret').value.trim();

  if (!clientId) {
    errorEl.textContent = gscConnectErrorMessage('NO_CLIENT_ID');
    errorEl.classList.remove('hidden');
    return;
  }

  await browser.storage.local.set({ gscClientId: clientId, gscClientSecret: clientSecret });

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const result = await browser.runtime.sendMessage({ action: 'gscConnect' });
    if (result.error) {
      if (result.error !== 'FLOW_CANCELLED') {
        errorEl.textContent = gscConnectErrorMessage(result.error);
        errorEl.classList.remove('hidden');
      }
    } else {
      await refreshGscSettingsStatus();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Google Search Console';
  }
});

document.getElementById('btn-gsc-disconnect').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ action: 'gscDisconnect' });
  await refreshGscSettingsStatus();
});

// ─── Branded terms ────────────────────────────────────────────────────────────

const brandDomainForm = document.getElementById('brand-domain-form');

function renderBrandDomains() {
  const list  = document.getElementById('brand-domains-list');
  const empty = document.getElementById('brand-domains-empty');
  list.innerHTML = '';

  const hosts = Object.keys(allBrandedTerms);
  if (!hosts.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  hosts.forEach(host => {
    const row = document.createElement('div');
    row.className = 'wp-site-row';
    row.innerHTML = `
      <div class="wp-site-info">
        <span class="wp-site-url">${escapeHtml(host)}</span>
        <span class="wp-site-user">/${escapeHtml(allBrandedTerms[host])}/i</span>
      </div>
      <button class="wp-site-remove icon-btn" title="Remove" data-host="${escapeHtml(host)}">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="3" x2="13" y2="13"/>
          <line x1="13" y1="3" x2="3" y2="13"/>
        </svg>
      </button>`;
    list.appendChild(row);
  });

  list.querySelectorAll('.wp-site-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      delete allBrandedTerms[btn.dataset.host];
      browser.storage.local.set({ brandedTerms: allBrandedTerms }).then(renderBrandDomains);
    });
  });
}

function loadBrandedTerms() {
  return browser.storage.local.get('brandedTerms').then(({ brandedTerms }) => {
    allBrandedTerms = brandedTerms ?? {};
    renderBrandDomains();
  });
}

document.getElementById('btn-add-brand-domain').addEventListener('click', async () => {
  document.getElementById('brand-domain-error').classList.add('hidden');
  let host = '';
  try {
    const tab = await getActiveTab();
    host = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch { /* ignore */ }
  document.getElementById('brand-domain-host').value = (host && !allBrandedTerms[host]) ? host : '';
  document.getElementById('brand-domain-pattern').value = '';
  brandDomainForm.classList.remove('hidden');
});

document.getElementById('btn-cancel-brand-domain').addEventListener('click', () => {
  brandDomainForm.classList.add('hidden');
});

document.getElementById('btn-save-brand-domain').addEventListener('click', () => {
  const host    = document.getElementById('brand-domain-host').value.trim().replace(/^www\./, '').toLowerCase();
  const pattern = document.getElementById('brand-domain-pattern').value.trim();
  const errorEl = document.getElementById('brand-domain-error');
  errorEl.classList.add('hidden');

  if (!host || !pattern) {
    errorEl.textContent = 'Domain and pattern are required.';
    errorEl.classList.remove('hidden');
    return;
  }
  try {
    new RegExp(pattern, 'i');
  } catch (err) {
    errorEl.textContent = `Invalid regex: ${err.message}`;
    errorEl.classList.remove('hidden');
    return;
  }

  allBrandedTerms[host] = pattern;
  browser.storage.local.set({ brandedTerms: allBrandedTerms }).then(() => {
    renderBrandDomains();
    brandDomainForm.classList.add('hidden');
  });
});

function loadGscPrefs() {
  return browser.storage.local.get(['gscSelectedRange', 'gscHideBranded', 'brandedTerms']).then(({ gscSelectedRange: storedRange, gscHideBranded: storedHide, brandedTerms }) => {
    gscSelectedRange = storedRange || 30;
    gscHideBranded = storedHide !== undefined ? storedHide : true;
    allBrandedTerms = brandedTerms ?? {};
    setGscRangeUI(gscSelectedRange);
    document.getElementById('btn-gsc-branded-toggle').setAttribute('aria-pressed', String(gscHideBranded));
  });
}

// ─── Sidebar embed mode ───────────────────────────────────────────────────────

if (browser.extension.getViews({ type: 'sidebar' }).includes(window)) {
  document.body.classList.add('embed-sidebar');
}

// Show/hide API key
document.getElementById('btn-toggle-key-vis').addEventListener('click', () => {
  const input     = document.getElementById('api-key-input');
  const eyeOpen   = document.getElementById('icon-eye-open');
  const eyeClosed = document.getElementById('icon-eye-closed');
  const isHidden  = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  eyeOpen.classList.toggle('hidden', isHidden);
  eyeClosed.classList.toggle('hidden', !isHidden);
});

// Save API key
document.getElementById('btn-save-key').addEventListener('click', () => {
  const key = document.getElementById('api-key-input').value.trim();
  browser.storage.local.set({ claudeApiKey: key }).then(() => {
    document.getElementById('key-hint').classList.add('hidden');
    const saved = document.getElementById('key-saved-msg');
    saved.classList.remove('hidden');
    setTimeout(() => {
      saved.classList.add('hidden');
      document.getElementById('key-hint').classList.remove('hidden');
    }, 2500);
  });
});

// Auto-save ranges on change (debounced)
let rangesSaveTimer = null;

function saveRanges() {
  clearTimeout(rangesSaveTimer);
  rangesSaveTimer = setTimeout(() => {
    const updated = {
      title: {
        min:    parseInt(document.getElementById('title-min').value,    10) || DEFAULT_RANGES.title.min,
        target: parseInt(document.getElementById('title-target').value, 10) || DEFAULT_RANGES.title.target,
        max:    parseInt(document.getElementById('title-max').value,    10) || DEFAULT_RANGES.title.max,
      },
      meta: {
        min:    parseInt(document.getElementById('meta-min').value,    10) || DEFAULT_RANGES.meta.min,
        target: parseInt(document.getElementById('meta-target').value, 10) || DEFAULT_RANGES.meta.target,
        max:    parseInt(document.getElementById('meta-max').value,    10) || DEFAULT_RANGES.meta.max,
      }
    };
    browser.storage.local.set({ charRanges: updated }).then(() => {
      charRanges = updated;
      const saved = document.getElementById('key-saved-msg-ranges');
      saved.classList.remove('hidden');
      setTimeout(() => saved.classList.add('hidden'), 2000);
    });
  }, 600);
}

['title-min','title-target','title-max','meta-min','meta-target','meta-max']
  .forEach(id => document.getElementById(id).addEventListener('input', saveRanges));

// ─── Update checker ──────────────────────────────────────────────────────────

const currentVersion = browser.runtime.getManifest().version;
document.getElementById('update-version').textContent = `v${currentVersion}`;

async function checkForUpdates() {
  const btn      = document.getElementById('btn-check-update');
  const statusEl = document.getElementById('update-status');

  btn.disabled = true;
  btn.textContent = 'Checking…';
  statusEl.className = 'update-status hidden';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const data = await res.json();
    const latest = data.tag_name?.replace(/^v/, '') ?? null;
    if (!latest) throw new Error('Could not read version from GitHub');

    statusEl.classList.remove('hidden', 'is-available', 'is-error');

    if (latest === currentVersion) {
      statusEl.textContent = 'Up to date';
    } else {
      statusEl.textContent = `v${latest} available →`;
      statusEl.classList.add('is-available');
      statusEl.title = 'Click to view release on GitHub';
      statusEl.addEventListener('click', () => {
        browser.tabs.create({ url: `https://github.com/${GITHUB_REPO}/releases/latest` });
      }, { once: true });
    }
  } catch (err) {
    statusEl.classList.remove('hidden', 'is-available');
    statusEl.classList.add('is-error');
    statusEl.textContent = 'Check failed';
    statusEl.title = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
}

document.getElementById('btn-check-update').addEventListener('click', checkForUpdates);

// ─── Init ────────────────────────────────────────────────────────────────────

loadData();
loadGscPrefs();
