// Google Analytics (GA4) integration: the Analytics tab (traffic chart +
// channel breakdown for the current page) and the Settings connection /
// per-domain property picker. Reuses the generic chart helpers and the
// .gsc-* styles from the Search Console module.

let gaSelectedRange = 30;
let gaActiveMetrics = { sessions: true, users: true, pageviews: true };
let _gaFilled = [];
let _gaHost = null;

const GA_METRICS = {
  sessions:  { label: 'Sessions',  format: n => Math.round(n).toLocaleString() },
  users:     { label: 'Users',     format: n => Math.round(n).toLocaleString() },
  pageviews: { label: 'Pageviews', format: n => Math.round(n).toLocaleString() }
};

const GA_ERROR_MESSAGES = {
  RATE_LIMITED: 'Google Analytics API rate limit reached. Try again in a moment.',
  API_ERROR: 'Google Analytics API error.',
  TOKEN_REFRESH_FAILED: 'Could not refresh your Google Analytics connection. Try reconnecting in Settings.'
};

function gaErrorMessage(error, detail) {
  const base = GA_ERROR_MESSAGES[error] || `Google Analytics error: ${error}`;
  return detail ? `${base} (${detail})` : base;
}

// ─── Chart ────────────────────────────────────────────────────────────────────

function renderGaChart() {
  const container = document.getElementById('ga-chart-combined');
  if (!_gaFilled.length) { container.replaceChildren(); return; }
  const width = container.clientWidth || 320;
  const built = buildCombinedChart(_gaFilled, gaActiveMetrics, { width, metrics: GA_METRICS });
  container.replaceChildren(svgFromString(built.svg));
  attachChartHover(container.querySelector('svg'), _gaFilled, gaActiveMetrics, built);
}

let _gaChartResizeRAF = null;
new ResizeObserver(() => {
  if (_gaChartResizeRAF) return;
  _gaChartResizeRAF = requestAnimationFrame(() => {
    _gaChartResizeRAF = null;
    renderGaChart();
  });
}).observe(document.getElementById('ga-chart-combined'));

function renderGaCharts(timeseries, totals, previousTotals, range) {
  // GA data lags ~1 day (vs. GSC's 3); empty days are zero-filled in GA shape
  _gaFilled = gscFillTimeseries(timeseries, range, 1, () => ({ sessions: 0, users: 0, pageviews: 0 }));

  document.getElementById('ga-total-sessions').textContent = totals.sessions.toLocaleString();
  document.getElementById('ga-total-users').textContent = totals.users.toLocaleString();
  document.getElementById('ga-total-pageviews').textContent = totals.pageviews.toLocaleString();

  renderGscChange('ga-change-sessions', totals.sessions, previousTotals.sessions);
  renderGscChange('ga-change-users', totals.users, previousTotals.users);
  renderGscChange('ga-change-pageviews', totals.pageviews, previousTotals.pageviews);

  renderGaChart();
}

// ─── Channel breakdown ────────────────────────────────────────────────────────

