// UTM Generator (Overview → detail panel). Builds UTM-tagged campaign URLs,
// keeps the source/medium spellings that land traffic in the right GA4
// default channel, remembers everything generated per-domain (synced), and
// offers autofill from both prior values and the source/medium/campaign
// values GA4 has already recorded for the page.

// ─── GA4 default channel grouping (pragmatic subset) ─────────────────────────
// Matching is case-insensitive; we lowercase everything first.
const UTM_PAID_MEDIUM_RE = /^(.*cp.*|ppc|retargeting|paid.*)$/;
const UTM_SOCIAL_MEDIUM_RE = /^(social|social-network|social-media|sm|social network|social media)$/;
const UTM_EMAIL_RE = /e[-_ ]?mail/;
const UTM_SEARCH_SOURCES = new Set(['google', 'bing', 'yahoo', 'duckduckgo', 'ecosia', 'baidu', 'yandex', 'ask', 'aol']);
const UTM_SOCIAL_SOURCES = new Set([
  'facebook', 'facebook.com', 'm.facebook.com', 'l.facebook.com', 'lm.facebook.com',
  'linkedin', 'linkedin.com', 'lnkd.in',
  'instagram', 'instagram.com', 'x.com', 'twitter', 'twitter.com', 't.co',
  'youtube', 'youtube.com', 'pinterest', 'pinterest.com',
  'tiktok', 'tiktok.com', 'reddit', 'reddit.com'
]);

function utmNormSource(s) { return String(s || '').trim().toLowerCase().replace(/^www\./, ''); }
function utmIsSearch(s) { return UTM_SEARCH_SOURCES.has(utmNormSource(s)); }
function utmIsSocial(s) { return UTM_SOCIAL_SOURCES.has(utmNormSource(s)); }

// → { channel, level }. level: 'ok' recognized channel · 'warn' referral/other
// · 'err' unassigned (likely a tagging mistake) · 'none' nothing entered yet.
function utmClassifyChannel(source, medium) {
  const src = utmNormSource(source);
  const med = String(medium || '').trim().toLowerCase();
  if (!src && !med) return { channel: 'Enter a source & medium', level: 'none' };
  if (src === '(direct)' && (med === '(none)' || med === '(not set)' || !med)) return { channel: 'Direct', level: 'ok' };
  if (UTM_EMAIL_RE.test(med) || UTM_EMAIL_RE.test(src)) return { channel: 'Email', level: 'ok' };
  const paid = UTM_PAID_MEDIUM_RE.test(med);
  if (paid && utmIsSearch(src)) return { channel: 'Paid Search', level: 'ok' };
  if (paid && utmIsSocial(src)) return { channel: 'Paid Social', level: 'ok' };
  if (UTM_SOCIAL_MEDIUM_RE.test(med) || (utmIsSocial(src) && med && !paid)) return { channel: 'Organic Social', level: 'ok' };
  if (utmIsSearch(src) && med === 'organic') return { channel: 'Organic Search', level: 'ok' };
  if (med === 'affiliate' || med === 'affiliates') return { channel: 'Affiliates', level: 'ok' };
  if (med === 'referral' || med === 'link') return { channel: 'Referral', level: 'warn' };
  if (med === 'video' || med === 'display' || med === 'banner') return { channel: med === 'video' ? 'Organic Video' : 'Display', level: 'ok' };
  if (paid) return { channel: 'Paid Other', level: 'ok' };
  return { channel: 'Unassigned — check source/medium', level: 'err' };
}

// Presets fill the source/medium that lands in the intended GA4 channel.
// `organic` (where present) is the alternate medium for the unpaid variant.
const UTM_PRESETS = [
  { key: 'ads',      label: 'Google Ads', source: 'google',       medium: 'cpc' },
  { key: 'linkedin', label: 'LinkedIn',   source: 'linkedin.com', medium: 'cpc', organic: 'social' },
  { key: 'facebook', label: 'Facebook',   source: 'facebook.com', medium: 'cpc', organic: 'social' },
  { key: 'email',    label: 'Email',      source: 'newsletter',   medium: 'email' }
];

