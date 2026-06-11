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

// ─── Claude API key ───────────────────────────────────────────────────────────

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
    const saved = document.getElementById('key-saved-msg');
    saved.classList.remove('hidden');
    setTimeout(() => saved.classList.add('hidden'), 2500);
  });
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
