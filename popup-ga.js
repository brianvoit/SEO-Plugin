// Google Analytics (GA4) integration: the Analytics tab (traffic chart +
// channel breakdown for the current page) and the Settings connection /
// per-domain property picker. Reuses the generic chart helpers and the
// .gsc-* styles from the Search Console module.

let gaSelectedRange = 30;
let gaActiveMetrics = { sessions: true, users: true, pageviews: true };
let _gaFilled = [];
let _gaHost = null;
let _gaData = null;             // last full gaGetPageData response (to restore on filter clear)
let _gaSelectedChannel = null;  // channel the chart + scorecards are filtered to

function gaFmtPct(v) { return Math.round((v || 0) * 100) + '%'; }
function gaFmtDuration(sec) {
  sec = Math.round(sec || 0);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

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

  // Extra scorecards (display-only, not chart toggles)
  document.getElementById('ga-total-entrances').textContent = Math.round(totals.entrances || 0).toLocaleString();
  renderGscChange('ga-change-entrances', totals.entrances, previousTotals.entrances);

  document.getElementById('ga-total-bounce').textContent = gaFmtPct(totals.bounceRate);
  renderGscChange('ga-change-bounce', totals.bounceRate, previousTotals.bounceRate, { lowerIsBetter: true });

  document.getElementById('ga-total-avgtime').textContent = gaFmtDuration(totals.avgEngagement);
  renderGscChange('ga-change-avgtime', totals.avgEngagement, previousTotals.avgEngagement);

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
  ['Channel', 'Sessions', 'Users', 'Bounce', 'Avg Time', 'Share'].forEach((text, i) => {
    const cell = document.createElement('span');
    cell.className = i === 0 ? 'ga-channel-name' : 'ga-channel-num';
    cell.textContent = text;
    header.appendChild(cell);
  });
  table.appendChild(header);

  channels.forEach(c => {
    const row = document.createElement('div');
    row.className = 'ga-channel-row ga-channel-row--clickable'
      + (c.channel === _gaSelectedChannel ? ' ga-channel-row--selected' : '');
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
    const bounce = document.createElement('span');
    bounce.className = 'ga-channel-num';
    bounce.textContent = gaFmtPct(c.bounceRate);
    const avgTime = document.createElement('span');
    avgTime.className = 'ga-channel-num';
    avgTime.textContent = gaFmtDuration(c.avgEngagement);
    const share = document.createElement('span');
    share.className = 'ga-channel-num';
    share.textContent = ((c.sessions / totalSessions) * 100).toFixed(0) + '%';
    row.append(name, sessions, users, bounce, avgTime, share);
    row.addEventListener('click', () => selectGaChannel(c.channel));
    table.appendChild(row);
  });
}

// ─── Top next pages ────────────────────────────────────────────────────────────

function renderGaNextPages(pages) {
  const list  = document.getElementById('ga-next-pages');
  const empty = document.getElementById('ga-next-pages-empty');
  list.replaceChildren();

  if (!pages || !pages.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  pages.forEach(p => {
    const row = document.createElement('div');
    row.className = 'ga-next-row';
    const path = document.createElement('span');
    path.className = 'ga-next-path';
    path.textContent = p.path;
    const url = gaNextPageUrl(p.path);
    if (url) {
      path.classList.add('ga-next-link');
      path.title = (p.title ? `${p.title}\n` : '') + `Open ${url}`;
      path.addEventListener('click', () => browser.tabs.create({ url }));
    } else {
      path.title = p.title ? `${p.title}\n${p.path}` : p.path;
    }
    const views = document.createElement('span');
    views.className = 'ga-channel-num';
    views.textContent = Math.round(p.pageviews).toLocaleString();
    row.append(path, views);
    list.appendChild(row);
  });
}

// Build an absolute URL for a GA4 page path on the current host
function gaNextPageUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!_gaHost) return null;
  return `https://${_gaHost}${path.startsWith('/') ? '' : '/'}${path}`;
}

// ─── Internal links ───────────────────────────────────────────────────────────

function makeInternalLinkChip(text, cls, title) {
  const chip = document.createElement('span');
  chip.className = `gsc-branded-pill ga-link-chip ${cls}`;
  chip.textContent = text;
  chip.title = title;
  return chip;
}