function renderGaChannels(channels) {
  const table = document.getElementById('ga-channels-table');
  const empty = document.getElementById('ga-channels-empty');
  table.replaceChildren();

  if (!channels.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const totalSessions = channels.reduce((sum, c) => sum + c.sessions, 0) || 1;

  const header = document.createElement('div');
  header.className = 'ga-channel-row ga-channel-row--header';
  ['Channel', 'Sessions', 'Users', 'Share'].forEach((text, i) => {
    const cell = document.createElement('span');
    cell.className = i === 0 ? 'ga-channel-name' : 'ga-channel-num';
    cell.textContent = text;
    header.appendChild(cell);
  });
  table.appendChild(header);

  channels.forEach(c => {
    const row = document.createElement('div');
    row.className = 'ga-channel-row';
    const name = document.createElement('span');
    name.className = 'ga-channel-name';
    name.textContent = c.channel;
    name.title = c.channel;
    const sessions = document.createElement('span');
    sessions.className = 'ga-channel-num';
    sessions.textContent = Math.round(c.sessions).toLocaleString();
    const users = document.createElement('span');
    users.className = 'ga-channel-num';
    users.textContent = Math.round(c.users).toLocaleString();
    const share = document.createElement('span');
    share.className = 'ga-channel-num';
    share.textContent = ((c.sessions / totalSessions) * 100).toFixed(0) + '%';
    row.append(name, sessions, users, share);
    table.appendChild(row);
  });
}

// ─── Panel states ─────────────────────────────────────────────────────────────

function setGaRangeUI(range) {
  document.querySelectorAll('#ga-range-group .mode-option').forEach(btn => {
    btn.classList.toggle('is-active', parseInt(btn.dataset.range, 10) === range);
  });
}

function renderGaPanel(response) {
  const notConnected = document.getElementById('ga-not-connected');
  const noProperty   = document.getElementById('ga-no-property');
  const errorBox     = document.getElementById('ga-error');
  const dataBox      = document.getElementById('ga-data');
  [notConnected, noProperty, errorBox, dataBox].forEach(el => el.classList.add('hidden'));

  if (!response || !response.connected) {
    document.getElementById('ga-not-connected-text').textContent = response?.reauthRequired
      ? 'Your Google Analytics connection expired — reconnect it in Settings.'
      : 'Connect Google Analytics in Settings to see traffic data for this page.';
    notConnected.classList.remove('hidden');
    return;
  }

  if (response.error === 'NO_PROPERTY') {
    if (response.host) _gaHost = response.host;
    loadGaPropertyPicker();
    noProperty.classList.remove('hidden');
    return;
  }

  if (response.error) {
    document.getElementById('ga-error-text').textContent = gaErrorMessage(response.error, response.detail);
    errorBox.classList.remove('hidden');
    return;
  }

  setGaRangeUI(gaSelectedRange);
  renderGaCharts(response.timeseries, response.totals, response.previousTotals, gaSelectedRange);
  renderGaChannels(response.channels || []);
  document.getElementById('ga-fetched-meta').textContent =
    `${response.propertyName} · ${response.path} · Updated ${gscRelativeTime(response.fetchedAt)}`;
  dataBox.classList.remove('hidden');
}

// First GA4 measurement ID (G-XXXX) detected on the current page, if any
function gaDetectedId() {
  return (typeof pageData !== 'undefined' && pageData && pageData.gaMeasurementIds && pageData.gaMeasurementIds[0]) || null;
}

async function loadGaData(forceRefresh = false) {
  const tab = await getActiveTab();
  // GA records the live URL's path (unlike GSC, which keys off the canonical)
  const pageUrl = tab.url;
  try { _gaHost = new URL(pageUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { _gaHost = null; }

  const response = await browser.runtime.sendMessage({
    action: 'gaGetPageData', pageUrl, range: gaSelectedRange, forceRefresh, measurementId: gaDetectedId()
  });
  renderGaPanel(response);
}

// ─── Property picker ──────────────────────────────────────────────────────────
// GA4 properties aren't keyed by domain, so the user picks which property
// covers the current host; the choice is stored per domain.

function renderGaPropertyOptions(container, properties, selected, onSelect, opts = {}) {
  container.replaceChildren();

  const detected = opts.detectedProperty || null;
  const highlight = selected || detected;   // suggest the page-detected match when unset

  // Search box (sticky), filters the list as you type
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ga-property-search';
  search.placeholder = 'Search properties or accounts…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  container.appendChild(search);

  // Group by account, sort accounts (and properties within) alphabetically
  const byAccount = new Map();
  properties.forEach(p => {
    const acc = p.account || 'Account';
    if (!byAccount.has(acc)) byAccount.set(acc, []);
    byAccount.get(acc).push(p);
  });
  const accounts = Array.from(byAccount.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  accounts.forEach(account => {
    const props = byAccount.get(account).sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '', undefined, { sensitivity: 'base' }));

    const header = document.createElement('div');
    header.className = 'ga-property-account';
    header.textContent = account;
    header.dataset.account = account.toLowerCase();
    container.appendChild(header);

    props.forEach(p => {
      const opt = document.createElement('button');
      opt.className = 'gsc-property-option' + (p.property === highlight ? ' gsc-property-option--active' : '');
      opt.dataset.search = `${p.displayName} ${account} ${p.property}`.toLowerCase();
      opt.dataset.account = account.toLowerCase();

      const radio = document.createElement('span');
      radio.className = 'gsc-property-radio';
      const text = document.createElement('span');
      text.className = 'gsc-property-option-text';
      text.textContent = `${p.displayName} · ${p.property.replace('properties/', '#')}`;
      opt.append(radio, text);

      if (p.property === detected) {
        const chip = document.createElement('span');
        chip.className = 'ga-detected-chip';
        chip.textContent = 'On page';
        chip.title = opts.detectedId ? `Detected ${opts.detectedId} on this page` : 'Detected on this page';
        opt.appendChild(chip);
      }

      opt.addEventListener('click', async () => {
        container.querySelectorAll('.gsc-property-option').forEach(el =>
          el.classList.toggle('gsc-property-option--active', el === opt));
        await browser.runtime.sendMessage({ action: 'gaSetProperty', host: _gaHost, property: p.property });
        if (onSelect) onSelect();
      });
      container.appendChild(opt);
    });
  });

  // Live filter: hide non-matching options and any account header left empty
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    container.querySelectorAll('.gsc-property-option').forEach(el => {
      el.classList.toggle('hidden', q && !el.dataset.search.includes(q));
    });
    container.querySelectorAll('.ga-property-account').forEach(h => {
      const acc = h.dataset.account;
      const anyVisible = Array.from(container.querySelectorAll('.gsc-property-option'))
        .some(el => el.dataset.account === acc && !el.classList.contains('hidden'));
      h.classList.toggle('hidden', !anyVisible);
    });
  });
}