// Help text + required/optional status per Google's own definitions (Analytics
// Help "URL builders: Collect campaign data with custom URLs" —
// support.google.com/analytics/answer/10917952 — and the ga-dev-tools
// Campaign URL Builder's "More information and examples" copy).
const UTM_FIELDS = [
  { key: 'source', label: 'Source', param: 'utm_source', ga: 'sources', placeholder: 'google', required: true,
    help: 'Identify the advertiser, site, publication, etc. generating traffic to your property, e.g. google, newsletter4, billboard.' },
  { key: 'medium', label: 'Medium', param: 'utm_medium', ga: 'mediums', placeholder: 'cpc', required: true,
    help: 'The advertising or marketing medium, e.g. cpc, banner, email.' },
  { key: 'campaign', label: 'Campaign', param: 'utm_campaign', ga: 'campaigns', placeholder: 'spring_sale', required: true,
    help: 'The individual campaign name, slogan, promo code, etc. for a product, e.g. spring_sale.' },
  { key: 'term', label: 'Term', param: 'utm_term', ga: null, placeholder: '(paid keyword)', required: false,
    help: 'Identify paid search keywords. If you’re manually tagging paid keyword campaigns, use utm_term to specify the keyword.' },
  { key: 'content', label: 'Content', param: 'utm_content', ga: null, placeholder: '(A/B variant)', required: false,
    help: 'Used to differentiate similar content, or links within the same ad — e.g. two call-to-action links in the same email, tagged with different utm_content values so you can tell which one performed better.' }
];

// Bottom-of-panel links, mirroring the "Related Resources" section on
// ga-dev-tools.google/campaign-url-builder.
const UTM_RELATED_RESOURCES = [
  { label: 'About Custom Campaigns', url: 'https://support.google.com/analytics/answer/10917952' },
  { label: 'Best Practices for creating Custom Campaigns', url: 'https://support.google.com/analytics/answer/1037445' },
  { label: 'About the Referral Traffic report', url: 'https://support.google.com/analytics/answer/11242841' },
  { label: 'About traffic source dimensions', url: 'https://support.google.com/analytics/answer/1033173' },
  { label: 'Google Ads Auto-Tagging', url: 'https://support.google.com/google-ads/answer/3095550' }
];

// ─── State + per-domain (synced) store ───────────────────────────────────────
const UTM_HISTORY_CAP = 50;    // saved URLs kept per host
const UTM_HOST_CAP = 100;      // hosts kept in the store

let _utmStore = null;                 // { [host]: { history: [ {url,source,medium,campaign,term,content,createdAt} ] } }
let _utmHost = '';
let _utmPageUrl = '';
let _utmOrganic = false;              // organic toggle state (paid ↔ organic presets)
let _utmGaValues = { sources: [], mediums: [], campaigns: [] };
let _utmGaHost = '';                  // host the GA values were fetched for
let _utmGaLoading = false;
let _utm = { base: '', source: '', medium: '', campaign: '', term: '', content: '' };

function utmSyncArea() {
  return (typeof browser !== 'undefined' && browser.storage && browser.storage.sync) ? browser.storage.sync : null;
}

async function loadUtmStore() {
  const sync = utmSyncArea();
  if (sync) {
    let s;
    try { s = (await sync.get('utmStore')).utmStore; } catch { s = undefined; }
    if (s && Object.keys(s).length) { _utmStore = s; return _utmStore; }
  }
  let local;
  try { local = (await browser.storage.local.get('utmStore')).utmStore; } catch { local = undefined; }
  _utmStore = local || {};
  if (sync && local && Object.keys(local).length) {
    try { await sync.set({ utmStore: _utmStore }); } catch { /* stay local */ }
  }
  return _utmStore;
}

async function saveUtmStore() {
  // Prune to caps before persisting (oldest hosts / oldest history first).
  const hosts = Object.keys(_utmStore);
  if (hosts.length > UTM_HOST_CAP) {
    hosts
      .map(h => ({ h, at: Math.max(0, ...(_utmStore[h].history || []).map(e => e.createdAt || 0)) }))
      .sort((a, b) => a.at - b.at)
      .slice(0, hosts.length - UTM_HOST_CAP)
      .forEach(({ h }) => delete _utmStore[h]);
  }
  const sync = utmSyncArea();
  if (sync) {
    try { await sync.set({ utmStore: _utmStore }); return; }
    catch { /* fall through to local */ }
  }
  await browser.storage.local.set({ utmStore: _utmStore });
}

function utmHistory() { return (_utmStore && _utmStore[_utmHost] && _utmStore[_utmHost].history) || []; }

// Distinct prior values for a field, most-recent first.
function utmPriorValues(fieldKey) {
  const seen = new Set();
  const out = [];
  utmHistory().forEach(e => {
    const v = (e[fieldKey] || '').trim();
    const lc = v.toLowerCase();
    if (!v || seen.has(lc)) return;
    seen.add(lc);
    out.push(v);
  });
  return out;
}

