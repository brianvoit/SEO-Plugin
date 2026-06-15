// Google Ads (GAQL) tab: the paid campaigns / ad groups / ads pointing at the
// evaluated page, plus the keywords and search terms driving it. Mirrors the
// Analytics tab's look-back + per-domain account picker, and reuses the Search
// tab's on-page location flags (gscQueryLocations).

let adsSelectedRange = 30;
let _adsHost = null;

const ADS_TOKEN_HELP = 'https://developers.google.com/google-ads/api/docs/get-started/dev-token';

const ADS_ERROR_MESSAGES = {
  RATE_LIMITED: 'Google Ads API rate limit reached. Try again in a moment.',
  API_ERROR: 'Google Ads API error.',
  NETWORK: 'Network error talking to Google Ads.',
  NO_DEV_TOKEN: 'Add your Google Ads developer token in Settings.',
  TOKEN_REFRESH_FAILED: 'Could not refresh your Google connection. Reconnect in Settings.'
};
function adsErrorMessage(error, detail) {
  const base = ADS_ERROR_MESSAGES[error] || `Google Ads error: ${error}`;
  return detail ? `${base} (${detail})` : base;
}

// ─── Formatting ────────────────────────────────────────────────────────────────

function adsNum(n) { return Math.round(n).toLocaleString(); }
function adsConv(n) { return (Math.round(n * 10) / 10).toLocaleString(); }
function adsCost(n, currency) {
  if (currency) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n); }
    catch { /* fall through */ }
  }
  return n.toFixed(2);
}
function adsPct(v) { return v == null ? '—' : `${Math.round(v * 100)}%`; }

// Organic overlap: queries this page also ranks for in Search Console
function adsOrganicSet() {
  const set = new Set();
  if (typeof _gscQueries !== 'undefined' && Array.isArray(_gscQueries)) {
    _gscQueries.forEach(q => set.add((q.query || '').toLowerCase().trim()));
  }
  return set;
}

// Chips for a keyword/search term: on-page locations + an Organic pill
function adsTermChips(text, organicSet) {
  const wrap = document.createElement('span');
  wrap.className = 'gsc-query-chips';
  if (organicSet.has((text || '').toLowerCase().trim())) {
    const pill = document.createElement('span');
    pill.className = 'gsc-branded-pill ads-organic-pill';
    pill.textContent = 'Organic';
    pill.title = 'This page also ranks for this term organically (Search Console)';
    wrap.appendChild(pill);
  }
  (typeof gscQueryLocations === 'function' ? gscQueryLocations(text, pageData) : []).forEach(loc => {
    const chip = document.createElement('span');
    chip.className = 'gsc-chip';
    chip.textContent = loc;
    wrap.appendChild(chip);
  });
  return wrap.childNodes.length ? wrap : null;
}

// ─── Campaign → ad group → ad tree ──────────────────────────────────────────────

function renderAdsTree(ads, campaigns, currency) {
  const root = document.getElementById('ads-tree');
  root.replaceChildren();
  const isByCampaign = new Map(campaigns.map(c => [c.id, c]));

  // group ads: campaignId → adGroupId → [ads]
  const byCampaign = new Map();
  ads.forEach(a => {
    if (!byCampaign.has(a.campaignId)) byCampaign.set(a.campaignId, { name: a.campaign, groups: new Map() });
    const groups = byCampaign.get(a.campaignId).groups;
    if (!groups.has(a.adGroupId)) groups.set(a.adGroupId, { name: a.adGroup, ads: [] });
    groups.get(a.adGroupId).ads.push(a);
  });

  byCampaign.forEach((camp, campId) => {
    const cRow = document.createElement('div');
    cRow.className = 'ads-campaign';
    const cName = document.createElement('span');
    cName.className = 'ads-campaign-name';
    cName.textContent = camp.name;
    cRow.appendChild(cName);
    const is = isByCampaign.get(campId);
    if (is && is.impressionShare != null) {
      const chip = document.createElement('span');
      chip.className = 'ads-is-chip';
      chip.textContent = `IS ${adsPct(is.impressionShare)}`;
      chip.title = `Search impression share ${adsPct(is.impressionShare)}` +
        (is.lostRank != null ? ` · lost to rank ${adsPct(is.lostRank)}` : '') +
        (is.lostBudget != null ? ` · lost to budget ${adsPct(is.lostBudget)}` : '');
      cRow.appendChild(chip);
    }
    root.appendChild(cRow);

    camp.groups.forEach(group => {
      const gRow = document.createElement('div');
      gRow.className = 'ads-group';
      gRow.textContent = group.name;
      root.appendChild(gRow);

      group.ads.forEach(ad => {
        const aRow = document.createElement('div');
        aRow.className = 'ads-ad';
        const head = document.createElement('div');
        head.className = 'ads-ad-head';
        head.textContent = `${ad.type || 'Ad'}${ad.adName ? ' · ' + ad.adName : ''} · #${ad.adId}`;
        const metrics = document.createElement('div');
        metrics.className = 'ads-ad-metrics';
        metrics.textContent = `${adsNum(ad.impressions)} impr · ${adsNum(ad.clicks)} clk · ${adsCost(ad.cost, currency)} · ${adsConv(ad.conversions)} conv`;
        aRow.append(head, metrics);
        root.appendChild(aRow);
      });
    });
  });
}