// Picker inside the Analytics tab's "no property" state
async function loadGaPropertyPicker() {
  const container = document.getElementById('ga-property-picker');
  const emptyEl   = document.getElementById('ga-property-picker-empty');
  container.replaceChildren();
  emptyEl.classList.add('hidden');

  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'gaResolveProperty', pageUrl: tab.url, measurementId: gaDetectedId() });
  if (!res || !res.connected) return;
  if (res.error) {
    emptyEl.textContent = res.error === 'API_ERROR'
      ? `Couldn't list GA4 properties: ${res.detail || 'API error'}. Enable the "Google Analytics Admin API" in your Google Cloud project.`
      : gaErrorMessage(res.error, res.detail);
    emptyEl.classList.remove('hidden');
    return;
  }
  _gaHost = res.host;
  if (!res.properties.length) {
    emptyEl.textContent = 'No GA4 properties on the connected Google account.';
    emptyEl.classList.remove('hidden');
    return;
  }
  renderGaPropertyOptions(container, res.properties, res.property, () => loadGaData(false),
    { detectedProperty: res.detectedProperty, detectedId: res.detectedId });
}

// ─── Settings: connection + property info ─────────────────────────────────────

async function refreshGaSettingsStatus() {
  const status = await browser.runtime.sendMessage({ action: 'gaGetStatus' });

  const badge         = document.getElementById('ga-status-badge');
  const setupForm     = document.getElementById('ga-setup-form');
  const connectedInfo = document.getElementById('ga-connected-info');

  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setupForm.classList.add('hidden');
    connectedInfo.classList.remove('hidden');
    refreshGaPropertyInfo();
  } else {
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setupForm.classList.remove('hidden');
    connectedInfo.classList.add('hidden');
  }
  return status;
}