// ─── Open + render ───────────────────────────────────────────────────────────
async function openUtmPanel() {
  let tab;
  try { tab = await getActiveTab(); } catch { tab = null; }
  _utmPageUrl = (tab && tab.url) || '';
  try { _utmHost = new URL(_utmPageUrl).hostname.replace(/^www\./, ''); } catch { _utmHost = ''; }

  await loadUtmStore();

  // Prefill from the most-recent saved entry for this host; base = current page.
  const last = utmHistory()[0] || {};
  _utm = {
    base: _utmPageUrl,
    source: last.source || '',
    medium: last.medium || '',
    campaign: last.campaign || '',
    term: last.term || '',
    content: last.content || ''
  };
  _utmOrganic = false;

  renderUtmPanel();

  // GA-detected values load lazily, then refresh the chips/datalists once.
  if (_utmGaHost !== _utmHost) { _utmGaValues = { sources: [], mediums: [], campaigns: [] }; }
  ensureUtmGaValues();
}

function ensureUtmGaValues() {
  if (_utmGaLoading || !_utmPageUrl) return;
  if (_utmGaHost === _utmHost && (_utmGaValues.sources.length || _utmGaValues.mediums.length || _utmGaValues.campaigns.length)) return;
  _utmGaLoading = true;
  sendMessageWithTimeout({ action: 'gaGetPageUtmValues', pageUrl: _utmPageUrl })
    .then(res => {
      _utmGaHost = _utmHost;
      if (res && res.connected && !res.error) {
        _utmGaValues = { sources: res.sources || [], mediums: res.mediums || [], campaigns: res.campaigns || [] };
      } else {
        _utmGaValues = { sources: [], mediums: [], campaigns: [] };
      }
    })
    .catch(() => { _utmGaValues = { sources: [], mediums: [], campaigns: [] }; })
    .finally(() => {
      _utmGaLoading = false;
      // Only refresh if the panel is still open.
      if (document.getElementById('utm-source')) { refreshUtmAutofill(); }
    });
}

function utmBuildUrl() {
  const base = (_utm.base || '').trim();
  if (!base) return '';
  let url;
  try { url = new URL(base); } catch { return base; }
  UTM_FIELDS.forEach(f => {
    const v = (_utm[f.key] || '').trim();
    if (v) url.searchParams.set(f.param, v);
    else url.searchParams.delete(f.param);
  });
  return url.toString();
}

function renderUtmPanel() {
  const el = document.getElementById('utm-content');
  if (!el) return;
  el.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'utm-wrap';

  // Presets
  const presetSec = document.createElement('div');
  presetSec.className = 'utm-presets';
  UTM_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'utm-preset-btn';
    b.textContent = p.label;
    b.addEventListener('click', () => applyUtmPreset(p));
    presetSec.appendChild(b);
  });
  // Organic toggle
  const orgLabel = document.createElement('label');
  orgLabel.className = 'utm-organic-toggle';
  orgLabel.title = 'Use the unpaid medium (medium=social) for the next social preset';
  const orgCb = document.createElement('input');
  orgCb.type = 'checkbox';
  orgCb.checked = _utmOrganic;
  orgCb.addEventListener('change', () => { _utmOrganic = orgCb.checked; });
  const orgSpan = document.createElement('span');
  orgSpan.textContent = 'Organic';
  orgLabel.append(orgCb, orgSpan);
  presetSec.appendChild(orgLabel);
  wrap.appendChild(presetSec);

  // Base URL field
  wrap.appendChild(utmField({ key: 'base', label: 'Base URL', param: '', ga: null, placeholder: 'https://example.com/page' }, true));

  // UTM parameter fields
  UTM_FIELDS.forEach(f => wrap.appendChild(utmField(f, false)));

  // Generated URL + actions
  const outSec = document.createElement('div');
  outSec.className = 'utm-output';
  const outLabel = document.createElement('div');
  outLabel.className = 'field-label';
  outLabel.textContent = 'GENERATED URL';
  const out = document.createElement('div');
  out.className = 'utm-url';
  out.id = 'utm-url';
  const actions = document.createElement('div');
  actions.className = 'utm-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'utm-btn utm-btn--primary utm-btn--icon';
  copyBtn.id = 'utm-copy';
  copyBtn.title = 'Copy generated URL';
  copyBtn.appendChild(svgFromString('<svg class="icon-copy" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="9" height="11" rx="1.5"/><path d="M3 12H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1"/></svg>'));
  copyBtn.appendChild(svgFromString('<svg class="icon-check hidden" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 8 6 12 14 4"/></svg>'));
  copyBtn.addEventListener('click', () => utmCopy(copyBtn));
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'utm-btn';
  saveBtn.id = 'utm-save';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => utmSave(saveBtn));
  actions.append(copyBtn, saveBtn);
  outSec.append(outLabel, out, actions);
  wrap.appendChild(outSec);

  // History
  const histSec = document.createElement('div');
  histSec.className = 'utm-history';
  histSec.id = 'utm-history';
  wrap.appendChild(histSec);

  // Related Resources
  const relSec = document.createElement('div');
  relSec.className = 'utm-related';
  const relLabel = document.createElement('div');
  relLabel.className = 'field-label';
  relLabel.textContent = 'RELATED RESOURCES';
  relSec.appendChild(relLabel);
  UTM_RELATED_RESOURCES.forEach(r => {
    const a = document.createElement('a');
    a.className = 'utm-related-link';
    a.textContent = r.label;
    a.href = '#';
    a.addEventListener('click', e => { e.preventDefault(); browser.tabs.create({ url: r.url }); });
    relSec.appendChild(a);
  });
  wrap.appendChild(relSec);

  el.appendChild(wrap);

  refreshUtmAutofill();
  refreshUtmDerived();
  renderUtmHistory();
}