// ─── Keyword + search-term tables ───────────────────────────────────────────────

function buildAdsMetricTable(container, rows, { withQs = false } = {}) {
  container.replaceChildren();
  const organic = adsOrganicSet();

  const header = document.createElement('div');
  header.className = 'ads-row ads-row--header' + (withQs ? ' ads-row--kw' : '');
  const cols = withQs ? ['Keyword', 'QS', 'Impr', 'Clicks', 'Cost', 'Conv'] : ['Search term', 'Impr', 'Clicks', 'Cost', 'Conv'];
  cols.forEach((c, i) => {
    const cell = document.createElement('span');
    cell.className = i === 0 ? 'ads-cell-term' : 'ads-cell-num';
    cell.textContent = c;
    header.appendChild(cell);
  });
  container.appendChild(header);

  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'ads-row' + (withQs ? ' ads-row--kw' : '');

    const term = document.createElement('span');
    term.className = 'ads-cell-term';
    const label = document.createElement('span');
    label.className = 'ads-term-text';
    label.textContent = r.text || '(none)';
    label.title = r.text || '';
    term.appendChild(label);
    if (r.matchType) {
      const mt = document.createElement('span');
      mt.className = 'ads-match';
      mt.textContent = r.matchType.toLowerCase();
      term.appendChild(mt);
    }
    const chips = adsTermChips(r.text, organic);
    if (chips) term.appendChild(chips);
    row.appendChild(term);

    if (withQs) {
      const qs = document.createElement('span');
      qs.className = 'ads-cell-num';
      if (r.qualityScore != null) {
        const badge = document.createElement('span');
        badge.className = 'ads-qs ' + (r.qualityScore >= 7 ? 'ads-qs--good' : r.qualityScore >= 4 ? 'ads-qs--ok' : 'ads-qs--bad');
        badge.textContent = r.qualityScore;
        qs.appendChild(badge);
      } else {
        qs.textContent = '—';
      }
      row.appendChild(qs);
    }

    [adsNum(r.impressions), adsNum(r.clicks), adsCost(r.cost, container._currency), adsConv(r.conversions)].forEach(v => {
      const cell = document.createElement('span');
      cell.className = 'ads-cell-num';
      cell.textContent = v;
      row.appendChild(cell);
    });
    container.appendChild(row);
  });
}

// ─── Panel + states ──────────────────────────────────────────────────────────

function setAdsRangeUI(range) {
  document.querySelectorAll('#ads-range-group .mode-option').forEach(btn =>
    btn.classList.toggle('is-active', parseInt(btn.dataset.range, 10) === range));
}