async function refreshGaPropertyInfo() {
  const matchEl = document.getElementById('ga-property-match');
  const allEl   = document.getElementById('ga-property-all');
  matchEl.textContent = '';
  matchEl.className = 'gsc-property-match hidden';
  matchEl.title = '';
  allEl.replaceChildren();

  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'gaResolveProperty', pageUrl: tab.url, measurementId: gaDetectedId() });
  if (!res || !res.connected) {
    matchEl.textContent = 'Not connected';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  if (res.error) {
    matchEl.textContent = res.error === 'API_ERROR'
      ? 'Enable the "Google Analytics Admin API" in Google Cloud'
      : 'Could not load properties';
    matchEl.title = res.detail || res.error;
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }

  _gaHost = res.host;
  if (!res.properties.length) {
    matchEl.textContent = 'No GA4 properties on this account';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }

  // Once a property is linked, collapse to just that one (green), like the GSC
  // box — the full searchable list returns via "Change".
  const selected = res.property || res.detectedProperty;
  const sel = selected && res.properties.find(p => p.property === selected);
  if (sel) {
    renderSelectedRow(allEl, `${sel.displayName} · ${sel.property.replace('properties/', '#')}`, () =>
      renderGaPropertyOptions(allEl, res.properties, selected, null, { detectedProperty: res.detectedProperty, detectedId: res.detectedId }));
    return;
  }

  renderGaPropertyOptions(allEl, res.properties, res.property, null,
    { detectedProperty: res.detectedProperty, detectedId: res.detectedId });
}

// Collapsed single-row view of the linked account/property (mirrors the GSC
// connected box). Clicking "Change" re-renders the full searchable picker.
function renderSelectedRow(container, label, onChange) {
  container.replaceChildren();
  const opt = document.createElement('div');
  opt.className = 'gsc-property-option gsc-property-option--active';
  const radio = document.createElement('span');
  radio.className = 'gsc-property-radio';
  const text = document.createElement('span');
  text.className = 'gsc-property-option-text';
  text.textContent = label;
  opt.append(radio, text);
  container.appendChild(opt);

  const change = document.createElement('button');
  change.className = 'gsc-change-btn';
  change.textContent = 'Change';
  change.addEventListener('click', onChange);
  container.appendChild(change);
}

document.getElementById('btn-ga-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-ga-connect');
  const errorEl = document.getElementById('ga-connect-error');
  errorEl.classList.add('hidden');

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const result = await browser.runtime.sendMessage({ action: 'gaConnect' });
    if (result.error) {
      if (result.error !== 'FLOW_CANCELLED') {
        errorEl.textContent = gscConnectErrorMessage(result.error);
        errorEl.classList.remove('hidden');
      }
    } else {
      await refreshGaSettingsStatus();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Google Analytics';
  }
});

document.getElementById('btn-ga-disconnect').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ action: 'gaDisconnect' });
  await refreshGaSettingsStatus();
});

document.getElementById('btn-ga-goto-settings').addEventListener('click', () => showSettings());

// ─── Range + metric toggles ───────────────────────────────────────────────────

document.querySelectorAll('#ga-range-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = parseInt(btn.dataset.range, 10);
    if (range === gaSelectedRange) return;
    gaSelectedRange = range;
    setGaRangeUI(range);
    browser.storage.local.set({ gaSelectedRange: range });
    loadGaData(false);
  });
});

document.querySelectorAll('.ga-metric-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const metric = btn.dataset.metric;
    const next = !gaActiveMetrics[metric];
    if (!next && Object.values(gaActiveMetrics).filter(Boolean).length <= 1) return;
    gaActiveMetrics[metric] = next;
    btn.setAttribute('aria-pressed', String(next));
    browser.storage.local.set({ gaActiveMetrics });
    renderGaChart();
  });
});

// ─── Preferences ──────────────────────────────────────────────────────────────

function loadGaPrefs() {
  return browser.storage.local.get(['gaSelectedRange', 'gaActiveMetrics']).then(({ gaSelectedRange: storedRange, gaActiveMetrics: storedMetrics }) => {
    gaSelectedRange = storedRange || 30;
    gaActiveMetrics = storedMetrics || { sessions: true, users: true, pageviews: true };
    setGaRangeUI(gaSelectedRange);
    document.querySelectorAll('.ga-metric-toggle').forEach(btn => {
      btn.setAttribute('aria-pressed', String(gaActiveMetrics[btn.dataset.metric] !== false));
    });
  });
}
