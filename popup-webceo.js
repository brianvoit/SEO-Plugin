// Web CEO rank tracking tab: keyword positions for the current domain's WebCEO
// project, plus the Settings connection (API key + base URL) and per-domain
// project picker. WebCEO is a whitelabel-friendly, API-key (no OAuth) service;
// the data layer lives in background.js (webceo* handlers).

let webceoSelectedDepth = 2;          // history_depth (number of recent scans)
let _webceoHost = null;
let _webceoData = null;               // last webceoGetRankings response
let _webceoOnPageOnly = false;        // filter to keywords ranking for this page

const WEBCEO_ERRORS = {
  NO_API_KEY: 'Add your Web CEO API key in Settings.',
  BAD_KEY: 'Web CEO rejected the API key. Check it in Settings (Agency Unlimited only).',
  RATE_LIMITED: 'Web CEO API rate limit reached. Try again in a moment.',
  NETWORK: 'Network error talking to Web CEO.',
  API_ERROR: 'Web CEO API error.',
  NO_PROJECT: 'No Web CEO project matches this domain.'
};
function webceoErrorMessage(error, detail) {
  const base = WEBCEO_ERRORS[error] || `Web CEO error: ${error}`;
  return detail ? `${base} (${detail})` : base;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function webceoPos(p) { return p == null ? '—' : String(p); }
function webceoVol(v) { return v == null ? '—' : Math.round(v).toLocaleString(); }

// Position change: lower is better, so previous − current (positive = improved)
function webceoChangeEl(current, previous) {
  const el = document.createElement('span');
  el.className = 'ranking-change';
  if (current == null || previous == null) { el.textContent = previous == null && current != null ? 'new' : ''; return el; }
  const delta = previous - current;
  if (delta === 0) { el.textContent = '–'; return el; }
  el.textContent = `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}`;
  el.classList.add(delta > 0 ? 'ranking-change--up' : 'ranking-change--down');
  return el;
}

function webceoMobileChip(mobile) {
  if (!mobile) return null;
  const chip = document.createElement('span');
  chip.className = 'ranking-se-chip';
  chip.textContent = mobile === 2 ? 'tablet' : 'mobile';
  return chip;
}

// ─── Tab: rankings table ─────────────────────────────────────────────────────

function setWebceoDepthUI(depth) {
  document.querySelectorAll('#ranking-depth-group .mode-option').forEach(btn =>
    btn.classList.toggle('is-active', parseInt(btn.dataset.depth, 10) === depth));
}

// Does a ranking URL point at the currently inspected page?
function webceoUrlIsThisPage(url) {
  if (!url) return false;
  try {
    const a = new URL(url);
    const b = new URL(_webceoData && _webceoData.pageUrl || location.href);
    return a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '') &&
      a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch { return false; }
}

const RANKING_GRID = '1fr 70px 44px 44px 56px';

function buildRankingTable(container, rows) {
  container.replaceChildren();
  if (!container._sort) container._sort = { column: 'position', dir: 'asc' };
  const sort = container._sort;

  const cols = [
    { key: 'keyword', label: 'Keyword', term: true },
    { key: 'se', label: 'Engine' },
    { key: 'position', label: 'Pos' },
    { key: 'change', label: 'Δ' },
    { key: 'volume', label: 'Vol' }
  ];

  const render = () => {
    container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'ranking-row ranking-row--header';
    cols.forEach(c => {
      const cell = document.createElement('span');
      cell.className = (c.term ? 'ranking-cell-term' : 'ranking-cell-num') + ' ads-sort';
      const active = sort.column === c.key;
      cell.textContent = c.label + (active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');
      cell.addEventListener('click', () => {
        if (sort.column === c.key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else { sort.column = c.key; sort.dir = c.key === 'keyword' ? 'asc' : (c.key === 'position' ? 'asc' : 'desc'); }
        render();
      });
      header.appendChild(cell);
    });
    container.appendChild(header);

    const visible = rows.filter(r => !_webceoOnPageOnly || webceoUrlIsThisPage(r.url));
    const sorted = visible.slice().sort((a, b) => {
      if (sort.column === 'keyword' || sort.column === 'se') {
        const av = (a[sort.column] || '').toLowerCase(), bv = (b[sort.column] || '').toLowerCase();
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      // numeric: position (null = worst), change (prev-cur), volume
      const val = r => {
        if (sort.column === 'change') return (r.previous != null && r.position != null) ? (r.previous - r.position) : -Infinity;
        const v = r[sort.column];
        if (v == null) return sort.column === 'position' ? Infinity : -Infinity;   // unranked sorts last by position
        return v;
      };
      const av = val(a), bv = val(b);
      return sort.dir === 'asc' ? av - bv : bv - av;
    });

    if (!sorted.length) {
      document.getElementById('ranking-empty').classList.remove('hidden');
      return;
    }
    document.getElementById('ranking-empty').classList.add('hidden');

    sorted.forEach(r => {
      const row = document.createElement('div');
      row.className = 'ranking-row';
      if (webceoUrlIsThisPage(r.url)) row.classList.add('ranking-row--onpage');

      // keyword (opens a Google search) + on-page marker
      const term = document.createElement('span');
      term.className = 'ranking-cell-term';
      const kw = document.createElement('span');
      kw.className = 'ranking-keyword ads-term-link';
      kw.textContent = r.keyword;
      kw.title = `Search Google for “${r.keyword}”` + (r.url ? `\nRanking URL: ${r.url}` : '');
      kw.addEventListener('click', () => browser.tabs.create({ url: `https://www.google.com/search?q=${encodeURIComponent(r.keyword)}` }));
      term.appendChild(kw);
      if (r.starred) { const s = document.createElement('span'); s.className = 'ranking-star'; s.textContent = '★'; term.appendChild(s); }
      row.appendChild(term);

      // engine (+ location title, mobile chip)
      const se = document.createElement('span');
      se.className = 'ranking-cell-num ranking-se';
      se.textContent = r.se || '—';
      if (r.location) se.title = r.location;
      const mc = webceoMobileChip(r.mobile);
      if (mc) se.appendChild(mc);
      row.appendChild(se);

      const pos = document.createElement('span');
      pos.className = 'ranking-cell-num ranking-pos';
      pos.textContent = webceoPos(r.position);
      row.appendChild(pos);

      const change = webceoChangeEl(r.position, r.previous);
      change.classList.add('ranking-cell-num');
      row.appendChild(change);

      const vol = document.createElement('span');
      vol.className = 'ranking-cell-num';
      vol.textContent = webceoVol(r.volume);
      row.appendChild(vol);

      container.appendChild(row);
    });
  };

  render();
}

function renderWebceoPanel(response) {
  const ids = ['ranking-no-key', 'ranking-no-project', 'ranking-error', 'ranking-data'];
  ids.forEach(id => document.getElementById(id).classList.add('hidden'));

  if (!response || !response.connected) {
    document.getElementById('ranking-no-key').classList.remove('hidden');
    return;
  }
  if (response.error === 'NO_PROJECT') {
    if (response.host) _webceoHost = response.host;
    loadWebceoProjectPicker(document.getElementById('ranking-project-picker'));
    document.getElementById('ranking-no-project').classList.remove('hidden');
    return;
  }
  if (response.error) {
    document.getElementById('ranking-error-text').textContent = webceoErrorMessage(response.error, response.detail);
    document.getElementById('ranking-error').classList.remove('hidden');
    return;
  }

  _webceoData = response;
  setWebceoDepthUI(webceoSelectedDepth);
  document.getElementById('ranking-onpage-only').checked = _webceoOnPageOnly;
  document.getElementById('ranking-meta').textContent =
    `${response.projectName || response.domain || ''} · ${(response.rows || []).length} keyword rows · Updated ${gscRelativeTime(response.fetchedAt)}`;
  buildRankingTable(document.getElementById('ranking-table'), response.rows || []);
  document.getElementById('ranking-data').classList.remove('hidden');
}

async function loadWebceoData(forceRefresh = false) {
  const tab = await getActiveTab();
  try { _webceoHost = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { _webceoHost = null; }
  const response = await browser.runtime.sendMessage({ action: 'webceoGetRankings', pageUrl: tab.url, historyDepth: webceoSelectedDepth, forceRefresh });
  if (response) response.pageUrl = tab.url;
  renderWebceoPanel(response);
}

document.querySelectorAll('#ranking-depth-group .mode-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const depth = parseInt(btn.dataset.depth, 10);
    if (depth === webceoSelectedDepth) return;
    webceoSelectedDepth = depth;
    setWebceoDepthUI(depth);
    browser.storage.local.set({ webceoSelectedDepth: depth });
    loadWebceoData(false);
  });
});

document.getElementById('ranking-onpage-only').addEventListener('change', (e) => {
  _webceoOnPageOnly = e.target.checked;
  if (_webceoData) buildRankingTable(document.getElementById('ranking-table'), _webceoData.rows || []);
});

document.getElementById('btn-ranking-goto-settings').addEventListener('click', () => showSettings());

// ─── Project picker (per-domain, mirrors the GA/Ads pickers) ─────────────────

function renderWebceoProjectOptions(container, projects, selected, onSelect) {
  container.replaceChildren();

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'ga-property-search';
  search.placeholder = 'Search projects…';
  search.autocomplete = 'off';
  search.spellcheck = false;
  container.appendChild(search);

  projects
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
    .forEach(p => {
      const opt = document.createElement('button');
      opt.className = 'gsc-property-option' + (p.project === selected ? ' gsc-property-option--active' : '');
      opt.dataset.search = `${p.name} ${p.domain}`.toLowerCase();
      const radio = document.createElement('span');
      radio.className = 'gsc-property-radio';
      const text = document.createElement('span');
      text.className = 'gsc-property-option-text';
      text.textContent = p.name;
      opt.append(radio, text);
      const idEl = document.createElement('span');
      idEl.className = 'gsc-property-id';
      idEl.textContent = p.domain;
      opt.appendChild(idEl);
      opt.addEventListener('click', async () => {
        container.querySelectorAll('.gsc-property-option').forEach(el =>
          el.classList.toggle('gsc-property-option--active', el === opt));
        await browser.runtime.sendMessage({ action: 'webceoSetProject', host: _webceoHost, project: p.project });
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

// Used by the tab's no-project state: pick a project, then reload the tab
async function loadWebceoProjectPicker(container) {
  container.replaceChildren();
  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'webceoResolveProject', pageUrl: tab.url });
  if (!res || !res.connected || res.error || !res.projects || !res.projects.length) return;
  _webceoHost = res.host;
  renderWebceoProjectOptions(container, res.projects, res.project, () => loadWebceoData(true));
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function refreshWebceoSettingsStatus() {
  const status = await browser.runtime.sendMessage({ action: 'webceoGetStatus' });
  const badge = document.getElementById('webceo-status-badge');
  const box = document.getElementById('webceo-project-box');

  document.getElementById('webceo-base-url').value = status.baseUrl || '';
  if (status.connected) {
    badge.textContent = 'Connected';
    badge.className = 'gsc-status-badge gsc-status-badge--connected';
    setWebceoKeyState(true);
    box.classList.remove('hidden');
    refreshWebceoProjectInfo();
  } else {
    badge.textContent = 'Not connected';
    badge.className = 'gsc-status-badge gsc-status-badge--disconnected';
    setWebceoKeyState(false);
    box.classList.add('hidden');
  }
  return status;
}

async function refreshWebceoProjectInfo() {
  const matchEl = document.getElementById('webceo-project-match');
  const allEl = document.getElementById('webceo-project-all');
  matchEl.className = 'gsc-property-match hidden';
  allEl.replaceChildren();

  const tab = await getActiveTab();
  const res = await browser.runtime.sendMessage({ action: 'webceoResolveProject', pageUrl: tab.url });
  if (!res || !res.connected) return;
  if (res.error) {
    matchEl.textContent = webceoErrorMessage(res.error, res.detail);
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  _webceoHost = res.host;
  if (!res.projects.length) {
    matchEl.textContent = 'No projects on this Web CEO account';
    matchEl.className = 'gsc-property-match gsc-property-match--none';
    return;
  }
  const sel = res.project && res.projects.find(p => p.project === res.project);
  if (sel) {
    renderSelectedRow(allEl, sel.name,
      async () => {
        await browser.runtime.sendMessage({ action: 'webceoSetProject', host: _webceoHost, project: null });
        renderWebceoProjectOptions(allEl, res.projects, null, () => refreshWebceoProjectInfo());
      }, sel.domain);
    return;
  }
  renderWebceoProjectOptions(allEl, res.projects, res.project, () => refreshWebceoProjectInfo());
}

// API-key field: masked once stored, editable + reveal eye when empty
function setWebceoKeyState(hasKey) {
  const input = document.getElementById('webceo-api-key');
  document.getElementById('btn-webceo-key-vis').classList.toggle('hidden', hasKey);
  document.getElementById('btn-webceo-key-clear').classList.toggle('hidden', !hasKey);
  input.type = 'password';
  input.value = '';
  input.readOnly = hasKey;
  input.placeholder = hasKey ? '••••••••••••' : 'Web CEO API key';
  document.getElementById('webceo-eye-open').classList.remove('hidden');
  document.getElementById('webceo-eye-closed').classList.add('hidden');
}

document.getElementById('btn-webceo-key-vis').addEventListener('click', () => {
  const input = document.getElementById('webceo-api-key');
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  document.getElementById('webceo-eye-open').classList.toggle('hidden', isHidden);
  document.getElementById('webceo-eye-closed').classList.toggle('hidden', !isHidden);
});

document.getElementById('btn-webceo-key-clear').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ action: 'webceoDisconnect' });
  setWebceoKeyState(false);
  refreshWebceoSettingsStatus();
});

// The "Connected" chip doubles as the disconnect control
document.getElementById('webceo-status-badge').addEventListener('click', async (e) => {
  if (!e.currentTarget.classList.contains('gsc-status-badge--connected')) return;
  await browser.runtime.sendMessage({ action: 'webceoDisconnect' });
  setWebceoKeyState(false);
  await refreshWebceoSettingsStatus();
});

document.getElementById('btn-webceo-save-config').addEventListener('click', async () => {
  const keyInput = document.getElementById('webceo-api-key');
  const baseUrl = document.getElementById('webceo-base-url').value.trim();
  const update = { baseUrl };
  if (!keyInput.readOnly) update.apiKey = keyInput.value.trim();
  await browser.runtime.sendMessage({ action: 'webceoSaveConfig', ...update });
  if (!keyInput.readOnly && update.apiKey) setWebceoKeyState(true);
  refreshWebceoSettingsStatus();
});

function loadWebceoPrefs() {
  return browser.storage.local.get(['webceoSelectedDepth']).then(({ webceoSelectedDepth: stored }) => {
    webceoSelectedDepth = stored || 2;
    setWebceoDepthUI(webceoSelectedDepth);
  });
}