function renderInternalLinks(links) {
  const list  = document.getElementById('ga-internal-links');
  const empty = document.getElementById('ga-internal-links-empty');
  if (!list) return;
  list.replaceChildren();

  if (!links || !links.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  links.forEach(link => {
    const row = document.createElement('div');
    row.className = 'ga-link-row';

    const dest = document.createElement('span');
    dest.className = 'ga-link-dest';
    dest.textContent = link.href;
    dest.title = link.href;
    if (_gaHost) {
      dest.classList.add('ga-next-link');
      dest.addEventListener('click', () => browser.tabs.create({ url: `https://${_gaHost}${link.href}` }));
    }

    const txt = document.createElement('span');
    txt.className = 'ga-link-text';
    txt.textContent = link.text;
    txt.title = link.text;

    const chips = document.createElement('span');
    chips.className = 'ga-link-chips';

    row.append(dest, txt, chips);
    list.appendChild(row);
  });

  loadInternalLinkChips(links);
}

async function loadInternalLinkChips(links) {
  if (!_gaHost) return;
  const send = msg => sendMessageWithTimeout(msg).catch(() => null);

  // Collect unique destination paths → indices of rows that share that destination
  const destMap = new Map();
  links.forEach((link, idx) => {
    if (!destMap.has(link.href)) destMap.set(link.href, []);
    destMap.get(link.href).push({ text: link.text, idx });
  });

  const uniqueDests = Array.from(destMap.keys()).slice(0, 10);

  await Promise.allSettled(uniqueDests.map(async path => {
    const destUrl = `https://${_gaHost}${path}`;
    const entries = destMap.get(path) || [];

    const [gscRes, adsRes, webceoRes] = await Promise.allSettled([
      send({ action: 'gscGetPageData',    pageUrl: destUrl, range: '90' }),
      send({ action: 'adsGetPageData',    pageUrl: destUrl, range: '90' }),
      send({ action: 'webceoGetRankings', pageUrl: destUrl, historyDepth: 1 })
    ]);

    entries.forEach(({ text, idx }) => {
      const linkList = document.getElementById('ga-internal-links');
      if (!linkList) return;
      const rowEls = linkList.querySelectorAll('.ga-link-row');
      if (!rowEls[idx]) return;
      const chipContainer = rowEls[idx].querySelector('.ga-link-chips');
      if (!chipContainer) return;

      const anchor = text.toLowerCase().trim();

      const gscData = gscRes.status === 'fulfilled' ? gscRes.value : null;
      if (gscData && gscData.connected && Array.isArray(gscData.queries)) {
        if (gscData.queries.some(q => (q.query || '').toLowerCase() === anchor)) {
          chipContainer.appendChild(makeInternalLinkChip('GSC', 'ga-link-chip--gsc',
            'Anchor text appears in Search Console queries for the destination page'));
        }
      }

      const adsData = adsRes.status === 'fulfilled' ? adsRes.value : null;
      if (adsData && adsData.connected) {
        const inKw = (adsData.keywords    || []).some(k => (k.text || '').toLowerCase() === anchor);
        const inSt = (adsData.searchTerms || []).some(k => (k.text || '').toLowerCase() === anchor);
        if (inKw || inSt) {
          chipContainer.appendChild(makeInternalLinkChip('Ads', 'ga-link-chip--ads',
            'Anchor text appears in Google Ads keywords/terms for the destination page'));
        }
      }

      const wcData = webceoRes.status === 'fulfilled' ? webceoRes.value : null;
      if (wcData && wcData.connected && Array.isArray(wcData.rows)) {
        if (wcData.rows.some(r => (r.keyword || '').toLowerCase() === anchor)) {
          chipContainer.appendChild(makeInternalLinkChip('Ranking', 'ga-link-chip--ranking',
            'Anchor text appears in Web CEO tracked keywords for the destination page'));
        }
      }
    });
  }));
}

// ─── Channel cross-filter (chart + scorecards) ──────────────────────────────────

function showGaChannelFilterBar(channel) {
  document.getElementById('ga-channel-filter-text').textContent = channel;
  document.getElementById('ga-channel-filter-bar').classList.remove('hidden');
}

function hideGaChannelFilterBar() {
  document.getElementById('ga-channel-filter-bar').classList.add('hidden');
}

async function applyGaChannelFilter(channel) {
  const tab = await getActiveTab();
  const response = await sendMessageWithTimeout({
    action: 'gaGetChannelData', pageUrl: tab.url, range: gaSelectedRange, channel
  });
  if (_gaSelectedChannel !== channel) return;            // user changed selection meanwhile
  if (!response || !response.connected || response.error) return;
  renderGaCharts(response.timeseries, response.totals, response.previousTotals, gaSelectedRange);
}

function selectGaChannel(channel) {
  if (_gaSelectedChannel === channel) {                  // toggle the same row off
    _gaSelectedChannel = null;
    hideGaChannelFilterBar();
    if (_gaData) {
      renderGaChannels(_gaData.channels || []);
      renderGaCharts(_gaData.timeseries, _gaData.totals, _gaData.previousTotals, gaSelectedRange);
    }
    return;
  }
  _gaSelectedChannel = channel;
  showGaChannelFilterBar(channel);
  if (_gaData) renderGaChannels(_gaData.channels || []);   // refresh the selected-row highlight
  applyGaChannelFilter(channel);
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

  // A fresh load drops any channel filter from the previous page/range
  _gaData = response;
  _gaSelectedChannel = null;
  hideGaChannelFilterBar();

  setGaRangeUI(gaSelectedRange);
  renderGaCharts(response.timeseries, response.totals, response.previousTotals, gaSelectedRange);
  renderGaChannels(response.channels || []);
  renderGaNextPages(response.nextPages || []);
  renderInternalLinks((typeof pageData !== 'undefined' && pageData && pageData.internalLinks) || []);
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

  const response = await sendMessageWithTimeout({
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
      text.textContent = p.displayName;
      opt.append(radio, text);

      if (p.property === detected) {
        const chip = document.createElement('span');
        chip.className = 'ga-detected-chip';
        chip.textContent = 'On page';
        chip.title = opts.detectedId ? `Detected ${opts.detectedId} on this page` : 'Detected on this page';
        opt.appendChild(chip);
      }

      const idEl = document.createElement('span');
      idEl.className = 'gsc-property-id';
      idEl.textContent = p.property.replace('properties/', '#');
      opt.appendChild(idEl);

      opt.addEventListener('click', async () => {
        container.querySelectorAll('.gsc-property-option').forEach(el =>
          el.classList.toggle('gsc-property-option--active', el === opt));
        await sendMessageWithTimeout({ action: 'gaSetProperty', host: _gaHost, property: p.property });
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
  const res = await sendMessageWithTimeout({ action: 'gaResolveProperty', pageUrl: tab.url, measurementId: gaDetectedId() });
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
  const status = await sendMessageWithTimeout({ action: 'gaGetStatus' });

  const badge         = document.getElementById('ga-status-badge');
  const setupForm     = document.getElementById('ga-setup-form');
  const connectedInfo = document.getElementById('ga-connected-info');

  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setupForm.classList.add('hidden');
    connectedInfo.classList.remove('hidden');
    setAccountEmail('ga-account-email', status.email);
    refreshGaPropertyInfo();
  } else {
    badge.textContent = 'Connect';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setupForm.classList.remove('hidden');
    connectedInfo.classList.add('hidden');
    setAccountEmail('ga-account-email', null);
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
  const res = await sendMessageWithTimeout({ action: 'gaResolveProperty', pageUrl: tab.url, measurementId: gaDetectedId() });
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
  // box. The trash unlinks this domain and brings back the searchable picker.
  const selected = res.property || res.detectedProperty;
  const sel = selected && res.properties.find(p => p.property === selected);
  if (sel) {
    renderSelectedRow(allEl, sel.displayName,
      async () => {
        await sendMessageWithTimeout({ action: 'gaSetProperty', host: _gaHost, property: null });
        renderGaPropertyOptions(allEl, res.properties, null, null, { detectedProperty: res.detectedProperty, detectedId: res.detectedId });
      }, sel.property.replace('properties/', '#'));
    return;
  }

  renderGaPropertyOptions(allEl, res.properties, res.property, null,
    { detectedProperty: res.detectedProperty, detectedId: res.detectedId });
}

// Collapsed single-row view of the linked account/property (mirrors the GSC
// connected box). The trash unlinks this domain and brings the picker back.
function renderSelectedRow(container, label, onTrash, id) {
  container.replaceChildren();
  const row = document.createElement('div');
  row.className = 'gsc-property-row';
  const opt = document.createElement('div');
  opt.className = 'gsc-property-option gsc-property-option--active';
  const radio = document.createElement('span');
  radio.className = 'gsc-property-radio';
  const text = document.createElement('span');
  text.className = 'gsc-property-option-text';
  text.textContent = label;
  opt.append(radio, text);
  if (id) {
    const idEl = document.createElement('span');
    idEl.className = 'gsc-property-id';
    idEl.textContent = id;
    opt.appendChild(idEl);
  }
  row.appendChild(opt);
  if (onTrash) row.appendChild(propertyTrashButton('Unlink this domain', onTrash));
  container.appendChild(row);
}

async function connectGa() {
  const badge = document.getElementById('ga-status-badge');
  const errorEl = document.getElementById('ga-connect-error');
  errorEl.classList.add('hidden');

  badge.textContent = 'Connecting…';
  badge.classList.add('is-busy');
  try {
    const result = await sendMessageWithTimeout({ action: 'gaConnect' });
    if (result.error) {
      if (result.error !== 'FLOW_CANCELLED') {
        errorEl.textContent = gscConnectErrorMessage(result.error);
        errorEl.classList.remove('hidden');
        if (typeof revealOauthClientSection === 'function') revealOauthClientSection();
      }
      badge.textContent = 'Connect';
    } else {
      await refreshGaSettingsStatus();
    }
  } finally {
    badge.classList.remove('is-busy');
  }
}

// The chip is a 3-state control: "Connect" when disconnected (click → connect),
// "Connected" otherwise (hover → red "Disconnect", click → disconnect).
document.getElementById('ga-status-badge').addEventListener('click', async (e) => {
  if (e.currentTarget.classList.contains('gsc-status-badge--disconnected')) {
    connectGa();
    return;
  }
  await sendMessageWithTimeout({ action: 'gaDisconnect' });
  await refreshGaSettingsStatus();
});

document.getElementById('btn-ga-goto-settings').addEventListener('click', () => showSettings());

document.getElementById('btn-ga-clear-channel-filter').addEventListener('click', () => {
  if (_gaSelectedChannel) selectGaChannel(_gaSelectedChannel);   // toggles the active channel off
});

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