// One labeled field: input (+ datalist), an inline channel chip on the far
// right for the medium row, a "More information and examples" help line, and
// (for GA-backed fields) a row of autofill chips.
function utmField(f, isBase) {
  const row = document.createElement('div');
  row.className = 'utm-field';

  const label = document.createElement('label');
  label.className = 'utm-field-label';
  label.textContent = f.label + (!isBase && f.required === false ? ' (Optional)' : '');
  label.htmlFor = `utm-${f.key}`;
  row.appendChild(label);

  const inputRow = document.createElement('div');
  inputRow.className = 'utm-input-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'utm-input';
  input.id = `utm-${f.key}`;
  input.placeholder = f.placeholder || '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = _utm[f.key] || '';
  if (!isBase) { input.setAttribute('list', `utm-dl-${f.key}`); }
  input.addEventListener('input', () => {
    _utm[f.key] = input.value;
    refreshUtmDerived();
    if (f.key === 'source' || f.key === 'medium') updateUtmChannelChip();
  });
  inputRow.appendChild(input);

  if (!isBase) {
    const dl = document.createElement('datalist');
    dl.id = `utm-dl-${f.key}`;
    inputRow.appendChild(dl);
  }

  // Channel chip sits inline, far right of the medium row (CSS: margin-left:auto).
  if (f.key === 'medium') {
    const chip = document.createElement('span');
    chip.className = 'utm-channel-chip';
    chip.id = 'utm-channel-chip';
    inputRow.appendChild(chip);
  }

  row.appendChild(inputRow);

  if (!isBase && f.help) {
    const help = document.createElement('div');
    help.className = 'utm-field-help';
    help.textContent = f.help;
    row.appendChild(help);
  }

  // Autofill chip row (prior + GA-detected) for source/medium/campaign.
  if (!isBase && f.ga) {
    const chips = document.createElement('div');
    chips.className = 'utm-autofill';
    chips.id = `utm-af-${f.key}`;
    row.appendChild(chips);
  }

  return row;
}

// Populate datalists + autofill chips from prior history and GA-detected values.
function refreshUtmAutofill() {
  UTM_FIELDS.forEach(f => {
    const prior = utmPriorValues(f.key);
    const ga = (f.ga && _utmGaValues[f.ga]) ? _utmGaValues[f.ga] : [];
    const merged = [];
    const seen = new Set();
    [...prior, ...ga].forEach(v => { const lc = v.toLowerCase(); if (!seen.has(lc)) { seen.add(lc); merged.push(v); } });

    const dl = document.getElementById(`utm-dl-${f.key}`);
    if (dl) {
      dl.replaceChildren();
      merged.forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
    }

    const chipsEl = document.getElementById(`utm-af-${f.key}`);
    if (chipsEl) {
      chipsEl.replaceChildren();
      const gaSet = new Set(ga.map(v => v.toLowerCase()));
      merged.slice(0, 8).forEach(v => {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'utm-af-chip' + (gaSet.has(v.toLowerCase()) ? ' utm-af-chip--ga' : '');
        c.textContent = v;
        if (gaSet.has(v.toLowerCase())) c.title = 'Seen in GA4 for this page';
        c.addEventListener('click', () => {
          _utm[f.key] = v;
          const inp = document.getElementById(`utm-${f.key}`);
          if (inp) inp.value = v;
          refreshUtmDerived();
          updateUtmChannelChip();
        });
        chipsEl.appendChild(c);
      });
    }
  });
  updateUtmChannelChip();
}

