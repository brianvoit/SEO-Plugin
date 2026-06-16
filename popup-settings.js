// Settings panel content: display mode, WordPress sites, branded terms,
// Claude API key, and SEO character-range preferences.

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
    browser.storage.local.set({ displayMode: mode }).then(() => {
      // Pop Out: open (or focus) the window right away so the choice is visible.
      // The toolbar icon reopens it afterwards. Skip if we're already inside it.
      if (mode === 'window' && !document.body.classList.contains('embed-window')) {
        browser.runtime.sendMessage({ action: 'openPopout' }).catch(() => {});
      }
    });
  });
});

// ─── Follow active tab (sidebar / pop-out auto-refresh) ──────────────────────

document.getElementById('btn-follow-tab').addEventListener('click', () => {
  const btn = document.getElementById('btn-follow-tab');
  const next = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(next));
  browser.storage.local.set({ followActiveTab: next });
});

// ─── WordPress sites ──────────────────────────────────────────────────────────

let wpSites = [];

const wpSiteForm = document.getElementById('wp-site-form');

// Build a settings list row: two info lines, an optional edit (pencil) button,
// and a remove button (X icon)
function buildSettingsRow(line1, line2, removeTitle, withEdit) {
  const row = document.createElement('div');
  row.className = 'wp-site-row';

  const info = document.createElement('div');
  info.className = 'wp-site-info';
  const a = document.createElement('span');
  a.className = 'wp-site-url';
  a.textContent = line1;
  const b = document.createElement('span');
  b.className = 'wp-site-user';
  b.textContent = line2;
  info.appendChild(a);
  info.appendChild(b);
  row.appendChild(info);

  // Edit + remove grouped together on the right
  const actions = document.createElement('div');
  actions.className = 'wp-site-actions';

  let editBtn = null;
  if (withEdit) {
    editBtn = document.createElement('button');
    editBtn.className = 'wp-site-edit icon-btn';
    editBtn.title = 'Edit';
    editBtn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z"/></svg>'));
    actions.appendChild(editBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'wp-site-remove icon-btn';
  removeBtn.title = removeTitle;
  removeBtn.appendChild(svgFromString('<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11"/><path d="M6 4V2.8a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8V4"/><path d="M3.6 4l.6 8.5a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.4 4"/><line x1="6.6" y1="6.4" x2="6.8" y2="11"/><line x1="9.4" y1="6.4" x2="9.2" y2="11"/></svg>'));
  actions.appendChild(removeBtn);

  row.appendChild(actions);
  return { row, removeBtn, editBtn };
}

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

    const { row, removeBtn } = buildSettingsRow(host, site.username, 'Remove site');
    removeBtn.dataset.index = i;
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
    const { row, removeBtn, editBtn } = buildSettingsRow(host, `/${allBrandedTerms[host]}/i`, 'Remove', true);
    removeBtn.dataset.host = host;
    editBtn.addEventListener('click', () => openBrandEdit(host));
    list.appendChild(row);
  });

  list.querySelectorAll('.wp-site-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      delete allBrandedTerms[btn.dataset.host];
      browser.storage.local.set({ brandedTerms: allBrandedTerms }).then(renderBrandDomains);
    });
  });
}

// Open the branded-terms form pre-filled to edit an existing domain. The host
// is the storage key, so it's locked while editing — saving overwrites the regex.
function openBrandEdit(host) {
  document.getElementById('brand-domain-error').classList.add('hidden');
  const hostInput = document.getElementById('brand-domain-host');
  hostInput.value = host;
  hostInput.readOnly = true;
  document.getElementById('brand-domain-pattern').value = allBrandedTerms[host] || '';
  brandDomainForm.classList.remove('hidden');
  document.getElementById('brand-domain-pattern').focus();
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
  const hostInput = document.getElementById('brand-domain-host');
  hostInput.readOnly = false;
  hostInput.value = (host && !allBrandedTerms[host]) ? host : '';
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

// ─── Claude API key ───────────────────────────────────────────────────────────

// Two states: empty (editable input + reveal eye + Save) and stored (locked,
// masked, no reveal — only a trash button to clear it and re-enter from scratch).
function setKeyState(hasKey) {
  const input = document.getElementById('api-key-input');
  document.getElementById('btn-toggle-key-vis').classList.toggle('hidden', hasKey);
  document.getElementById('btn-clear-key').classList.toggle('hidden', !hasKey);
  document.getElementById('btn-save-key').classList.toggle('hidden', hasKey);

  if (hasKey) {
    input.type = 'password';
    input.readOnly = true;
    input.value = '';
    input.placeholder = '••••••••••••  saved';
    document.getElementById('icon-eye-open').classList.remove('hidden');
    document.getElementById('icon-eye-closed').classList.add('hidden');
  } else {
    input.type = 'password';
    input.readOnly = false;
    input.value = '';
    input.placeholder = 'sk-ant-api03-…';
  }
}

// Show/hide the key only while entering a new one (never once stored)
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
  if (!key) return;
  browser.storage.local.set({ claudeApiKey: key }).then(() => {
    setKeyState(true);
    const saved = document.getElementById('key-saved-msg');
    saved.classList.remove('hidden');
    setTimeout(() => saved.classList.add('hidden'), 2500);
  });
});

// Clear (trash) — wipes the key and returns to the empty, editable state
document.getElementById('btn-clear-key').addEventListener('click', () => {
  browser.storage.local.remove('claudeApiKey').then(() => setKeyState(false));
});

// ─── SEO character ranges ────────────────────────────────────────────────────

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