function renderAdsPanel(response) {
  const ids = ['ads-not-connected', 'ads-no-token', 'ads-no-account', 'ads-error', 'ads-data'];
  ids.forEach(id => document.getElementById(id).classList.add('hidden'));

  if (!response || !response.connected) {
    document.getElementById('ads-not-connected-text').textContent = response?.reauthRequired
      ? 'Your Google Ads connection expired — reconnect it in Settings.'
      : 'Connect Google Ads in Settings to see the paid campaigns, keywords, and search terms pointing to this page.';
    document.getElementById('ads-not-connected').classList.remove('hidden');
    return;
  }
  if (response.error === 'NO_DEV_TOKEN') {
    document.getElementById('ads-no-token').classList.remove('hidden');
    return;
  }
  if (response.error === 'NO_ACCOUNT') {
    if (response.host) _adsHost = response.host;
    loadAdsAccountPicker(document.getElementById('ads-account-picker'), document.getElementById('ads-account-picker-empty'), document.getElementById('ads-tab-account-search'), () => loadAdsData(false));
    document.getElementById('ads-no-account').classList.remove('hidden');
    return;
  }
  if (response.error) {
    document.getElementById('ads-error-text').textContent = adsErrorMessage(response.error, response.detail);
    document.getElementById('ads-error').classList.remove('hidden');
    return;
  }

  setAdsRangeUI(adsSelectedRange);
  const hasAds = (response.ads || []).length > 0;
  document.getElementById('ads-none').classList.toggle('hidden', hasAds);
  ['ads-campaigns-section', 'ads-keywords-section', 'ads-terms-section'].forEach(id =>
    document.getElementById(id).classList.toggle('hidden', !hasAds));

  if (hasAds) {
    renderAdsTree(response.ads, response.campaigns || [], response.currency);
    const kt = document.getElementById('ads-keywords-table'); kt._currency = response.currency;
    buildAdsMetricTable(kt, response.keywords || [], { withQs: true });
    const tt = document.getElementById('ads-terms-table'); tt._currency = response.currency;
    buildAdsMetricTable(tt, response.searchTerms || []);
  }
  document.getElementById('ads-fetched-meta').textContent =
    `Account ${response.account} · ${response.path} · Updated ${gscRelativeTime(response.fetchedAt)}`;
  document.getElementById('ads-data').classList.remove('hidden');
}

async function loadAdsData(forceRefresh = false) {
  const tab = await getActiveTab();
  try { _adsHost = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { _adsHost = null; }
  const response = await browser.runtime.sendMessage({ action: 'adsGetPageData', pageUrl: tab.url, range: adsSelectedRange, forceRefresh });
  renderAdsPanel(response);
}

// ─── Account picker (per-domain, mirrors the GA property picker) ─────────────────

function renderAdsAccountOptions(container, accounts, selected, onSelect) {
  container.replaceChildren();

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ga-property-search';
  search.placeholder = 'Search accounts…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  container.appendChild(search);

  accounts
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
    .forEach(acc => {
      const opt = document.createElement('button');
      opt.className = 'gsc-property-option' + (acc.id === selected ? ' gsc-property-option--active' : '');
      opt.dataset.search = `${acc.name} ${acc.id}`.toLowerCase();
      const radio = document.createElement('span');
      radio.className = 'gsc-property-radio';
      const text = document.createElement('span');
      text.className = 'gsc-property-option-text';
      text.textContent = `${acc.name} · #${acc.id}`;
      opt.append(radio, text);
      opt.addEventListener('click', async () => {
        container.querySelectorAll('.gsc-property-option').forEach(el =>
          el.classList.toggle('gsc-property-option--active', el === opt));
        await browser.runtime.sendMessage({ action: 'adsSetAccount', host: _adsHost, account: acc.id });
        if (onSelect) onSelect();
      });
      container.appendChild(opt);
    });

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    container.querySelectorAll('.gsc-property-option').forEach(el =>
      el.classList.toggle('hidden', q && !el.dataset.search.includes(q)));
  });
}