function refreshUtmDerived() {
  const out = document.getElementById('utm-url');
  if (out) out.textContent = utmBuildUrl() || '—';
}

function updateUtmChannelChip() {
  const chip = document.getElementById('utm-channel-chip');
  if (!chip) return;
  const { channel, level } = utmClassifyChannel(_utm.source, _utm.medium);
  chip.className = 'utm-channel-chip hl-chip'
    + (level === 'ok' ? ' hl-chip--ok' : level === 'warn' ? ' hl-chip--warn' : level === 'err' ? ' hl-chip--err' : ' hl-chip--pending');
  chip.textContent = level === 'none' ? channel : `→ ${channel}`;
}

function applyUtmPreset(p) {
  _utm.source = p.source;
  _utm.medium = (_utmOrganic && p.organic) ? p.organic : p.medium;
  const s = document.getElementById('utm-source');
  const m = document.getElementById('utm-medium');
  if (s) s.value = _utm.source;
  if (m) m.value = _utm.medium;
  refreshUtmDerived();
  updateUtmChannelChip();
}

async function utmCopy(btn) {
  const url = utmBuildUrl();
  if (!url) { btn.title = 'Enter a URL first'; setTimeout(() => { btn.title = 'Copy generated URL'; }, 1500); return; }
  await copyToClipboard(url);
  flashCopyBtn(btn);
}

async function utmSave(btn) {
  const url = utmBuildUrl();
  if (!url || !_utmHost) { btn.textContent = 'Enter a URL'; setTimeout(() => { btn.textContent = 'Save'; }, 1500); return; }
  if (!_utmStore[_utmHost]) _utmStore[_utmHost] = { history: [] };
  const hist = _utmStore[_utmHost].history;
  const entry = {
    url, source: _utm.source.trim(), medium: _utm.medium.trim(), campaign: _utm.campaign.trim(),
    term: _utm.term.trim(), content: _utm.content.trim(), createdAt: Date.now()
  };
  // De-dupe an identical URL to the front rather than stacking duplicates.
  const existingIdx = hist.findIndex(e => e.url === url);
  if (existingIdx !== -1) hist.splice(existingIdx, 1);
  hist.unshift(entry);
  if (hist.length > UTM_HISTORY_CAP) hist.length = UTM_HISTORY_CAP;
  await saveUtmStore();
  btn.textContent = 'Saved ✓';
  btn.classList.add('is-success');
  setTimeout(() => { btn.textContent = 'Save'; btn.classList.remove('is-success'); }, 1600);
  refreshUtmAutofill();
  renderUtmHistory();
}

function renderUtmHistory() {
  const el = document.getElementById('utm-history');
  if (!el) return;
  el.replaceChildren();
  const hist = utmHistory();
  if (!hist.length) return;

  const header = document.createElement('div');
  header.className = 'field-label';
  header.textContent = `SAVED FOR ${_utmHost.toUpperCase()}`;
  el.appendChild(header);

  hist.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'utm-hist-row';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'utm-hist-main';
    main.title = 'Load these values into the form';
    const lbl = document.createElement('span');
    lbl.className = 'utm-hist-label';
    lbl.textContent = [e.campaign, e.medium, e.source].filter(Boolean).join(' · ') || e.url;
    const sub = document.createElement('span');
    sub.className = 'utm-hist-url';
    sub.textContent = e.url;
    main.append(lbl, sub);
    main.addEventListener('click', () => utmLoadEntry(e));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'utm-hist-icon';
    copyBtn.title = 'Copy URL';
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await copyToClipboard(e.url);
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'utm-hist-icon utm-hist-icon--del';
    delBtn.title = 'Delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      utmHistory().splice(i, 1);
      await saveUtmStore();
      refreshUtmAutofill();
      renderUtmHistory();
    });

    row.append(main, copyBtn, delBtn);
    el.appendChild(row);
  });
}

function utmLoadEntry(e) {
  _utm.source = e.source || '';
  _utm.medium = e.medium || '';
  _utm.campaign = e.campaign || '';
  _utm.term = e.term || '';
  _utm.content = e.content || '';
  ['source', 'medium', 'campaign', 'term', 'content'].forEach(k => {
    const inp = document.getElementById(`utm-${k}`);
    if (inp) inp.value = _utm[k];
  });
  refreshUtmDerived();
  updateUtmChannelChip();
}
