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

function renderIndexability(data) {
  const list = document.getElementById('indexability-list');
  list.innerHTML = '';
  const { noindex, nofollow, canonicalMismatch, canonicalUrl } = data.indexability;

  const issues = [];
  if (noindex)          issues.push({ level: 'error',   text: 'noindex — excluded from search results' });
  if (canonicalMismatch) issues.push({ level: 'warning', text: `Canonical → ${canonicalUrl}` });
  if (nofollow)         issues.push({ level: 'warning', text: 'nofollow — outbound links not followed' });

  (issues.length ? issues : [{ level: 'ok', text: 'Indexable' }]).forEach(({ level, text }) => {
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
  });
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
const mainContent   = document.getElementById('content');
const updateFooter  = document.getElementById('update-footer');
const errorBanner   = document.getElementById('error-state');

function showSchemaPanel() {
  if (!_schemas.length) return;
  mainContent.classList.add('hidden');
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  settingsPanel.classList.add('hidden');
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
  updateFooter.classList.add('hidden');
  errorBanner.classList.add('hidden');
  settingsPanel.classList.remove('hidden');
  document.getElementById('btn-refresh').classList.add('hidden');

  browser.storage.local.get(['claudeApiKey', 'charRanges', 'displayMode']).then(({ claudeApiKey, charRanges: stored, displayMode }) => {
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

    setDisplayModeUI(displayMode || 'popup');
  });

  loadWpSites();
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

// ─── Sidebar embed mode ───────────────────────────────────────────────────────

if (browser.extension.getViews({ type: 'sidebar' }).includes(window)) {
  document.body.classList.add('embed-sidebar');
  const closeBtn = document.getElementById('btn-close-sidebar');
  closeBtn.classList.remove('hidden');
  closeBtn.addEventListener('click', () => {
    browser.sidebarAction.close();
  });
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