// Shared loader used by both the tab's no-account state and the Settings box
async function loadAdsAccountPicker(container, emptyEl, _unusedSearch, onSelect) {
  container.replaceChildren();
  if (emptyEl) emptyEl.classList.add('hidden');
  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'adsResolveAccount', pageUrl: tab.url });
  if (!res || !res.connected) return;
  if (res.error) {
    if (emptyEl) { emptyEl.textContent = adsErrorMessage(res.error, res.detail); emptyEl.classList.remove('hidden'); }
    return;
  }
  _adsHost = res.host;
  if (!res.accounts.length) {
    if (emptyEl) { emptyEl.textContent = 'No Google Ads accounts available on the connected login.'; emptyEl.classList.remove('hidden'); }
    return;
  }
  renderAdsAccountOptions(container, res.accounts, res.account, onSelect);
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function refreshAdsSettingsStatus() {
  const status = await browser.runtime.sendMessage({ action: 'adsGetStatus' });
  const badge   = document.getElementById('ads-status-badge');
  const setup   = document.getElementById('ads-setup-form');
  const info    = document.getElementById('ads-connected-info');

  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setup.classList.add('hidden');
    info.classList.remove('hidden');
    browser.storage.local.get(['adsDeveloperToken', 'adsManagerId']).then(({ adsDeveloperToken, adsManagerId }) => {
      document.getElementById('ads-dev-token').value = adsDeveloperToken || '';
      document.getElementById('ads-manager-id').value = adsManagerId || '';
    });
    refreshAdsAccountInfo();
  } else {
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setup.classList.remove('hidden');
    info.classList.add('hidden');
  }
  return status;
}

async function refreshAdsAccountInfo() {
  const matchEl = document.getElementById('ads-account-match');
  const allEl   = document.getElementById('ads-account-all');
  matchEl.className = 'gsc-property-match hidden';
  allEl.replaceChildren();

  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'adsResolveAccount', pageUrl: tab.url });
  if (!res || !res.connected) return;
  if (res.error) {
    matchEl.textContent = res.error === 'NO_DEV_TOKEN' ? 'Add a developer token above to list accounts' : adsErrorMessage(res.error, res.detail);
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  _adsHost = res.host;
  if (!res.accounts.length) {
    matchEl.textContent = 'No accounts on the connected login';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  renderAdsAccountOptions(allEl, res.accounts, res.account, null);
}

document.getElementById('btn-ads-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-ads-connect');
  const errorEl = document.getElementById('ads-connect-error');
  errorEl.classList.add('hidden');
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    const result = await browser.runtime.sendMessage({ action: 'adsConnect' });
    if (result.error) {
      if (result.error !== 'FLOW_CANCELLED') {
        errorEl.textContent = gscConnectErrorMessage(result.error);
        errorEl.classList.remove('hidden');
      }
    } else {
      await refreshAdsSettingsStatus();
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Connect Google Ads';
  }
});

document.getElementById('btn-ads-disconnect').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ action: 'adsDisconnect' });
  await refreshAdsSettingsStatus();
});

document.getElementById('btn-ads-save-config').addEventListener('click', async () => {
  const adsDeveloperToken = document.getElementById('ads-dev-token').value.trim();
  const adsManagerId = document.getElementById('ads-manager-id').value.trim();
  // Manager / account list depend on these, so drop the cached accounts
  await browser.storage.local.set({ adsDeveloperToken, adsManagerId });
  await browser.storage.local.remove('adsAccounts');
  const saved = document.getElementById('ads-config-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
  refreshAdsAccountInfo();
});

document.getElementById('btn-ads-goto-settings').addEventListener('click', () => showSettings());
document.getElementById('btn-ads-goto-settings-2').addEventListener('click', () => showSettings());
document.getElementById('ads-token-link').addEventListener('click', () => browser.tabs.create({ url: ADS_TOKEN_HELP }));
document.getElementById('ads-token-link-2').addEventListener('click', () => browser.tabs.create({ url: ADS_TOKEN_HELP }));

document.querySelectorAll('#ads-range-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = parseInt(btn.dataset.range, 10);
    if (range === adsSelectedRange) return;
    adsSelectedRange = range;
    setAdsRangeUI(range);
    browser.storage.local.set({ adsSelectedRange: range });
    loadAdsData(false);
  });
});

function loadAdsPrefs() {
  return browser.storage.local.get('adsSelectedRange').then(({ adsSelectedRange: stored }) => {
    adsSelectedRange = stored || 30;
    setAdsRangeUI(adsSelectedRange);
  });
}
